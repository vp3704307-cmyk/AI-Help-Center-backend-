
"use strict";

const http = require("node:http");

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const MAX_BODY_BYTES = 20000;
const MAX_QUESTION_CHARS = 4000;
const REQUEST_TIMEOUT_MS = 30000;

const SYSTEM_INSTRUCTION = `
You are AI Help Center, a helpful Hindi support assistant.
Answer in simple Hindi with clear, numbered steps.
Be polite and practical.
Never invent government vacancies, exam results, dates,
official rules, schemes, or eligibility requirements.
For current or changing information, direct users to official
sources and clearly state when something needs verification.
Never ask for passwords, OTPs, API keys, or secret credentials.
Do not claim that an application, payment, or government
service has been completed unless it has actually been verified.
For medical, legal, financial, or safety-critical issues,
give cautious general information and recommend qualified help
when appropriate.
`.trim();

function sendJson(res, statusCode, payload) {
  if (res.writableEnded || res.destroyed) return;

  const output = JSON.stringify(payload);

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  res.end(output);
}

function getPath(req) {
  try {
    return new URL(req.url, "http://localhost").pathname;
  } catch {
    return "";
  }
}

async function readJsonBody(req) {
  let body = "";
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
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
    console.error("Configuration error: GEMINI_API_KEY is missing");

    return sendJson(res, 503, {
      error: "AI service is not configured"
    });
  }

  let data;

  try {
    data = await readJsonBody(req);
  } catch (error) {
    return sendJson(
      res,
      error.statusCode || 400,
      {
        error: error.statusCode === 413
          ? "Request body is too large"
          : "Invalid JSON request"
      }
    );
  }

  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
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
    const apiUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(GEMINI_MODEL) +
      ":generateContent";

    const response = await fetch(apiUrl, {
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

    const rawResponse = await response.text();
    let result;

    try {
      result = JSON.parse(rawResponse);
    } catch {
      console.error(
        "Gemini returned non-JSON response; HTTP status:",
        response.status
      );

      return sendJson(res, 502, {
        error: "AI service returned an invalid response"
      });
    }

    if (!response.ok) {
      const apiMessage =
        result?.error?.message || "No error details provided";

      // Never log the API key or request headers.
      console.error("Gemini API failure:", {
        status: response.status,
        model: GEMINI_MODEL,
        message: String(apiMessage).slice(0, 500)
      });

      return sendJson(res, 502, {
        error: "AI request failed",
        message: response.status === 404
          ? "Configured Gemini model was not found or is unavailable"
          : response.status === 429
            ? "AI usage limit reached; try again later"
            : response.status === 401 ||
              response.status === 403
              ? "Check Gemini API key and access permissions"
              : "Gemini service could not complete the request"
      });
    }

    const answer = result?.candidates?.[0]?.content?.parts
      ?.map(part => typeof part.text === "string" ? part.text : "")
      .join("")
      .trim();

    if (!answer) {
      console.error(
        "Gemini returned no text; finish reason:",
        result?.candidates?.[0]?.finishReason || "unknown"
      );

      return sendJson(res, 502, {
        error: "AI did not return a text answer"
      });
    }

    return sendJson(res, 200, { answer });

  } catch (error) {
    if (error.name === "AbortError") {
      console.error("Gemini request timed out");

      return sendJson(res, 504, {
        error: "AI request timed out; please try again"
      });
    }

    console.error("AI request failed:", error.message);

    return sendJson(res, 502, {
      error: "Could not connect to the AI service"
    });

  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const path = getPath(req);

  if (req.method === "GET" && path === "/") {
    return sendJson(res, 200, {
      project: "AI Help Center",
      status: "running"
    });
  }

  if (req.method === "GET" && path === "/health") {
    return sendJson(res, 200, {
      status: "healthy"
    });
  }

  if (req.method === "POST" && path === "/ask") {
    return handleAsk(req, res);
  }

  return sendJson(res, 404, {
    error: "Not found"
  });
});

server.requestTimeout = 35000;
server.headersTimeout = 40000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Help Center running on port ${PORT}`);
  console.log(`Gemini model configured: ${GEMINI_MODEL}`);
});
