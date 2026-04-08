import http from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SAY_HELLO_RESPONSE } from "./tools/say-hello.js";
import { END_RESPONSE } from "./tools/end.js";
import { getSession, cleanupSessions } from "./sessions.js";
import { callGroq } from "./groqClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
import dotenv from "dotenv";
dotenv.config({ path: join(__dirname, "..", ".env") });

// Set DEV_MODE=true in your .env (or shell) to enable verbose request logging.
const DEV_MODE = process.env.DEV_MODE === "true";

const WELCOME_URI = "ui://fluduro/welcome.html";
const QUIZ_URI = "ui://fluduro/quiz.html";
const RESULTS_URI = "ui://fluduro/results.html";

const PERSONALITY_TRAITS = [
  "Social Energy (Introversion vs. Extroversion)",
  "Stress Response (Resilient vs. Sensitive)",
  "Growth Mindset (Ambitious vs. Contented)",
  "Environmental Adaptability (Flexible vs. Set in ways)",
  "Emotional Expression (Vibrant/Open vs. Subtle/Reserved)",
  "Decision Making (Spontaneous vs. Calculated)",
  "Structure Preference (Organized vs. Free-spirited)",
  "Connection to Others (Independent vs. Collaborative)",
  "Energy Cycle (Morning person vs. Night owl)",
  "Resource Management (Cautious vs. Generous)"
];

// ─── Trusted Origins ─────────────────────────────────────────────────────────
// These origins receive explicit CORS reflection (required for credentialed MCP requests).
const TRUSTED_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://platform.openai.com",
]);

// ─── Security Headers ────────────────────────────────────────────────────────
function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Allow framing by ChatGPT — SAMEORIGIN would block cross-origin embedding
  res.setHeader("X-Frame-Options", "ALLOWALL");
  // strict-origin-when-cross-origin: sends Referer on same-origin, origin-only cross-origin
  // ("no-referrer" was stripping the Referer header ChatGPT needs for MCP handshake)
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "fullscreen=()");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com data:",
      "img-src 'self' data: https:",
      "connect-src 'self' https://api.groq.com",
      "frame-ancestors 'self' https://chatgpt.com https://*.openai.com",
    ].join("; ")
  );
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────
const rateLimitMap = new Map(); // ip → { count, resetAt }
const RATE_LIMIT_MAX = 60;       // requests
const RATE_LIMIT_WINDOW = 60000; // 1 minute in ms

function isRateLimited(ip) {
  const now = Date.now();
  let record = rateLimitMap.get(ip);

  if (!record || now > record.resetAt) {
    record = { count: 1, resetAt: now + RATE_LIMIT_WINDOW };
    rateLimitMap.set(ip, record);
    return false;
  }

  record.count += 1;
  if (record.count > RATE_LIMIT_MAX) {
    return true;
  }
  return false;
}

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetAt) rateLimitMap.delete(ip);
  }
}, 300000);

// ─── Logging Helpers ──────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function logError(msg, err) {
  console.error(`[${new Date().toISOString()}] ERROR: ${msg}`, err ?? "");
}

