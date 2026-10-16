
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 6000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.6-flash";

const INDEX_FILE = path.join(__dirname, "..", "public", "index.html");

const MAX_BODY_BYTES = 20000;
const MAX_QUESTION_CHARS = 4000;
const REQUEST_TIMEOUT_MS = 60000;

const MAX_CONCURRENT_AI_REQUESTS = 2;
const MAX_QUEUE_LENGTH = 8;
const MAX_QUEUE_WAIT_MS = 90000;

const SYSTEM_INSTRUCTION = `
You are AI Help Center, a helpful Hindi support assistant.
Answer in simple Hindi with clear steps.
Never invent government vacancies, results, dates, or official rules.
Direct users to official sources for current information.
Never ask for passwords, OTPs, or API keys.
`.trim();

let activeAiRequests = 0;
const waitingQueue = [];

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

function runQueued(task) {
  return new Promise((resolve, reject) => {
    const item = { task, resolve, reject, timer: null };

    if (activeAiRequests < MAX_CONCURRENT_AI_REQUESTS) {
      startQueued(item);
      return;
    }

    if (waitingQueue.length >= MAX_QUEUE_LENGTH) {
      const error = new Error("AI queue is full");
      error.code = "QUEUE_FULL";
      reject(error);
      return;
    }

    item.timer = setTimeout(() => {
      const index = waitingQueue.indexOf(item);

      if (index !== -1) {
        waitingQueue.splice(index, 1);

        const error = new Error("Queue wait expired");
        error.code = "QUEUE_TIMEOUT";
        reject(error);
      }
    }, MAX_QUEUE_WAIT_MS);

    waitingQueue.push(item);
  });
}

function startQueued(item) {
  if (item.timer) clearTimeout(item.timer);

  activeAiRequests++;

  Promise.resolve()
    .then(item.task)
    .then(item.resolve, item.reject)
    .finally(() => {
      activeAiRequests--;

      while (waitingQueue.length > 0) {
        const next = waitingQueue.shift();

        if (next.timer) clearTimeout(next.timer);

        startQueued(next);
        break;
      }
    });
}

async function callGemini(question) {
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
      const error = new Error("Invalid AI response");
      error.code = "INVALID_AI_RESPONSE";
      throw error;
    }

    if (!response.ok) {
      const error = new Error(
        String(result?.error?.message || "").slice(0, 300)
      );

      error.code = "GEMINI_ERROR";
      error.status = response.status;
      throw error;
    }

    const answer = result?.candidates?.[0]?.content?.parts
      ?.map(part => typeof part.text === "string" ? part.text : "")
      .join("")
      .trim();

    if (!answer) {
      const error = new Error("AI returned no text");
      error.code = "EMPTY_ANSWER";
      throw error;
    }

    return answer;
  } finally {
    clearTimeout(timeout);
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

  try {
    const answer = await runQueued(() => callGemini(question));
    return sendJson(res, 200, { answer });
  } catch (error) {
    if (error.code === "QUEUE_FULL") {
      return sendJson(res, 503, {
        error: "अभी बहुत सारे सवाल आ रहे हैं। कृपया थोड़ी देर बाद कोशिश करें।"
      });
    }

    if (error.code === "QUEUE_TIMEOUT") {
      return sendJson(res, 503, {
        error: "आपकी बारी में देर हो गई। कृपया दोबारा कोशिश करें।"
      });
    }

    if (error.name === "AbortError") {
      return sendJson(res, 504, {
        error: "AI जवाब देने में समय ले रहा है। कृपया दोबारा कोशिश करें।"
      });
    }

    if (error.code === "GEMINI_ERROR") {
      console.error("Gemini API error:", {
        status: error.status,
        model: GEMINI_MODEL,
        message: error.message
      });

      if (error.status === 429) {
        return sendJson(res, 429, {
          error: "AI की Free usage limit पूरी हो गई है। कृपया बाद में कोशिश करें।"
        });
      }

      if (error.status === 503 || error.status === 502) {
        return sendJson(res, 503, {
          error: "AI सेवा अभी व्यस्त है। कृपया थोड़ी देर बाद कोशिश करें।"
        });
      }

      if (error.status === 401 || error.status === 403) {
        return sendJson(res, 502, {
          error: "AI सेवा की configuration जाँचने की जरूरत है।"
        });
      }

      if (error.status === 404) {
        return sendJson(res, 502, {
          error: "Gemini model उपलब्ध नहीं है।"
        });
      }

      return sendJson(res, 502, {
        error: "AI से जवाब नहीं मिल पाया। कृपया बाद में कोशिश करें।"
      });
    }

    console.error("AI request error:", error.message);

    return sendJson(res, 502, {
      error: "AI से कनेक्शन नहीं हो पाया। कृपया बाद में कोशिश करें।"
    });
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

server.requestTimeout = 120000;
server.headersTimeout = 125000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Help Center running on port ${PORT}`);
  console.log(`Gemini model configured: ${GEMINI_MODEL}`);
  console.log(`AI concurrency limit: ${MAX_CONCURRENT_AI_REQUESTS}`);
  console.log(`AI queue capacity: ${MAX_QUEUE_LENGTH}`);
});
