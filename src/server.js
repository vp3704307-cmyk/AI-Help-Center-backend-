
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const INDEX_FILE = path.join(
  __dirname,
  "..",
  "public",
  "index.html"
);

const MAX_BODY_BYTES = 20000;
const MAX_QUESTION_CHARS = 4000;
const REQUEST_TIMEOUT_MS = 30000;

const SYSTEM_INSTRUCTION = `
You are AI Help Center, a helpful Hindi support assistant.
Answer in simple Hindi with clear steps.
Never invent government vacancies, results, dates, or official rules.
Direct users to official sources for current information.
Never ask for passwords, OTPs, or API keys.
`.trim();

function sendJson(res, status, data) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(data));
}

function getPath(req) {
  try {
    return new URL(req.url, "http://localhost").pathname;
  } catch {
    return "";
  }
}

function serveHomepage(res) {
  fs.readFile(INDEX_FILE, (error, html) => {
    if (error) {
      console.error("Homepage error:", error.message);
      return sendJson(res, 500, {
        error: "Homepage unavailable. Check public/index.html."
      });
    }
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(html);
  });
}

async function readJsonBody(req) {
  let body = "";
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request too large");
      error.statusCode = 413;
      throw error;
    }
    body += chunk.toString("utf8");
  }

  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Invalid JSON");
    error.statusCode = 400;
    throw error;
  }
}

async function handleAsk(req, res) {
  if (!GEMINI_API_KEY) {
    return sendJson(res, 503, {
      error: "AI service is not configured"
    });
  }

  let data;
  try {
    data = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, {
      error: error.statusCode === 413
        ? "Request body is too large"
        : "Invalid JSON request"
    });
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return sendJson(res, 400, {
      error: "Send a JSON object containing question"
    });
  }

  if (typeof data.question !== "string") {
    return sendJson(res, 400, {
      error: "Question must be text"
    });
  }

  const question = data.question.trim();
  if (!question || question.length > MAX_QUESTION_CHARS) {
    return sendJson(res, 400, {
      error: "Question is required; maximum 4000 characters"
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(GEMINI_MODEL) +
      ":generateContent";

    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_INSTRUCTION }]
        },
        contents: [{
          role: "user",
          parts: [{ text: question }]
        }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 800
        }
      })
    });

    const raw = await response.text();
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      return sendJson(res, 502, {
        error: "AI service returned an invalid response"
      });
    }

    if (!response.ok) {
      console.error("Gemini API error:", {
        status: response.status,
        model: GEMINI_MODEL,
        message: String(result?.error?.message || "").slice(0, 300)
      });
      return sendJson(res, 502, {
        error: "AI request failed",
        message: response.status === 404
          ? "Gemini model unavailable"
          : response.status === 429
            ? "AI usage limit reached"
            : response.status === 401 || response.status === 403
              ? "Check Gemini API access"
              : "Gemini service error"
      });
    }

    const answer = result?.candidates?.[0]?.content?.parts
      ?.map(part => typeof part.text === "string" ? part.text : "")
      .join("")
      .trim();

    if (!answer) {
      return sendJson(res, 502, {
        error: "AI did not return a text answer"
      });
    }

    return sendJson(res, 200, { answer });
  } catch (error) {
    if (error.name === "AbortError") {
      return sendJson(res, 504, {
        error: "AI request timed out"
      });
    }
    console.error("AI connection error:", error.message);
    return sendJson(res, 502, {
      error: "Could not connect to AI service"
    });
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const route = getPath(req);

  if (req.method === "GET" && route === "/") {
    return serveHomepage(res);
  }

  if (req.method === "GET" && route === "/health") {
    return sendJson(res, 200, { status: "healthy" });
  }

  if (req.method === "POST" && route === "/ask") {
    return handleAsk(req, res);
  }

  return sendJson(res, 404, { error: "Not found" });
});

server.requestTimeout = 35000;
server.headersTimeout = 40000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Help Center running on port ${PORT}`);
  console.log(`Gemini model configured: ${GEMINI_MODEL}`);
});
