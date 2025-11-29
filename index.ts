import { serve } from "bun";

/**
 * CONFIGURATION
 */
const PORT = process.env.PORT || 3000;
const TARGET_URL = process.env.TARGET_URL || "https://www.assistant-ui.com/api/chat";
const SERVER_API_KEY = process.env.SERVER_API_KEY;

// Extracted from assistant-ui source (eK array)
const AVAILABLE_MODELS = [
  { id: "gpt-4o-mini", name: "GPT 4o-mini" },
  { id: "deepseek-r1", name: "Deepseek R1" },
  { id: "claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
  { id: "llama-3-8b", name: "Llama 3 8b" },
  { id: "firefunction-v2", name: "Firefunction V2" },
  { id: "mistral-7b", name: "Mistral 7b" }
];

/**
 * HELPERS
 */
const log = (msg: string) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const generateId = () => Math.random().toString(36).substring(2, 10);

const getHeaders = () => ({
  "authority": "www.assistant-ui.com",
  "accept": "*/*",
  "content-type": "application/json",
  "origin": "https://www.assistant-ui.com",
  "referer": "https://www.assistant-ui.com/",
  "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
});

/**
 * SERVER
 */
console.log(`🚀 OpenAI-Compatible Gateway running on port ${PORT}`);
if (SERVER_API_KEY) console.log(`🔒 Authentication enabled`);

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // 1. CORS Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // 2. Authentication Middleware
    if (SERVER_API_KEY) {
      const authHeader = req.headers.get("Authorization");
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
      if (token !== SERVER_API_KEY) {
        return new Response(JSON.stringify({ 
            error: { message: "Invalid API Key", type: "auth_error" } 
        }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
    }

    // 3. Models Endpoint (Trả về list models chuẩn extracted)
    if (url.pathname === "/v1/models" && req.method === "GET") {
      return Response.json({
        object: "list",
        data: AVAILABLE_MODELS.map(m => ({
          id: m.id,
          object: "model",
          created: Date.now(),
          owned_by: "assistant-ui-proxy",
          permission: [],
          root: m.id,
          parent: null,
        }))
      });
    }

    // 4. Chat Completions Endpoint
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      try {
        const body = await req.json();
        const { messages, stream, model } = body;
        
        log(`REQ: ${model} | Stream: ${!!stream} | IP: ${req.headers.get("x-forwarded-for") || "Local"}`);

        // Construct Payload
        const payload = {
            tools: { 
                // Minimal tool definition to satisfy basic checks
                weather_search: { description: "Find weather", parameters: { type: "object", properties: { query: { type: "string" } } } } 
            },
            id: "DEFAULT_THREAD_ID",
            messages: messages.map((msg: any) => ({
                role: msg.role,
                parts: [{ type: "text", text: msg.content }],
                id: generateId(),
            })),
            trigger: "submit-message",
            // Inject model ID vào metadata (phòng hờ backend hỗ trợ switch model qua field này)
            metadata: {
                modelId: model
            }
        };

        const targetResp = await fetch(TARGET_URL, {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify(payload),
        });

        if (!targetResp.ok) {
            const errorText = await targetResp.text();
            log(`ERR: Upstream ${targetResp.status} - ${errorText.slice(0, 50)}...`);
            return new Response(JSON.stringify({ error: "Upstream Error", details: errorText }), { status: 502 });
        }
        if (!targetResp.body) return new Response("Empty Upstream Body", { status: 500 });

        // --- STREAMING HANDLER (Web Clients) ---
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
                            id: `chatcmpl-${generateId()}`,
                            object: "chat.completion.chunk",
                            created: Date.now(),
                            model: model,
                            choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
                          };
                          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                        }
                      } catch (e) {}
                    }
                  }
                }
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              } catch (err) { controller.error(err); } 
              finally { controller.close(); }
            },
          });
          return new Response(streamResponse, {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
        } 
        
        // --- NON-STREAMING HANDLER (N8n / Automation) ---
        else {
          const reader = targetResp.body.getReader();
          const decoder = new TextDecoder();
          let fullContent = "";
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const dataStr = line.slice(6).trim();
                try {
                  const event = JSON.parse(dataStr);
                  if (event.type === "text-delta" && event.delta) fullContent += event.delta;
                } catch (e) {}
              }
            }
          }

          return Response.json({
            id: `chatcmpl-${generateId()}`,
            object: "chat.completion",
            created: Date.now(),
            model: model,
            choices: [{
              index: 0,
              message: { role: "assistant", content: fullContent },
              finish_reason: "stop"
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          });
        }

      } catch (error) {
        log(`FATAL: ${error}`);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});