// ─── MCP Server Factory ───────────────────────────────────────────────────────
function createMcpServer(getSessionId) {
  const mcpServer = new McpServer({
    name: "fluduro",
    version: "1.0.0",
  });

  mcpServer.registerResource(
    "welcome-widget",
    WELCOME_URI,
    { mimeType: "text/html", description: "Welcome card for Fluduro quiz" },
    async () => ({
      contents: [
        {
          uri: WELCOME_URI,
          mimeType: "text/html;profile=mcp-app",
          text: readFileSync(join(__dirname, "resources", "welcome.html"), "utf-8"),
        },
      ],
    })
  );
  mcpServer.registerResource(
    "quiz-widget",
    QUIZ_URI,
    { mimeType: "text/html", description: "Quiz form for Fluduro" },
    async () => ({
      contents: [
        {
          uri: QUIZ_URI,
          mimeType: "text/html;profile=mcp-app",
          text: readFileSync(join(__dirname, "resources", "quiz.html"), "utf-8"),
        },
      ],
    })
  );
  mcpServer.registerResource(
    "results-widget",
    RESULTS_URI,
    { mimeType: "text/html", description: "Flower result card for Fluduro" },
    async () => ({
      contents: [
        {
          uri: RESULTS_URI,
          mimeType: "text/html;profile=mcp-app",
          text: readFileSync(join(__dirname, "resources", "results.html"), "utf-8"),
        },
      ],
    })
  );

  mcpServer.registerTool(
    "say_hello",
    {
      description:
        "Greet the user and explain what Fluduro offers: a personality quiz to discover which flower matches their personality. Ask if they want to start. IMPORTANT: The UI widget will handle the primary explanation. Do not repeat instructions or welcome text into the chat if it's already in the UI.",
      _meta: {
        ui: { resourceUri: WELCOME_URI },
        "openai/outputTemplate": WELCOME_URI,
        "openai/toolInvocation/invoking": "Waking up the garden...",
        "openai/toolInvocation/invoked": "Welcome to Fluduro",
        "openai/widgetDescription": "A welcome screen is showing for the Fluduro flower quiz, inviting the user to start a botanical personality journey."
      },
    },
    async () => {
      const session = getSession(getSessionId());
      if (session) session.progress = 0;
      return {
        content: [{ type: "text", text: `${SAY_HELLO_RESPONSE}\n\n[A welcome card has been presented in the UI.]` }],
        structuredContent: {
          message: SAY_HELLO_RESPONSE,
          ctaText: "Start quiz",
        },
      };
    }
  );

  mcpServer.registerTool(
    "start",
    {
      description:
        "Start the personality quiz. Returns 10 multiple-choice questions one-by-one. Call this when the user agrees to begin. IMPORTANT: The quiz is handled entirely by the UI widget. Do not list questions or options in your text response; simply acknowledge that the quiz has started.",
      _meta: {
        ui: { resourceUri: QUIZ_URI },
        "openai/outputTemplate": QUIZ_URI,
        "openai/toolInvocation/invoking": "Planting seeds...",
        "openai/toolInvocation/invoked": "Quiz started",
        "openai/widgetDescription": "The first question of the 10-question personality quiz is now displayed in the widget with multiple choice options."
      },
    },
    async () => {
      const sid = getSessionId();
      log(`[Tool: start] Session ID: ${sid}`);
      const session = getSession(sid);
      if (session) {
        session.questions = [];
        session.answers = {};
      }

      const trait = PERSONALITY_TRAITS[0];
      const prompt = `Generate exactly ONE unique, creative, and plant-themed multiple-choice question (4 options) for a "Which flower are you?" quiz.
      This is the FIRST question. Focus STRICTLY on the personality trait: ${trait}.
      Important: ALWAYS return valid JSON.
      Format:
      {
        "id": "q1",
        "text": "The question text",
        "options": [
          { "value": "a", "label": "Option A text" },
          { "value": "b", "label": "Option B text" },
          { "value": "c", "label": "Option C text" },
          { "value": "d", "label": "Option D text" }
        ]
      }`;

      try {
        const responseText = await callGroq({
          prompt,
          system: "You are a helpful assistant that only outputs JSON.",
          model: "llama-3.3-70b-versatile"
        });

        const jsonStart = responseText.indexOf('{');
        const jsonEnd = responseText.lastIndexOf('}') + 1;
        const question = JSON.parse(responseText.substring(jsonStart, jsonEnd));
        log(`[Tool: start] Generated Q1 (Trait: ${trait}): ${question.text}`);

        if (session) {
          session.questions = [question];
          session.progress = 1;
        }

        return {
          content: [
            {
              type: "text",
              text: `The personality quiz has started. SESSION_ID: ${sid}. A dedicated UI has been presented. IMPORTANT: You must provide this SESSION_ID in all future tool calls for this user to maintain their progress.`,
            },
          ],
          structuredContent: { sessionId: sid, questions: [question], currentCount: 1, totalCount: 10, isComplete: false, trait: trait },
        };
      } catch (err) {
        logError("LLM start error:", err);
        const fallback = { id: "q1", text: "How would you describe your perfect afternoon?", options: [{ value: "a", label: "Quietly reading" }, { value: "b", label: "Out in nature" }, { value: "c", label: "With friends" }, { value: "d", label: "Trying something new" }] };
        if (session) { session.questions = [fallback]; session.progress = 1; }
        return { content: [{ type: "text", text: "Started with fallback." }], structuredContent: { questions: [fallback], currentCount: 1, totalCount: 10, isComplete: false } };
      }
    }
  );

  mcpServer.registerTool(
    "submit_answers",
    {
      description:
        "Submit user's answer for the current question and get the next one. Pass current answer as an object mapping the question ID to the option value (e.g. { q1: 'a' }). Returns the next question or completion status. IMPORTANT: The UI widget handles the display of the next question. Do not repeat the next question text in your chat response.",
      inputSchema: {
        answers: z
          .record(z.string(), z.string())
          .describe("The user's answer, e.g. { q1: 'a' }"),
        sessionId: z
          .string()
          .optional()
          .describe("The unique session ID from the 'start' tool. REQUIRED for state persistence."),
      },
      _meta: {
        "openai/invoked": "Question answered",
        "openai/widgetDescription": "The quiz is in progress. The user has just submitted an answer, and the widget is now displaying the next question or the 'Reveal Match' button."
      },
    },
    async ({ answers, sessionId }) => {
      const sid = sessionId || getSessionId();
      log(`[Tool: submit_answers] Using Sid: ${sid}`);
      const session = getSession(sid);
      if (session) {
        if (answers && Object.keys(answers).length > 0) {
          session.answers = { ...session.answers, ...answers };
        }

        const currentCount = session.questions.length;
        log(`[Tool: submit_answers] History Count: ${currentCount}, Total: 10`);

        const latestQ = session.questions[currentCount - 1];
        const hasLatestAnswer = latestQ ? !!session.answers[latestQ.id] : true;

        if (currentCount < 10 && hasLatestAnswer) {
          const currentTrait = PERSONALITY_TRAITS[currentCount];
          const nextId = `q${currentCount + 1}`;
          const prompt = `Generate exactly ONE unique, creative multiple-choice question (4 options) for a "Which flower are you?" quiz. 
          
          CRITICAL INSTRUCTION: You MUST focus ONLY on this specific personality dimension: ${currentTrait}.
          CONTEXT: We are on question ${currentCount + 1} of 10. 
          
          PREVIOUS THEMES (DO NOT REPEAT): ${PERSONALITY_TRAITS.slice(0, currentCount).join(", ")}.
          
          Important: Return ONLY valid JSON.
          Format your response as a JSON object:
          {
            "id": "${nextId}",
            "text": "The question text",
            "options": [
              { "value": "a", "label": "Option A" },
              { "value": "b", "label": "Option B" },
              { "value": "c", "label": "Option C" },
              { "value": "d", "label": "Option D" }
            ]
          }`;

          try {
            const responseText = await callGroq({
              prompt,
              system: "You are a helpful assistant that only outputs JSON.",
              model: "llama-3.3-70b-versatile"
            });
            const jsonStart = responseText.indexOf('{');
            const jsonEnd = responseText.lastIndexOf('}') + 1;
            const nextQuestion = JSON.parse(responseText.substring(jsonStart, jsonEnd));
            log(`[Tool: submit_answers] Generated Q${currentCount + 1} (Trait: ${currentTrait}): ${nextQuestion.text}`);

            session.questions.push(nextQuestion);
            session.progress = currentCount + 1;

            return {
              content: [{ type: "text", text: `Question ${currentCount + 1} ready.` }],
              structuredContent: {
                success: true,
                message: `Moving to question ${currentCount + 1}`,
                nextQuestion,
                currentCount: currentCount + 1,
                totalCount: 10,
                isComplete: false,
                trait: currentTrait
              },
            };
          } catch (err) {
            logError("LLM next question error:", err);
            return {
              content: [{ type: "text", text: "Something went wrong generating the next question. Please try again." }],
              structuredContent: { success: false, message: "LLM error" }
            };
          }
        } else if (currentCount < 10 && !hasLatestAnswer) {
          const currentQuestion = session.questions[currentCount - 1];
          return {
            content: [{ type: "text", text: "Please answer the current question." }],
            structuredContent: {
              success: true,
              message: "Waiting for answer",
              nextQuestion: currentQuestion,
              currentCount: currentCount,
              totalCount: 10,
              isComplete: false
            }
          };
        } else {
          session.progress = 'ready_for_results';
          return {
            content: [{ type: "text", text: "All 10 questions answered! You're ready to see your results." }],
            structuredContent: {
              success: true,
              message: "Quiz complete",
              isComplete: true,
              currentCount: 10,
              totalCount: 10
            },
          };
        }
      }
      return { content: [{ type: "text", text: "Session error" }], structuredContent: { success: false, message: "No session" } };
    }
  );

  mcpServer.registerTool(
    "show_results",
    {
      description:
        "Compute and display the user's flower match based on their answers. IMPORTANT: The full result, including the name and detailed description, is shown in the UI widget. Keep your text response brief and celebratory, without repeating the flower's biography.",
      inputSchema: {
        answers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Optional answers map."),
        sessionId: z
          .string()
          .optional()
          .describe("The unique session ID from the 'start' tool. REQUIRED for state persistence."),
      },
      _meta: {
        ui: { resourceUri: RESULTS_URI },
        "openai/outputTemplate": RESULTS_URI,
        "openai/toolInvocation/invoking": "Blooming your flower...",
        "openai/invoked": "Match revealed",
        "openai/widgetDescription": "The quiz is complete, and the personalized flower match result is currently blooming in the widget with a detailed description."
      },
    },
    async ({ sessionId }) => {
      const sid = sessionId || getSessionId();
      log(`[Tool: show_results] Using Sid: ${sid}`);
      const session = getSession(sid);
      if (!session || Object.keys(session.answers).length === 0) {
        return { content: [{ type: "text", text: "No quiz data found to calculate results." }], structuredContent: { success: false } };
      }

      const flowersData = JSON.parse(readFileSync(join(__dirname, "..", "data", "flowers.json"), "utf-8"));
      const questionHistoryArr = session.questions.map(q => ({ q: q.text, a: session.answers[q.id] }));
      const questionHistory = JSON.stringify(questionHistoryArr);

      log(`[Tool: show_results] Analyzing ${questionHistoryArr.length} answers`);

      const prompt = `You are a professional personality psychologist and master botanist. 
      Analyze the user's personality depth based on these 10 quiz responses.
      
      User Answers: ${questionHistory}
      
      Available Flowers: ${JSON.stringify(flowersData.flowers)}
      
      NARROWING THE MATCH (MANDATORY):
      - Avoid defaulting to 'Orchid' or 'Rose' unless the user's profile is highly sophisticated, rare, and mysterious.
      - If the user is cheerful, honest, and uncomplicated -> 'Daisy'.
      - If the user is calm, introspective, and resilient -> 'Lotus'.
      - If the user is social, optimistic, and energetic -> 'Sunflower'.
      - If the user is graceful, quiet, and detailed -> 'Lavender'.
      - If the user is artistic, dreamy, and slightly unconventional -> 'Poppy'.
      
      Diversity is key. Ensure the flower essence matches the nuanced answers provided.
      
      Format your response as a JSON object with these EXACT fields:
      {
        "flower": {
          "id": "flower_id",
          "name": "Flower Name",
          "quote": "A poetic, one-sentence quote about the user's match.",
          "traits": [
            { "label": "NATURALLY RADIANT", "icon": "sun" },
            { "label": "FULL OF LIFE", "icon": "leaf" }
          ],
          "meaning": "A symbol of [quality]. [One-sentence insight].",
          "description": "A more detailed biography (1-2 paragraphs) explaining the deep connection between their answers and this flower's essence."
        }
      }`;

      try {
        log("[Tool: show_results] Requesting personality match from Groq...");
        const responseText = await callGroq({
          prompt,
          system: "You are a professional personality psychologist and botanist who only outputs JSON. Be concise but deep in your descriptions.",
          model: "llama-3.3-70b-versatile",
          temperature: 0.7
        });

        let result;
        try {
          const jsonStart = responseText.indexOf('{');
          const jsonEnd = responseText.lastIndexOf('}') + 1;
          const parsed = JSON.parse(responseText.substring(jsonStart, jsonEnd));
          result = parsed.flower || parsed;
        } catch (parseErr) {
          logError("[Tool: show_results] JSON parse failed, trying fallback extraction...");
          const nameMatch = responseText.match(/"name":\s*"([^"]+)"/);
          const descMatch = responseText.match(/"description":\s*"([^"]+)"/);
          const idMatch = responseText.match(/"id":\s*"([^"]+)"/);

          if (nameMatch && descMatch) {
            result = {
              id: idMatch ? idMatch[1] : 'unknown',
              name: nameMatch[1],
              description: descMatch[1]
            };
          } else {
            throw parseErr;
          }
        }

        session.progress = 'complete';

        return {
          content: [{ type: "text", text: `Your results are ready! You are a ${result.name}.\n\n[The results are visible in the UI.]` }],
          structuredContent: {
            flower: result,
            answers: session.answers
          },
        };
      } catch (err) {
        logError("LLM result error:", err);
        return {
          content: [{ type: "text", text: "Something went wrong calculating your results." }],
          structuredContent: { success: false, message: "LLM error" }
        };
      }
    }
  );

  mcpServer.registerTool(
    "end",
    {
      description:
        "End the quiz and say goodbye. Call when the user is done with the flower quiz.",
    },
    async () => ({
      content: [{ type: "text", text: END_RESPONSE }],
    })
  );

  mcpServer.registerTool(
    "get_quiz_state",
    {
      sessionId: z.string().describe("Current user session ID"),
    },
    async ({ sessionId }) => {
      const session = getSession(sessionId);
      if (!session || !session.questions || session.questions.length === 0) {
        return {
          content: [{ type: "text", text: "Session or quiz data not found." }],
          structuredContent: { success: false, message: "Session not found" }
        };
      }
      const q = session.questions[session.questions.length - 1];
      const count = session.questions.length;

      return {
        content: [{ type: "text", text: `Current Question: ${q.question || q.text}` }],
        structuredContent: {
          sessionId,
          currentCount: count,
          totalCount: 10,
          question: q,
          isComplete: (session.progress === 'ready_for_results' || session.progress === 'complete')
        },
        _meta: {
          "openai/invoked": "State recovered",
          "openai/widgetDescription": "Recovering the current state of the quiz for the user."
        }
      };
    }
  );

  return mcpServer;
}

