/**
 * Cloudflare Worker (or any Fetch-based edge runtime) OpenAI proxy for GitHub Pages.
 *
 * Env vars to configure:
 * - OPENAI_API_KEY (secret)
 * - OPENAI_MODEL (optional; default: "gpt-4.1")
 * - ALLOWED_ORIGINS (optional; comma-separated list of allowed Origins; if empty, allows all)
 *
 * Routes:
 * - GET  /api/health
 * - POST /api/chat  { input, history, telemetry }
 */

function json(data, init = {}) {
  const body = JSON.stringify(data);
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function getAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;

  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowed.length === 0) return origin;
  return allowed.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "600",
  };
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

async function readJson(request) {
  const text = await request.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function callOpenAI({ env, input, history, telemetry }) {
  const OPENAI_API_KEY = env.OPENAI_API_KEY;
  const OPENAI_MODEL = env.OPENAI_MODEL || "gpt-4.1";

  if (!OPENAI_API_KEY) {
    return { ok: false, status: 500, error: "Missing OPENAI_API_KEY." };
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

  const userInput = String(input || "").trim().slice(0, 4000);
  if (!userInput) return { ok: false, status: 400, error: "Missing input." };

  // Use the Responses API for forward compatibility.
  const transcript = [
    ...normalizeHistory(history).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`),
    `User: ${userInput}`,
  ].join("\n");

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
    return { ok: true, status: 200, text: outputText.trim(), model: OPENAI_MODEL };
  }

  const chunks = [];
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") chunks.push(part.text);
    }
  }
  const text = chunks.join("\n").trim();
  if (!text) return { ok: false, status: 502, error: "OpenAI response missing text." };
  return { ok: true, status: 200, text, model: OPENAI_MODEL };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = getAllowedOrigin(request, env);
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/api/health") {
      return json(
        {
          ok: true,
          app: "star-chart-ai-proxy",
          version: 1,
          model: env.OPENAI_MODEL || "gpt-4.1",
          hasKey: Boolean(env.OPENAI_API_KEY),
        },
        { headers: cors },
      );
    }

    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "Method not allowed (use POST)." }, { status: 405, headers: cors });
      }
      const body = await readJson(request).catch(() => null);
      const result = await callOpenAI({
        env,
        input: body?.input,
        history: body?.history,
        telemetry: body?.telemetry,
      });
      if (!result.ok) return json({ ok: false, error: result.error }, { status: result.status, headers: cors });
      return json({ ok: true, text: result.text, model: result.model }, { headers: cors });
    }

    return json({ ok: false, error: "Not found" }, { status: 404, headers: cors });
  },
};

