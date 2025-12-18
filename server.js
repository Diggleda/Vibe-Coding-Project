#!/usr/bin/env node
"use strict";

const http = require("http");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const { exec } = require("child_process");

function loadDotEnvSync() {
  const envPath = path.join(__dirname, ".env");
  try {
    const raw = fsSync.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      let trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("export ")) trimmed = trimmed.slice("export ".length).trim();
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (err) {
    const code = err && typeof err === "object" ? err.code : null;
    if (code !== "ENOENT") throw err;
  }
}

loadDotEnvSync();

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const OPENAI_MODEL = process.env.CCD_AI_OPENAI_MODEL || "gpt-4.1-mini";

const PROJECT_ROOT = __dirname;

const CONTENT_TYPE_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const safe = [];
  for (const item of history) {
    if (!item || typeof item !== "object") continue;
    const role = item.role;
    const content = item.content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string" || !content.trim()) continue;
    safe.push({ role, content: content.trim().slice(0, 4000) });
  }
  return safe.slice(-24);
}

async function callOpenAI({ input, history, telemetry }) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    const error = "Missing OPENAI_API_KEY in environment.";
    return { ok: false, status: 500, error };
  }

  const systemParts = [
    "You are Star Chart AI, a helpful assistant embedded in a factory-floor telemetry dashboard called Star Chart Systems.",
    "Answer as a pragmatic operations/industrial engineer. Be concise and specific.",
    "If the user asks for data not in the telemetry snapshot, say what you can infer and what you would need to confirm.",
  ];

  const telemetryJson =
    telemetry && typeof telemetry === "object"
      ? JSON.stringify(telemetry, null, 2)
      : "{}";

  const systemPrompt = `${systemParts.join(" ")}\n\nTelemetry snapshot (JSON):\n${telemetryJson}`;

  const messages = [
    {
      role: "system",
      content: systemPrompt,
    },
    ...normalizeHistory(history),
    { role: "user", content: String(input || "").trim().slice(0, 4000) },
  ];

  async function tryResponsesApi() {
    const transcript = messages
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        instructions: systemPrompt,
        input: transcript,
        temperature: 0.4,
        max_output_tokens: 350,
      }),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail =
        data && typeof data === "object"
          ? data.error?.message || JSON.stringify(data)
          : "Unknown error";
      return { ok: false, status: response.status, error: detail };
    }

    const outputText = data?.output_text;
    if (typeof outputText === "string" && outputText.trim()) {
      return { ok: true, status: 200, text: outputText };
    }

    const chunks = [];
    for (const item of data?.output || []) {
      for (const part of item?.content || []) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          chunks.push(part.text);
        }
      }
    }
    const text = chunks.join("\n").trim();
    if (!text) return { ok: false, status: 502, error: "OpenAI response missing text." };
    return { ok: true, status: 200, text };
  }

  async function tryChatCompletionsApi() {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.4,
        max_tokens: 350,
      }),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail =
        data && typeof data === "object"
          ? data.error?.message || JSON.stringify(data)
          : "Unknown error";
      return { ok: false, status: response.status, error: detail };
    }

    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      return { ok: false, status: 502, error: "OpenAI response missing text." };
    }

    return { ok: true, status: 200, text };
  }

  const responsesResult = await tryResponsesApi();
  if (responsesResult.ok) return responsesResult;

  const fallbackableStatuses = new Set([400, 404, 405, 415]);
  if (!fallbackableStatuses.has(responsesResult.status)) return responsesResult;

  const chatResult = await tryChatCompletionsApi();
  if (chatResult.ok) return chatResult;

  return {
    ok: false,
    status: chatResult.status,
    error: `Responses API error: ${responsesResult.error}\nChat Completions error: ${chatResult.error}`,
  };
}

function safePathFromUrl(urlPathname) {
  const decoded = decodeURIComponent(urlPathname);
  const withoutLeadingSlash = decoded.replace(/^[/\\]+/, "");
  const normalized = path.normalize(withoutLeadingSlash).replace(/^(\.\.(\/|\\|$))+/, "");
  const resolved = path.join(PROJECT_ROOT, normalized);
  if (!resolved.startsWith(PROJECT_ROOT)) return null;
  return resolved;
}

async function serveStatic(req, res, urlPathname) {
  const pathname = urlPathname === "/" ? "/index.html" : urlPathname;
  const filepath = safePathFromUrl(pathname);
  if (!filepath) return sendText(res, 400, "Bad path");

  try {
    const file = await fs.readFile(filepath);
    const ext = path.extname(filepath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPE_BY_EXT[ext] || "application/octet-stream",
      "Content-Length": file.length,
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
    });
    res.end(file);
  } catch (err) {
    const code = err && typeof err === "object" ? err.code : null;
    if (code === "ENOENT" || code === "ENOTDIR") return sendText(res, 404, "Not found");
    return sendText(res, 500, "Server error");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    const origin = req.headers.origin;
    const allowOrigin =
      typeof origin === "string" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ? origin : null;

    if (allowOrigin && (url.pathname.startsWith("/api/") || url.pathname === "/api/chat")) {
      res.setHeader("Access-Control-Allow-Origin", allowOrigin);
      res.setHeader("Vary", "Origin");
    }

    if (req.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      if (allowOrigin) {
        res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Max-Age", "600");
      }
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        app: "star-chart-ai-proxy",
        version: 1,
        model: OPENAI_MODEL,
        hasKey: Boolean(process.env.OPENAI_API_KEY),
      });
    }

    if (url.pathname === "/api/chat") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return sendJson(res, 405, { ok: false, error: "Method not allowed (use POST)." });
      }
      const body = await readJson(req);
      const result = await callOpenAI({
        input: body?.input,
        history: body?.history,
        telemetry: body?.telemetry,
      });
      if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
      return sendJson(res, 200, { ok: true, text: result.text, model: OPENAI_MODEL });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD, POST");
      return sendText(res, 405, "Method not allowed");
    }

    return serveStatic(req, res, url.pathname);
  } catch {
    return sendText(res, 500, "Server error");
  }
});

let currentPort = PORT;

function start(port) {
  currentPort = port;
  server.listen(currentPort);
}

server.once("listening", () => {
  console.log(`Star Chart Systems running at http://localhost:${currentPort}`);
  console.log("Tip: set OPENAI_API_KEY and CCD_AI_OPENAI_MODEL before starting.");
  if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY is not set (check your .env file).");
  }

  if (String(process.env.OPEN_BROWSER || "").toLowerCase() === "true" || process.env.OPEN_BROWSER === "1") {
    const url = `http://localhost:${currentPort}`;
    const command =
      process.platform === "darwin"
        ? `open "${url}"`
        : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
    exec(command, () => {});
  }
});

server.on("error", (err) => {
  if (err && typeof err === "object" && err.code === "EADDRINUSE") {
    const nextPort = currentPort + 1;
    if (nextPort <= PORT + 50) {
      console.warn(`Port ${currentPort} is in use, trying ${nextPort}...`);
      setTimeout(() => start(nextPort), 75);
      return;
    }
  }
  console.error(err);
  process.exit(1);
});

start(currentPort);
