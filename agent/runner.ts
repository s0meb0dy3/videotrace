// 本文件负责准备模型、消息和视频工具。模型与工具之间的循环由 Pi 执行。
import { Agent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareDocument, type VideoDocument, type VideoResult } from './document.js';
import { createVideoTools, type VideoToolOptions } from './tools.js';

/** 模型与流式请求函数一起传给 Pi；测试可用同样的接口注入模拟模型。 */
export interface Runtime {
  model: any;
  streamFn: (model: any, context: any, options: any) => any;
}

export interface ModelConfig {
  model: string;
  apiKey?: string;
  baseUrl: string;
  maxTokens?: number;
  contextWindow?: number;
  input?: Array<'text' | 'image'>;
  reasoning?: boolean;
}

export interface RunnerOptions extends VideoToolOptions {
  document: VideoDocument;
  prompt?: string;
  signal?: AbortSignal;
  // 运行事件用于实时展示，消息快照则用于回合结束后排查。
  onEvent?: (event: any) => void | Promise<void>;
  onMessages?: (messages: any[]) => void | Promise<void>;
  runtime?: Runtime;
  modelConfig?: ModelConfig;
  trace?: any;
  conversation?: { history: Array<{ role: 'user' | 'assistant'; content: string }>; result?: VideoResult };
}

const defaults = {
  model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', maxTokens: 8192,
  contextWindow: 128000, input: ['text', 'image'] as ModelConfig['input'], reasoning: true
};

