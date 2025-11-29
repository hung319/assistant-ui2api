import { serve } from "bun";

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const TARGET_URL = process.env.TARGET_URL || "https://www.assistant-ui.com/api/chat";

// List models theo yêu cầu (để validate hoặc hiển thị)
const AVAILABLE_MODELS = [
  { name: "GPT 4o-mini", value: "gpt-4o-mini" },
  { name: "Deepseek R1", value: "deepseek-r1" },
  { name: "Claude 3.5 Sonnet", value: "claude-3.5-sonnet" },
  { name: "Gemini 2.0 Flash", value: "gemini-2.0-flash" },
  { name: "Llama 3 8b", value: "llama-3-8b" },
  { name: "Firefunction V2", value: "firefunction-v2" },
  { name: "Mistral 7b", value: "mistral-7b" },
];

// Fake Headers để bypass
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

// --- Helper: Convert OpenAI Messages to Assistant-UI Format ---
function convertMessages(messages: any[]) {
  return messages.map((msg) => ({
    role: msg.role,
    parts: [{ type: "text", text: msg.content }],
    id: crypto.randomUUID().slice(0, 8), // Random ID ngắn
  }));
}

// --- Server Logic ---
console.log(`🚀 Bun Server running on port ${PORT}`);
if (process.env.HTTP_PROXY) console.log(`🔌 Using Proxy: ${process.env.HTTP_PROXY}`);

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // 1. Handle CORS (quan trọng cho Web UI)
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // 2. Handle /v1/models (Client thường gọi cái này trước)
    if (url.pathname === "/v1/models" && req.method === "GET") {
      const modelsData = AVAILABLE_MODELS.map((m) => ({
        id: m.value,
        object: "model",
        created: Date.now(),
        owned_by: "assistant-ui-proxy",
      }));
      return Response.json({ object: "list", data: modelsData });
    }

    // 3. Handle Chat Completions
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      try {
        const body = await req.json();
        const { messages, stream, model } = body;

        // Build Payload cho Assistant-UI
        // Lưu ý: Backend này có vẻ không thực sự switch model qua tham số, 
        // nhưng ta vẫn nhận model ID để log.
        const payload = {
            tools: { 
                // Hardcode tools schema để giống request gốc
                weather_search: { description: "Find weather", parameters: { type: "object", properties: { query: { type: "string" } } } } 
            },
            id: "DEFAULT_THREAD_ID",
            messages: convertMessages(messages || []),
            trigger: "submit-message",
            metadata: {} // Có thể inject model ID vào đây nếu backend hỗ trợ
        };

        // Gửi request tới Target
        // Bun.fetch tự động dùng HTTP_PROXY từ env
        const targetResp = await fetch(TARGET_URL, {
          method: "POST",
          headers: TARGET_HEADERS,
          body: JSON.stringify(payload),
        });

        if (!targetResp.ok) {
            const errText = await targetResp.text();
            console.error("Target Error:", targetResp.status, errText);
            return new Response(JSON.stringify({ error: "Upstream Error" }), { status: 502 });
        }

        if (!targetResp.body) return new Response("No body", { status: 500 });

        // --- Xử lý Streaming (SSE Transformation) ---
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
                  buffer = lines.pop() || ""; // Giữ lại phần chưa hoàn chỉnh

                  for (const line of lines) {
                    if (line.startsWith("data: ")) {
                      const dataStr = line.slice(6).trim();
                      if (dataStr === "[DONE]") continue;

                      try {
                        const event = JSON.parse(dataStr);
                        
                        // Chỉ quan tâm event text-delta
                        if (event.type === "text-delta" && event.delta) {
                          const chunk = {
                            id: "chatcmpl-" + crypto.randomUUID(),
                            object: "chat.completion.chunk",
                            created: Date.now(),
                            model: model,
                            choices: [{
                              index: 0,
                              delta: { content: event.delta },
                              finish_reason: null,
                            }],
                          };
                          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                        }
                        
                        // Xử lý sự kiện kết thúc
                        if (event.type === "finish" || event.type === "text-end") {
                            // Optional: Gửi finish reason nếu cần
                        }

                      } catch (e) { /* Ignore json parse error */ }
                    }
                  }
                }
                // Send DONE
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              } catch (err) {
                console.error("Stream Error:", err);
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
            // Non-stream mode (đơn giản hóa: trả về JSON khi xong hết stream - TODO nếu cần)
            return Response.json({ error: "Only stream=true is supported in this demo implementation" }, { status: 400 });
        }

      } catch (error) {
        console.error("Server Error:", error);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});
