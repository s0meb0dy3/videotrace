// 工具定义：每个工具就是一个普通对象，包含名称、描述、参数 schema 和执行函数。
// 模型会根据 description 和参数 schema 自己决定要不要调用、怎么填参数。
import type { AgentTool } from "@earendil-works/pi-agent-core";

// 一个模拟的天气工具：不联网，直接返回假数据。
export const getWeatherTool: AgentTool = {
  name: "get_weather",
  label: "查天气",
  description: "查询某个城市今天的天气（模拟数据，不联网）。",
  // 参数用 JSON Schema 描述，模型会按这个结构生成调用参数。
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名，例如 北京" },
    },
    required: ["city"],
    additionalProperties: false,
  },
  // execute 就是工具真正干活的地方：
  // content 是返回给模型看的文字；details 是给日志/界面用的结构化数据。
  execute: async (_toolCallId, params) => {
    const { city } = params as { city: string };
    return {
      content: [{ type: "text", text: `${city}今天晴，25°C（模拟数据）。` }],
      details: { city, weather: "晴", temperature: 25, mock: true },
    };
  },
};

// 联网搜索工具：调用 Tavily 的 /search 接口（官方文档：https://docs.tavily.com）。
export const webSearchTool: AgentTool = {
  name: "web_search",
  label: "联网搜索",
  description: "用 Tavily 联网搜索，返回若干条结果的标题、链接和摘要。需要最新信息或你不确定的事实时用它。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词或问题" },
      max_results: { type: "integer", description: "返回条数，默认 5", minimum: 1, maximum: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  execute: async (_toolCallId, params) => {
    const { query, max_results = 5 } = params as { query: string; max_results?: number };
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) throw new Error("缺少环境变量 TAVILY_API_KEY");

    // 按官方文档：POST /search，Bearer 鉴权，query 必填。
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results, search_depth: "basic" }),
    });
    if (!response.ok) throw new Error(`Tavily 搜索失败（HTTP ${response.status}）`);

    const data = (await response.json()) as {
      results?: Array<{ title: string; url: string; content: string }>;
    };
    const results = data.results ?? [];

    // 整理成模型容易读的文字：编号 + 标题 + 链接 + 摘要。
    const text = results.length
      ? results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.content}`).join("\n\n")
      : "没有找到结果。";

    return {
      content: [{ type: "text", text }],
      details: { query, count: results.length, results },
    };
  },
};

// 所有要交给 Agent 的工具，集中在这个数组里。
export const tools: AgentTool[] = [getWeatherTool, webSearchTool];