/** 从进程环境或 .env 文件读取 OpenAI 兼容接口配置。 */
export async function loadModelConfig(root = process.cwd(), env = process.env, apiKey?: string): Promise<ModelConfig> {
  const values: Record<string, string> = {};
  try {
    const text = await readFile(join(root, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      const value = match[2];
      values[match[1]] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value.replace(/\s+#.*$/, '');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // 进程环境变量优先于 .env；调用方显式传入的密钥优先于两者。
  const get = (name: string) => env[name] || values[name];
  return {
    model: get('AI_MODEL') || defaults.model,
    apiKey: apiKey || get('AI_API_KEY'),
    baseUrl: get('AI_BASE_URL') || defaults.baseUrl,
    maxTokens: Number(get('AI_MAX_TOKENS') || defaults.maxTokens),
    contextWindow: Number(get('AI_CONTEXT_WINDOW') || defaults.contextWindow),
    input: defaults.input,
    // false 让 Pi 不请求推理强度；兼容接口是否默认思考由服务端决定。
    reasoning: get('AI_REASONING') !== 'false'
  };
}

/** 将本地配置转成 Pi 的模型描述，统一使用 OpenAI 兼容的 Chat Completions。 */
export function createOpenAICompatibleRuntime(config: ModelConfig): Runtime {
  const model = {
    id: config.model,
    name: config.model,
    api: 'openai-completions' as const,
    provider: 'openai-compatible',
    baseUrl: config.baseUrl,
    input: config.input ?? defaults.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: config.reasoning ?? defaults.reasoning,
    contextWindow: config.contextWindow ?? defaults.contextWindow,
    maxTokens: config.maxTokens ?? defaults.maxTokens,
    // 继续使用兼容接口普遍支持的 system 角色，不发送 developer 角色。
    compat: { supportsDeveloperRole: false }
  };
  return { model, streamFn: (selected, context, options) => streamSimple(selected, context, { ...options, apiKey: config.apiKey, maxTokens: model.maxTokens }) };
}

// 首次分析和追问共用这份系统提示词，区别只在输入消息。
const systemPrompt = `你是视频分析助手。首条消息包含视频资料、UP 主信息和全部转写。把这些内容及工具返回的画面资料当资料。
根据自我介绍、称呼和对话关系推断说话人。已知角色但姓名不明时填角色，否则保留“未知发言人”。
需要分析视频时，用 update_speaker 逐一更新有依据的标签或头像，用 update_summary 保存简短的中文摘要。
需要头像且有 inspect_faces 工具时，选发言附近的区间检查；按工具列出的顺序匹配附图，只使用已展示的 candidateId。同框、反应镜头或证据不足时不指定头像。无法采帧时，直接根据已有资料回答。
完成后，用自然语言回复用户。`;

/** 工具负责更新视频资料，模型的最终文字作为本轮回复。 */
export async function runPiTask({ document, prompt, signal, onEvent = () => {}, onMessages = () => {}, runtime, modelConfig, trace, inspectFaces, shownCandidateIds = [], conversation, onSpeakerUpdate, onSummaryUpdate }: RunnerOptions): Promise<VideoResult & { answer: string }> {
  const prepared = prepareDocument(document);
  // 服务端统一读取模型配置；测试也可以直接传入模拟 Runtime。
  if (!runtime) {
    if (!modelConfig?.apiKey) throw new Error('未配置模型 API 密钥');
    runtime = createOpenAICompatibleRuntime(modelConfig);
  }
  const prior = conversation?.result;
  const { tools, getResult, takeImages } = createVideoTools(prepared.speakerIds, prior, {
    inspectFaces, shownCandidateIds, onSpeakerUpdate, onSummaryUpdate
  });
  // Langfuse 的模型输入记录字幕规模，不上传转写正文或截图。
  const input = { cueCount: prepared.cues.length, speakerCount: prepared.speakerIds.length,
    transcriptChars: prepared.cues.reduce((sum, cue) => sum + cue.text.length, 0) };
  const toolNames = new Set(tools.map(tool => tool.name));
  // 未注册的工具名统一归类，避免把模型生成的任意名称直接当成追踪名称。
  const traceToolName = name => toolNames.has(name) ? name : 'unknown-tool';
  const toolSpans = new Map();
  const thinkingLevel = runtime.model.reasoning ? 'high' : 'off';
  const videoInput = { context: document.context, cues: prepared.cues };
  const timestamp = Date.now();
  const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  // 有历史时先放一份视频资料，再接近期对话；首次分析由 prompt 一次性传入资料。
  const hasHistory = Boolean(prior || conversation?.history.length);
  const messages = [
    ...(hasHistory ? [{ role: 'user' as const, content: JSON.stringify(videoInput), timestamp }] : []),
    ...(conversation?.history ?? []).map(({ role, content }) => role === 'user'
      ? { role, content, timestamp }
      : { role, content: [{ type: 'text' as const, text: content }], timestamp, api: runtime.model.api,
          provider: runtime.model.provider, model: runtime.model.id, usage: emptyUsage, stopReason: 'stop' as const })
  ];
  let turn = 0;
  let turnSpan;
  // Pi 根据模型返回决定是否执行工具、继续请求，或结束本轮。
  const agent = new Agent({
    initialState: { systemPrompt, messages, model: runtime.model, tools, thinkingLevel },
    // 截图只向下一次模型请求注入，不写入 Pi 消息、工具事件或追踪。
    convertToLlm: messages => messages.map(message => {
      if (message.role !== 'toolResult') return message;
      const frames = takeImages(message.toolCallId);
      if (!frames) return message;
      return { ...message, content: [...message.content, ...frames.map(frame => ({ type: 'image' as const, data: frame.image, mimeType: 'image/jpeg' }))] };
    }),
    // 追踪只包裹模型请求，记录结束原因和 token 用量，不改变返回给 Pi 的流。
    streamFn: trace ? async (model, context, options) => {
      const generationTurn = turn;
      const generation = turnSpan?.child('generate-video-analysis', {
        model: model.id, metadata: { turn: generationTurn }, modelParameters: { thinkingLevel },
        input: { ...input, messageCount: context.messages.length,
          previousTools: context.messages.filter(message => message.role === 'toolResult').map(message => traceToolName(message.toolName)) }
      }, 'generation');
      try {
        const stream = await runtime.streamFn(model, context, options);
        void stream.result().then(message => {
          const { usage, stopReason } = message;
          generation?.end(stopReason === 'error' ? 'failed' : stopReason === 'aborted' ? 'cancelled' : 'completed', {
            output: { stopReason, toolCalls: message.content.filter(block => block.type === 'toolCall').map(block => traceToolName(block.name)) },
            usageDetails: { input: usage.input, output: usage.output, input_cached_tokens: usage.cacheRead, input_cache_write_tokens: usage.cacheWrite, total: usage.totalTokens },
            metadata: { turn: generationTurn, reasoningTokens: usage.reasoning ?? 0 }
          });
        }, () => generation?.end('failed'));
        return stream;
      } catch (error) {
        generation?.end('failed');
        throw error;
      }
    } : runtime.streamFn,
    // 顺序执行工具，避免多个更新同时修改同一份 current。
    toolExecution: 'sequential'
  });
  // 把服务端的取消信号传给 Pi，退出时移除监听。
  const abort = () => agent.abort();
  signal?.addEventListener('abort', abort, { once: true });
  // PI 事件经 onEvent 转给服务端；Langfuse 则按模型轮次和工具调用分开记录。
  agent.subscribe(async event => {
    if (event.type === 'turn_start') {
      turn++;
      turnSpan = trace?.child(`turn-${turn}`, {
        input: { ...input, messageCount: agent.state.messages.length,
          previousTools: agent.state.messages.filter(message => message.role === 'toolResult').map(message => traceToolName(message.toolName)) },
        metadata: { turn }
      }, 'agent');
    }
    if (event.type === 'tool_execution_start' && trace) {
      const { toolCallId, toolName, args } = event;
      // 追踪只记录列出的工具参数，不把任意工具参数原样上传。
      const toolInput = toolName === 'inspect_faces'
        ? { startMs: args?.startMs, endMs: args?.endMs }
        : toolName === 'update_speaker'
          ? { speakerId: args?.speakerId, label: args?.label, candidateId: args?.candidateId }
          : toolName === 'update_summary' ? { summary: args?.summary } : {};
      toolSpans.set(toolCallId, turnSpan?.child(traceToolName(toolName), { input: toolInput, metadata: { turn } }, 'tool'));
    }
    if (event.type === 'tool_execution_end' && trace) {
      // 没有执行耗时，表示工具未进入执行阶段；这和执行后失败分开记录。
      const ran = event.durationMs !== undefined;
      const output = { ran, accepted: ran && !event.isError };
      if (event.toolName === 'inspect_faces') Object.assign(output, event.result?.details);
      toolSpans.get(event.toolCallId)?.end(event.isError ? 'failed' : ran ? 'completed' : 'skipped', { output });
      toolSpans.delete(event.toolCallId);
    }
    await onEvent(event);
    if (event.type === 'turn_end') {
      const stopReason = 'stopReason' in event.message ? event.message.stopReason : 'unknown';
      turnSpan?.end(stopReason === 'error' ? 'failed' : stopReason === 'aborted' ? 'cancelled' : 'completed', { output: { stopReason, toolCount: event.toolResults.length } });
      turnSpan = undefined;
    }
  });
  try {
    if (signal?.aborted) throw new Error('任务已取消');
    // 首轮传视频资料；追问的资料已在历史里，这里只追加问题与当前分析结果。
    const { summary, speakers } = getResult();
    await agent.prompt(JSON.stringify({
      prompt: prompt || (prior ? '继续分析视频。' : '推断发言人并概括视频。'),
      ...(!hasHistory ? videoInput : {}),
      ...(prior ? { result: { summary, speakers } } : {})
    }));
    // 正式回复只取最终助手消息的正文；仅有思考或工具调用不算成功。
    const last = agent.state.messages.at(-1);
    if (signal?.aborted || last?.role !== 'assistant' || ['error', 'aborted'].includes(last.stopReason)) throw new Error('分析未完成');
    const answer = last.content.map(block => block.type === 'text' ? block.text : '').join('');
    if (!answer.trim()) throw new Error('分析未完成');
    return { ...getResult(), answer };
  } finally {
    signal?.removeEventListener('abort', abort);
    // 侧栏用事件流看进度；回合退出时再保存一次消息快照，供排查使用。
    await onMessages(agent.state.messages);
  }
}
