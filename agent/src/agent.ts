// 创建 Agent：模型 + 工具 + 提示词。
// 这里不含任何输入/输出，方便以后在终端、HTTP 服务或插件里复用同一份逻辑。
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { tools } from "./tools.ts";

export function createAgent(): Agent {
  // 注册 DeepSeek provider；密钥由 pi-ai 自动从环境变量 DEEPSEEK_API_KEY 读取。
  const models = createModels();
  models.setProvider(deepseekProvider());
  const model = models.getModel("deepseek", "deepseek-flash")!;

  return new Agent({
    initialState: {
      systemPrompt: "你是一个简洁的中文助手。需要查天气时调用 get_weather，需要最新信息或不确定时调用 web_search 联网搜索。",
      model,
      tools,
      thinkingLevel: "high",
    },
    streamFn: models.streamSimple.bind(models),
  });
}
