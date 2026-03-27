import http from "http";
import https from "https";
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

const WELCOME_URI = "ui://plantora/welcome.html";
const QUIZ_URI = "ui://plantora/quiz.html";
const RESULTS_URI = "ui://plantora/results.html";

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

function createMcpServer(getSessionId) {
  const mcpServer = new McpServer({
    name: "plantora",
    version: "1.0.0",
  });

  mcpServer.registerResource(
    "welcome-widget",
    WELCOME_URI,
    { mimeType: "text/html", description: "Welcome card for Plantora quiz" },
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
    { mimeType: "text/html", description: "Quiz form for Plantora" },
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
    { mimeType: "text/html", description: "Flower result card for Plantora" },
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
        "Greet the user and explain what Plantora offers: a personality quiz to discover which flower matches their personality. Ask if they want to start. IMPORTANT: The UI widget will handle the primary explanation. Do not repeat instructions or welcome text into the chat if it's already in the UI.",
      _meta: {
        ui: { resourceUri: WELCOME_URI },
        "openai/outputTemplate": WELCOME_URI,
        "openai/toolInvocation/invoking": "Waking up the garden...",
        "openai/toolInvocation/invoked": "Welcome to Plantora",
        "openai/widgetDescription": "A welcome screen is showing for the Plantora flower quiz, inviting the user to start a botanical personality journey."
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
      console.log(`[Tool: start] Session ID: ${sid}`);
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
        console.log(`[Tool: start] Generated Q1 (Trait: ${trait}): ${question.text}`);

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
        console.error("LLM start error:", err);
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
      console.log(`[Tool: submit_answers] Using Sid: ${sid}, Received: ${JSON.stringify(answers)}`);
      const session = getSession(sid);
      if (session) {
        // Only update if answers are provided
        if (answers && Object.keys(answers).length > 0) {
          session.answers = { ...session.answers, ...answers };
        }

        const currentCount = session.questions.length;
        console.log(`[Tool: submit_answers] History Count: ${currentCount}, Total: 10`);

        if (currentCount < 10) {
          // Generate next question
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
            console.log(`[Tool: submit_answers] Generated Q${currentCount + 1} (Trait: ${currentTrait}): ${nextQuestion.text}`);

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
            console.error("LLM next question error:", err);
            return {
              content: [{ type: "text", text: "Something went wrong generating the next question. Please try again." }],
              structuredContent: { success: false, message: "LLM error" }
            };
          }
        } else {
          // Quiz complete
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
      console.log(`[Tool: show_results] Using Sid: ${sid}`);
      const session = getSession(sid);
      if (!session || Object.keys(session.answers).length === 0) {
        return { content: [{ type: "text", text: "No quiz data found to calculate results." }], structuredContent: { success: false } };
      }

      const flowersData = JSON.parse(readFileSync(join(__dirname, "..", "data", "flowers.json"), "utf-8"));
      const userAnswers = JSON.stringify(session.answers);
      const questionHistoryArr = session.questions.map(q => ({ q: q.text, a: session.answers[q.id] }));
      const questionHistory = JSON.stringify(questionHistoryArr);

      console.log(`[Tool: show_results] Analyzing history: ${questionHistory}`);

      const prompt = `Analyze this user's personality based on their EXACT answers to a 10-question flower quiz and identify which flower from the provided list matches them best.
      
      User Answers: ${questionHistory}
      
      Available Flowers: ${JSON.stringify(flowersData.flowers)}
      
      CRITICAL INSTRUCTIONS:
      1. Choose exactly ONE flower that best reflects the nuances of their choices.
      2. Do NOT default to generic or common matches like 'Sunflower' unless the answers explicitly point to high social energy and optimism.
      3. Be highly sensitive to the balance of traits (e.g. introversion, resilience, creativity).
      4. Return your response as a JSON object with these EXACT fields:
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
        console.log("[Tool: show_results] Requesting personality match from Groq...");
        const responseText = await callGroq({
          prompt,
          system: "You are a professional personality psychologist and botanist who only outputs JSON. Be concise but deep in your descriptions.",
          model: "llama-3.3-70b-versatile",
          temperature: 0.7 // Increased temperature for better variety in personality matches
        });

        console.log(`[Tool: show_results] LLM raw response: ${responseText}`);

        let result;
        try {
          const jsonStart = responseText.indexOf('{');
          const jsonEnd = responseText.lastIndexOf('}') + 1;
          const parsed = JSON.parse(responseText.substring(jsonStart, jsonEnd));
          // Handle both { flower: { ... } } and direct { id, name, description }
          result = parsed.flower || parsed;
        } catch (parseErr) {
          console.error("[Tool: show_results] JSON parse failed, trying fallback extraction...");
          // Simple fallback extraction if JSON is messy
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
        console.error("LLM result error:", err);
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

const transports = {};
const PORT = parseInt(process.env.PORT || "3553", 10);

const requestListener = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const sessionId = req.headers["mcp-session-id"];

  // DEBUG: Log all headers to find stable host-provided IDs
  console.log(`[Server] ${req.method} ${url.pathname}`);
  console.log(`[Server] Headers: ${JSON.stringify(req.headers, null, 2)}`);

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

  if (req.method === 'OPTIONS') {
    res.writeHead(240).end();
    return;
  }

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: "plantora", version: "1.0.0", status: "ok" }));
    return;
  }

  if (url.pathname === '/mcp') {
    try {
      let transport;
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (req.method === 'POST') {
        // Handle Initialize or new session
        const body = await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              console.log(`[Server] Parsed POST body: ${JSON.stringify(parsed)}`);
              resolve(parsed);
            }
            catch (e) {
              console.error("[Server] JSON parse error in body:", e.message);
              resolve({});
            }
          });
          req.on('error', reject);
        });

        if (isInitializeRequest(body)) {
          // REUSE sessionId from header if provided and valid, otherwise new
          const sid = (sessionId && getSession(sessionId)) ? sessionId : randomUUID();
          console.log(`[Server] Initializing session: ${sid} (${sessionId === sid ? 'REUSED' : 'NEW'})`);

          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => sid,
            onsessioninitialized: (finalSid) => {
              transports[finalSid] = transport;
            },
          });
          transport.onclose = () => {
            if (sid && transports[sid]) {
              console.log(`[Server] Session closed: ${sid}`);
              delete transports[sid];
              cleanupSessions();
            }
          };

          res.setHeader('mcp-session-id', sid);
          const server = createMcpServer(() => transport.sessionId);
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }
      }

      if (transport) {
        if (transport.sessionId) {
          res.setHeader('mcp-session-id', transport.sessionId);
        }

        if (req.method === 'POST') {
          await transport.handleRequest(req, res);
        } else {
          await transport.handleRequest(req, res);
        }
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No valid session or initialize request" },
          id: null,
        }));
      }
    } catch (error) {
      console.error("MCP handler error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" } }));
      }
    }
    return;
  }

  res.writeHead(404).end('Not Found');
};

async function startServer() {
  const useHttp = process.env.USE_HTTP === "true" || process.env.USE_HTTP === "1";

  if (useHttp) {
    const httpServer = http.createServer(requestListener);
    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`Plantora MCP HTTP server listening on http://0.0.0.0:${PORT}`);
      console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
    });
  } else {
    const sslKeyPath = process.env.SSL_KEY_PATH || "certs/key.pem";
    const sslCertPath = process.env.SSL_CERT_PATH || "certs/cert.pem";
    const fs = await import("fs");
    const path = await import("path");
    const keyPath = path.resolve(process.cwd(), sslKeyPath);
    const certPath = path.resolve(process.cwd(), sslCertPath);

    let key;
    let cert;
    try {
      key = fs.readFileSync(keyPath, "utf8");
      cert = fs.readFileSync(certPath, "utf8");
    } catch (err) {
      console.error(
        "HTTPS certificates not found. Run: npm run generate-certs"
      );
      console.error("Or set USE_HTTP=true for local dev without certs.");
      process.exit(1);
    }

    const httpsServer = https.createServer({ key, cert }, requestListener);
    httpsServer.listen(PORT, '0.0.0.0', () => {
      console.log(`Plantora MCP HTTPS server listening on https://0.0.0.0:${PORT}`);
      console.log(`MCP endpoint: https://localhost:${PORT}/mcp`);
    });
  }

  process.on("SIGINT", async () => {
    for (const sid of Object.keys(transports)) {
      try {
        await transports[sid].close();
      } catch (e) {
        console.error(e);
      }
    }
    process.exit(0);
  });
}

startServer().catch(console.error);
