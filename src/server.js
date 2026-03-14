import http from "http";
import https from "https";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SAY_HELLO_RESPONSE } from "./tools/say-hello.js";
import { getQuestions } from "./tools/start.js";
import { validateAnswers } from "./tools/submit-answers.js";
import { formatResults } from "./tools/show-results.js";
import { getMatchingFlower } from "./scoring.js";
import { END_RESPONSE } from "./tools/end.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELCOME_URI = "ui://plantora/welcome.html";
const QUIZ_URI = "ui://plantora/quiz.html";
const RESULTS_URI = "ui://plantora/results.html";

function createMcpServer() {
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
        "Greet the user and explain what Plantora offers: a personality quiz to discover which flower matches their personality. Ask if they want to start.",
      _meta: {
        ui: { resourceUri: WELCOME_URI },
        "openai/outputTemplate": WELCOME_URI,
      },
    },
    async () => ({
      content: [{ type: "text", text: SAY_HELLO_RESPONSE }],
      structuredContent: {
        message: SAY_HELLO_RESPONSE,
        ctaText: "Start quiz",
      },
    })
  );

  mcpServer.registerTool(
    "start",
    {
      description:
        "Start the personality quiz. Returns 4 multiple-choice questions. Call this when the user agrees to begin.",
      _meta: {
        ui: { resourceUri: QUIZ_URI },
        "openai/outputTemplate": QUIZ_URI,
      },
    },
    async () => {
      const { questions } = getQuestions();
      const text = JSON.stringify(questions, null, 2);
      return {
        content: [
          {
            type: "text",
            text: `Here are the quiz questions. Ask the user each one and collect their answers (q1, q2, q3, q4), then call submit_answers with the collected answers.\n\n${text}`,
          },
        ],
        structuredContent: { questions },
      };
    }
  );

  mcpServer.registerTool(
    "submit_answers",
    {
      description:
        "Submit and validate the user's quiz answers. Pass answers as an object mapping question IDs (q1, q2, q3, q4) to option values (a, b, c, or d). Call show_results after successful submission.",
      inputSchema: {
        answers: z
          .record(z.string(), z.string())
          .describe(
            "Object mapping question IDs to option values, e.g. { q1: 'a', q2: 'b', q3: 'c', q4: 'd' }"
          ),
      },
      _meta: {
        ui: { resourceUri: QUIZ_URI },
        "openai/outputTemplate": QUIZ_URI,
      },
    },
    async ({ answers }) => {
      const result = validateAnswers(answers);
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: {
          success: result.valid,
          message: result.message,
          answers: result.valid ? answers : undefined,
        },
      };
    }
  );

  mcpServer.registerTool(
    "show_results",
    {
      description:
        "Compute and display the user's flower match based on their submitted answers. Call after submit_answers succeeds.",
      inputSchema: {
        answers: z
          .record(z.string(), z.string())
          .describe(
            "The same answers object passed to submit_answers, e.g. { q1: 'a', q2: 'b', q3: 'c', q4: 'd' }"
          ),
      },
      _meta: {
        ui: { resourceUri: RESULTS_URI },
        "openai/outputTemplate": RESULTS_URI,
      },
    },
    async ({ answers }) => {
      const text = formatResults(answers);
      const flower = getMatchingFlower(answers);
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          flower: flower
            ? { id: flower.id, name: flower.name, description: flower.description }
            : null,
          answers,
        },
      };
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

  return mcpServer;
}

const transports = {};
const PORT = parseInt(process.env.PORT || "3553", 10);

const mcpPostHandler = async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  try {
    let transport;
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
        }
      };
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID or initialize request",
        },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
};

const mcpGetHandler = async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

const mcpDeleteHandler = async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

const app = createMcpExpressApp();
app.post("/mcp", mcpPostHandler);
app.get("/mcp", mcpGetHandler);
app.delete("/mcp", mcpDeleteHandler);

// Health check
app.get("/", (req, res) => {
  res.json({ name: "plantora", version: "1.0.0", status: "ok" });
});

async function startServer() {
  const useHttp = process.env.USE_HTTP === "true" || process.env.USE_HTTP === "1";

  if (useHttp) {
    const httpServer = http.createServer(app);
    httpServer.listen(PORT, () => {
      console.log(`Plantora MCP HTTP server listening on http://localhost:${PORT}`);
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

    const httpsServer = https.createServer({ key, cert }, app);
    httpsServer.listen(PORT, () => {
      console.log(`Plantora MCP HTTPS server listening on https://localhost:${PORT}`);
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
