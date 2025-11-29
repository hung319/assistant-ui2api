import { serve } from "bun";

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const TARGET_URL = process.env.TARGET_URL || "https://www.assistant-ui.com/api/chat";
const SERVER_API_KEY = process.env.SERVER_API_KEY; // <--- Lấy Key từ Env

const AVAILABLE_MODELS = [
  { name: "GPT 4o-mini", value: "gpt-4o-mini" },
  { name: "Deepseek R1", value: "deepseek-r1" },
  { name: "Claude 3.5 Sonnet", value: "claude-3.5-sonnet" },
  { name: "Gemini 2.0 Flash", value: "gemini-2.0-flash" },
  { name: "Llama 3 8b", value: "llama-3-8b" },
  { name: "Firefunction V2", value: "firefunction-v2" },
  { name: "Mistral 7b", value: "mistral-7b" },
];

const TARGET_HEADERS = {
  "authority": "www.assistant-ui.com",
  "accept": "*/*",
  "content-type": "application/json",
  "origin": "https://www.assistant-ui.com",
  "referer": "https://www.assistant-ui.com/",
  "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
};

// --- Helper: Convert OpenAI Messages ---
function convertMessages(messages: any[]) {
  return messages.map((msg) => ({
    role: msg.role,
    parts: [{ type: "text", text: msg.content }],
    id: crypto.randomUUID().slice(0, 8),
  }));
}

// --- Server Logic ---
console.log(`🚀 Bun Server running on port ${PORT}`);
if (SERVER_API_KEY) console.log(`🔒 Secured with API Key: ${SERVER_API_KEY.slice(0, 3)}...***`);
else console.log(`⚠️ Warning: No API Key set. Server is public!`);

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // 1. Handle CORS (Cho phép preflight check không cần Auth)
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization", // Cho phép header Authorization
        },
      });
    }

    // 2. AUTHENTICATION CHECK (Logic mới thêm)
    // Bỏ qua check nếu không set SERVER_API_KEY trong env (chế độ public)
    if (SERVER_API_KEY) {
      const authHeader = req.headers.get("Authorization");
      // Format chuẩn: "Bearer <token>"
      const token = authHeader?.startsWith("Bearer ") 
        ? authHeader.slice(7) 
        : authHeader;

      if (token !== SERVER_API_KEY) {
        console.log(`⛔ Unauthorized access attempt from ${req.headers.get("x-forwarded-for") || "unknown"}`);
        return new Response(JSON.stringify({
          error: {
            message: "Invalid API Key. You are not authorized.",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key"
          }
        }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
    }

    // 3. Handle /v1/models
    if (url.pathname === "/v1/models" && req.method === "GET") {
      const modelsData = AVAILABLE_MODELS.map((m) => ({
        id: m.value,
        object: "model",
        created: Date.now(),
        owned_by: "assistant-ui-proxy",
      }));
      return Response.json({ object: "list", data: modelsData });
    }

    // 4. Handle Chat Completions
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      try {
        const body = await req.json();
        const { messages, stream, model } = body;

        const payload = {
            tools: { 
                weather_search: { description: "Find weather", parameters: { type: "object", properties: { query: { type: "string" } } } } 
            },
            id: "DEFAULT_THREAD_ID",
            messages: convertMessages(messages || []),
            trigger: "submit-message",
            metadata: {}
        };

        const targetResp = await fetch(TARGET_URL, {
          method: "POST",
          headers: TARGET_HEADERS,
          body: JSON.stringify(payload),
        });

        if (!targetResp.ok) {
            return new Response(JSON.stringify({ error: "Upstream Error" }), { status: 502 });
        }
        if (!targetResp.body) return new Response("No body", { status: 500 });

        if (stream) {
          const reader = targetResp.body.getReader();
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();

          const streamResponse = new ReadableStream({
            async start(controller) {
              let buffer = "";
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;

                  buffer += decoder.decode(value, { stream: true });
                  const lines = buffer.split("\n");
                  buffer = lines.pop() || ""; 

                  for (const line of lines) {
                    if (line.startsWith("data: ")) {
                      const dataStr = line.slice(6).trim();
                      if (dataStr === "[DONE]") continue;
                      try {
                        const event = JSON.parse(dataStr);
                        if (event.type === "text-delta" && event.delta) {
                          const chunk = {
                            id: "chatcmpl-" + crypto.randomUUID(),
                            object: "chat.completion.chunk",
                            created: Date.now(),
                            model: model,
                            choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
                          };
                          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                        }
                      } catch (e) { }
                    }
                  }
                }
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              } catch (err) {
                controller.error(err);
              } finally {
                controller.close();
              }
            },
          });

          return new Response(streamResponse, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "Access-Control-Allow-Origin": "*",
            },
          });
        } else {
            return Response.json({ error: "Stream required" }, { status: 400 });
        }
      } catch (error) {
        return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});
