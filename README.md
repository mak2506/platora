# Plantora MCP Server

A minimal MCP (Model Context Protocol) server for Plantora — a personality-to-flower quiz. The server exposes tools that let an AI assistant guide users through a short quiz and reveal which flower matches their personality.

## Tools

| Tool | Purpose |
|------|---------|
| `say_hello` | Greet the user and explain the quiz; ask if they want to start |
| `start` | Start the quiz; returns 4 multiple-choice questions |
| `submit_answers` | Validate and record the user's answers |
| `show_results` | Compute and display the flower match based on answers |
| `end` | End the quiz and say goodbye |

## Prerequisites

- Node.js 18 or later
- npm

## Setup

```bash
npm install
npm run generate-certs
```

`generate-certs` creates self-signed SSL certificates in `./certs/` for HTTPS. For production, use your own certificates and set `SSL_KEY_PATH` and `SSL_CERT_PATH` (or place `key.pem` and `cert.pem` in `./certs/`).

## Running the Server

**HTTP (recommended for local dev, no cert issues):**
```bash
npm run start:http
```

**HTTPS (requires certs):**
```bash
npm start
```

The server listens on port 3553 by default. Set `PORT` to change it.

- **HTTP:** `http://localhost:3553/mcp`
- **HTTPS:** `https://localhost:3553/mcp`

## MCP Client Configuration (Streamable HTTP)

Use HTTP for local development to avoid certificate issues:

```
http://localhost:3553/mcp
```

In Cursor's `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "plantora": {
      "url": "http://localhost:3553/mcp"
    }
  }
}
```

Run `npm run start:http` before connecting.

## Project Structure

```
plantora/
├── package.json
├── src/
│   ├── server.js         # MCP HTTPS server entry
│   ├── scoring.js        # Answer-to-flower mapping logic
│   └── tools/
│       ├── say-hello.js
│       ├── start.js
│       ├── submit-answers.js
│       ├── show-results.js
│       └── end.js
├── data/
│   ├── questions.json    # Quiz questions and options
│   └── flower-mapping.json  # Scoring rules per flower
├── certs/                # SSL certs (create via npm run generate-certs)
├── scripts/
│   └── generate-certs.js
└── README.md
```

## Data Files

- **data/questions.json** — Defines 4 personality questions with multiple-choice options.
- **data/flower-mapping.json** — Maps answer combinations to flowers (Lotus, Rose, Sunflower, Lavender) using weighted scoring.

Edit these files to customize the quiz content and flower matches.
