const http = require("http");

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200);
    return res.end(JSON.stringify({
      project: "AI Help Center",
      status: "running"
    }));
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: "healthy" }));
  }

  if (req.method === "POST" && req.url === "/ask") {
    if (!GEMINI_API_KEY) {
      res.writeHead(503);
      return res.end(JSON.stringify({
        error: "AI is not configured"
      }));
    }

    let body = "";

    req.on("data", chunk => {
      body += chunk;
      if (body.length > 20000) {
        res.writeHead(413);
        res.end(JSON.stringify({ error: "Request too large" }));
        req.destroy();
      }
    });

    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const question = String(data.question || "").trim();

        if (!question || question.length > 4000) {
          res.writeHead(400);
          return res.end(JSON.stringify({
            error: "Question is required (maximum 4000 characters)"
          }));
        }

        const response = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": GEMINI_API_KEY
            },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{
                  text: "You are AI Help Center, a helpful Hindi support assistant. Answer in simple Hindi with clear steps. Never invent government job vacancies, results, dates, or official rules. For current information, advise users to verify official sources. Never ask for passwords, OTPs, or API keys."
                }]
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
          }
        );

        const result = await response.json();

        if (!response.ok) {
          console.error("Gemini API error:", response.status);
          res.writeHead(502);
          return res.end(JSON.stringify({
            error: "AI request failed. Check API access and usage limits."
          }));
        }

        const answer = result.candidates?.[0]?.content?.parts
          ?.map(part => part.text || "")
          .join("")
          .trim();

        if (!answer) {
          res.writeHead(502);
          return res.end(JSON.stringify({
            error: "AI did not return an answer"
          }));
        }

        res.writeHead(200);
        res.end(JSON.stringify({ answer }));
      } catch (error) {
        console.error("Request error:", error.message);
        if (!res.writableEnded) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      }
    });

    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Help Center running on port ${PORT}`);
});