// ─── Request Handler ──────────────────────────────────────────────────────────
const transports = {};
const PORT = parseInt(process.env.PORT || "3553", 10);

const requestListener = async (req, res) => {
  // Derive client IP (respects X-Forwarded-For from reverse proxies)
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const sessionId = req.headers["mcp-session-id"];

  // Apply security headers to every response
  applySecurityHeaders(res);

  // CORS — reflect origin for trusted ChatGPT domains (supports credentialed requests);
  // fall back to wildcard for all other callers (curl, dev tools, etc.)
  const origin = req.headers.origin || "";
  if (TRUSTED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, mcp-session-id, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  // Rate limiting (skip for OPTIONS which was handled above)
  if (isRateLimited(clientIp)) {
    log(`[RateLimit] Blocked ${clientIp} on ${url.pathname}`);
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Too many requests. Please slow down." }));
    return;
  }

  log(`${req.method} ${url.pathname} [${clientIp}]`);
  if (DEV_MODE) {
    log(`[Debug] mcp-session-id: ${sessionId || "none"}`);
  }

  // Health check / info endpoint
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: "fluduro", version: "1.0.0", status: "ok" }));
    return;
  }

  // Public static pages
  const publicPages = {
    "/support": "support.html",
    "/privacy": "privacy.html",
    "/terms": "terms.html",
  };

  if (publicPages[url.pathname]) {
    try {
      const filePath = join(__dirname, "..", "public", publicPages[url.pathname]);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      });
      res.end(readFileSync(filePath));
      return;
    } catch (err) {
      logError(`Error serving public page ${url.pathname}:`, err);
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
  }

  if (url.pathname === "/mcp") {
    try {
      let transport;
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (req.method === "POST") {
        const body = await new Promise((resolve, reject) => {
          let data = "";
          let size = 0;
          const MAX_BODY_SIZE = 1024 * 64; // 64 KB guard

          req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
              req.destroy();
              reject(new Error("Request body too large"));
              return;
            }
            data += chunk;
          });
          req.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              logError("JSON parse error in request body:", e.message);
              resolve({});
            }
          });
          req.on("error", reject);
        });

        if (isInitializeRequest(body)) {
          const sid = (sessionId && getSession(sessionId)) ? sessionId : randomUUID();
          log(`[Server] Initializing session: ${sid} (${sessionId === sid ? "REUSED" : "NEW"})`);

          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => sid,
            onsessioninitialized: (finalSid) => {
              transports[finalSid] = transport;
            },
          });
          transport.onclose = () => {
            if (sid && transports[sid]) {
              log(`[Server] Session closed: ${sid}`);
              delete transports[sid];
              cleanupSessions();
            }
          };

          res.setHeader("mcp-session-id", sid);
          const server = createMcpServer(() => transport.sessionId);
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }
      }

      if (transport) {
        if (transport.sessionId) {
          res.setHeader("mcp-session-id", transport.sessionId);
        }
        await transport.handleRequest(req, res);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "No valid session or initialize request" },
            id: null,
          })
        );
      }
    } catch (error) {
      logError("MCP handler error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
          })
        );
      }
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
};

// ─── Start ────────────────────────────────────────────────────────────────────
// Plain HTTP — cloud platforms (Railway, Render, Fly) terminate TLS at the edge.
// No certs, no config. Just runs.
const server = http.createServer(requestListener);
server.listen(PORT, "0.0.0.0", () => {
  log(`Fluduro MCP server listening on port ${PORT}`);
  if (DEV_MODE) log(`MCP endpoint → http://localhost:${PORT}/mcp`);
});

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  log("Shutting down...");
  for (const sid of Object.keys(transports)) {
    try { await transports[sid].close(); } catch (_) {}
  }
  process.exit(0);
}
