// 本地 Agent 服务（检查点 2）：POST /chat 用 SSE 把「思考/正文/工具」实时推给前端。
import { createServer } from "node:http";
import { createAgent } from "./agent.ts";

const agent = createAgent();

// 把一条数据写成 SSE 帧：`data: {json}` + 两个换行。
function send(res: any, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/chat") {
    // 1. 读请求体
    let body = "";
    for await (const chunk of req) body += chunk;
    const { text } = JSON.parse(body);

    // 2. 设置 SSE 响应头（关键：text/event-stream，且不设 Content-Length）
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // 3. 订阅 Agent 事件，挑出「思考/正文/工具」转成 SSE 帧
    const unsubscribe = agent.subscribe(event => {
      switch (event.type) {
        case "message_update": {
          const part = event.assistantMessageEvent;
          if (part.type === "thinking_delta") send(res, { type: "thinking", text: part.delta });
          else if (part.type === "text_delta") send(res, { type: "text", text: part.delta });
          break;
        }
        case "tool_execution_start":
          send(res, { type: "tool", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
          break;
        case "tool_execution_end": {
          // 抽出工具结果的文字部分，给前端展开显示
          const result = (event.result?.content ?? [])
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("");
          send(res, { type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, durationMs: event.durationMs, result });
          break;
        }
      }
    });

    // 4. 跑 Agent，边跑边推；结束后发 done 并关闭
    try {
      await agent.prompt(text);
      send(res, { type: "done" });
    } catch (error: any) {
      send(res, { type: "error", message: String(error?.message ?? error) });
    } finally {
      unsubscribe();
      res.end();
    }
    return;
  }

  // 其它请求返回 hello，方便确认服务活着
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("hello");
});

server.listen(43128, "127.0.0.1", () => {
  console.log("服务已启动：http://127.0.0.1:43128");
});
