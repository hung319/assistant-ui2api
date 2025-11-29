import { serve } from "bun";

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const TARGET_URL = process.env.TARGET_URL || "https://www.assistant-ui.com/api/chat";
const SERVER_API_KEY = process.env.SERVER_API_KEY;

// --- Utils ---
const log = (tag: string, msg: any) => console.log(`[${new Date().toISOString()}] [${tag}]`, msg);

// --- Server ---
console.log(`🚀 Bun Server running on port ${PORT}`);
if (process.env.HTTP_PROXY) console.log(`🔌 Proxy Configured: ${process.env.HTTP_PROXY}`);

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // 1. CORS
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // 2. Auth Check
    if (SERVER_API_KEY) {
      const authHeader = req.headers.get("Authorization");
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
      if (token !== SERVER_API_KEY) {
        log("AUTH", "⛔ Blocked unauthorized request");
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
    }

    // 3. Models Endpoint
    if (url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [{ id: "gpt-4o-mini", object: "model", created: Date.now(), owned_by: "proxy" }]
      });
    }

    // 4. Chat Endpoint (DEBUG HEAVY)
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      try {
        const body = await req.json();
        const { messages, stream, model } = body;
        
        log("REQ", `Incoming chat request. Model: ${model}, Stream: ${stream}`);
        log("REQ", `Last User Message: ${messages[messages.length - 1]?.content}`);

        // Construct Payload
        const payload = {
            tools: { 
                weather_search: { description: "Find weather", parameters: { type: "object", properties: { query: { type: "string" } } } } 
            },
            id: "DEFAULT_THREAD_ID",
            messages: messages.map((msg: any) => ({
                role: msg.role,
                parts: [{ type: "text", text: msg.content }],
                id: crypto.randomUUID().slice(0, 8),
            })),
            trigger: "submit-message",
            metadata: {}
        };

        // --- Gửi request và Log ---
        log("UPSTREAM", `Sending request to ${TARGET_URL}...`);
        
        const targetResp = await fetch(TARGET_URL, {
          method: "POST",
          headers: {
            "authority": "www.assistant-ui.com",
            "accept": "*/*",
            "content-type": "application/json",
            "origin": "https://www.assistant-ui.com",
            "referer": "https://www.assistant-ui.com/",
            "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
          },
          body: JSON.stringify(payload),
          // Proxy sẽ được Bun tự động dùng nếu có env HTTP_PROXY
        });

        log("UPSTREAM", `Response Status: ${targetResp.status} ${targetResp.statusText}`);

        // --- Xử lý lỗi từ Upstream ---
        if (!targetResp.ok) {
            const errorText = await targetResp.text();
            log("UPSTREAM_ERROR", errorText); // <--- QUAN TRỌNG: Xem server báo lỗi gì ở đây
            return new Response(JSON.stringify({ 
                error: "Upstream Error", 
                details: errorText,
                status: targetResp.status 
            }), { status: 502 });
        }

        if (!targetResp.body) {
            log("ERROR", "Empty body received");
            return new Response("No body", { status: 500 });
        }

        // --- Streaming Logic ---
        if (stream) {
          log("STREAM", "Starting stream forwarding...");
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

                  const chunkText = decoder.decode(value, { stream: true });
                  // Debug: In ra một phần nhỏ data nhận được để xem format
                  // log("DEBUG_CHUNK", chunkText.slice(0, 100) + "..."); 

                  buffer += chunkText;
                  const lines = buffer.split("\n");
                  buffer = lines.pop() || "";

                  for (const line of lines) {
                    if (line.startsWith("data: ")) {
                      const dataStr = line.slice(6).trim();
                      if (dataStr === "[DONE]") continue;

                      try {
                        const event = JSON.parse(dataStr);
                        
                        // Debug: Log nếu gặp event lạ
                        // if (event.type !== "text-delta") log("DEBUG_EVENT", event.type);

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
                      } catch (e) {
                          log("PARSE_ERROR", `Failed to parse JSON: ${dataStr}`);
                      }
                    }
                  }
                }
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                log("STREAM", "Stream finished successfully.");
              } catch (err) {
                log("STREAM_ERROR", err);
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
        }
        
        return new Response("Stream mode required for this debug", { status: 400 });

      } catch (error) {
        log("FATAL", error);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});
