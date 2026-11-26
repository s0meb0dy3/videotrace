import type { VideoResult } from './document.js';

/** 只更新传入的字段；头像传 null 表示移除，省略表示保留。 */
export interface SpeakerPatch {
  speakerId: string;
  label?: string;
  candidateId?: string | null;
}

export interface VideoToolOptions {
  inspectFaces?: (range: { startMs: number; endMs: number }, signal?: AbortSignal) => Promise<any>;
  shownCandidateIds?: Set<string> | string[];
  onSpeakerUpdate?: (patch: SpeakerPatch) => Promise<void>;
  onSummaryUpdate?: (summary: string) => Promise<void>;
}

const summaryParameters = { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string', minLength: 1 } } };

type CandidateFrame = { image: string; faces: Array<{ candidateId: string }> };
type ToolContext = Pick<VideoToolOptions, 'inspectFaces' | 'onSpeakerUpdate' | 'onSummaryUpdate'> & {
  speakerIds: Set<string>;
  current: VideoResult;
  emptyFaces: Record<string, null>;
  pendingImages: Map<string, CandidateFrame[]>;
  inspectedRanges: Set<string>;
  shown: Set<string>;
};

// 工具结果用 JSON 文本返回给模型；截图由请求发送前的转换单独附加。
const content = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });

// 名称、描述、参数和实现只定义一次，不持有任何具体任务的数据。
const toolDefinitions = [
  {
    name: 'inspect_faces', label: '检查画面人物', description: '连续检查当前视频的一小段发言（毫秒，最多3秒）。第一张是带编号的全图，第二张（如有）按编号分行、按时间分列展示相邻人脸。编号仅在本次检查有效；嘴部变化不是音画同步证据，不能确定发言人时不要绑定头像。',
    parameters: { type: 'object', additionalProperties: false, required: ['startMs', 'endMs'], properties: { startMs: { type: 'integer', minimum: 0 }, endMs: { type: 'integer', minimum: 0 } } },
    execute: async ({ inspectFaces, inspectedRanges, pendingImages }, id, range, toolSignal) => {
      if (range.endMs <= range.startMs || range.endMs - range.startMs > 3_000 || !Number.isSafeInteger(range.endMs)) throw new Error('采帧区间必须为正且不超过3秒');
      // 本轮相同区间成功检查后不再重复采帧；unavailable 不计入。
      const key = `${range.startMs}:${range.endMs}`;
      if (inspectedRanges.has(key)) return { ...content({ status: 'already_checked', range }), details: { status: 'already_checked' } };
      const response = await inspectFaces!({ startMs: range.startMs, endMs: range.endMs }, toolSignal);
      if (response?.status === 'unavailable') {
        const details = { status: 'unavailable', reason: response.reason };
        return { ...content({ ...details, range }), details };
      }
      inspectedRanges.add(key);
      const frames = (response.representativeFrames || []).filter(frame => frame.image).slice(0, 3);
      const { images = [], ...visual } = response.visual ?? {};
      // 证据图只发给模型；原帧仍用于头像裁剪。事件只记录元数据。
      const attachments = images.length ? images.map((image, index) => ({ image,
        faces: index === 0 ? frames.flatMap(frame => frame.faces) : [] })) : frames;
      pendingImages.set(id, attachments);
      const safe = { range: response.range || range, detections: response.detections || [],
        representativeFrames: frames.map(({ image, ...frame }) => frame),
        ...(images.length ? { visual: { ...visual, imageOrder: images.length === 2 ? ['annotated_frame', 'face_timeline'] : ['annotated_frame'] } } : {}) };
      return { ...content(safe), details: { range: safe.range, detectionCount: safe.detections.length,
        frameCount: attachments.length, visualStatus: visual.status } };
    }
  },
  {
    name: 'update_speaker', label: '更新说话人', description: '更新一位说话人的标签或头像。省略的字段保持原样；candidateId 为 null 表示移除头像。',
    parameters: { type: 'object', additionalProperties: false, required: ['speakerId'], properties: {
      speakerId: { type: 'string', description: '转写中已有的说话人 ID' },
      label: { type: 'string', minLength: 1 },
      candidateId: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] }
    } },
    execute: async (context, _id, { speakerId, label, candidateId }: SpeakerPatch) => {
      const { current, emptyFaces, shown, onSpeakerUpdate, speakerIds } = context;
      if (!speakerIds.has(speakerId)) throw new Error('无效说话人 ID');
      if (label === undefined && candidateId === undefined) throw new Error('需要提供 label 或 candidateId');
      const normalizedLabel = label?.trim();
      if (normalizedLabel === '') throw new Error('label 不能为空');
      let next = current;
      const patch: SpeakerPatch = { speakerId };
      if (normalizedLabel !== undefined) {
        patch.label = normalizedLabel;
        next = { ...next, speakers: { ...next.speakers, [speakerId]: normalizedLabel } };
      }
      // 不接受未展示的新候选，也不把同一候选分给两位说话人。
      if (candidateId !== undefined) {
        if (candidateId !== null && candidateId !== current.faces?.[speakerId] && !shown.has(candidateId)) throw new Error('只能引用已展示的 candidateId');
        if (candidateId !== null && Object.entries(current.faces || {}).some(([id, value]) => id !== speakerId && value === candidateId)) throw new Error('同一个头像候选不能分配给多个说话人');
        patch.candidateId = candidateId;
        next = { ...next, faces: { ...emptyFaces, ...next.faces, [speakerId]: candidateId } };
      }
      // 先让服务端保存和发布更新；回调成功后，本轮状态才随之更新。
      await onSpeakerUpdate?.(patch);
      context.current = next;
      return content({ accepted: true, ...patch });
    }
  },
  {
    // 保存摘要只是一次资料更新，不会结束 Pi 循环。
    name: 'update_summary', label: '更新摘要', description: '更新视频摘要。', parameters: summaryParameters,
    execute: async (context, _id, { summary }) => {
      if (!summary.trim()) throw new Error('summary 不能为空');
      await context.onSummaryUpdate?.(summary);
      context.current = { ...context.current, summary };
      return content({ accepted: true });
    }
  }
] satisfies Array<{ name: string; label: string; description: string; parameters: object;
  execute: (context: ToolContext, id: string, args: any, signal?: AbortSignal) => Promise<unknown> }>;

/** 工具定义全局复用；每个用户回合只绑定自己的数据和回调。 */
export function createVideoTools(speakerIds: string[], prior: VideoResult | undefined, {
  inspectFaces, shownCandidateIds = [], onSpeakerUpdate, onSummaryUpdate
}: VideoToolOptions) {
  // 用本段转写建立说话人初始状态；追问时继承已有标签、摘要和头像。
  const defaultSpeakers = Object.fromEntries(speakerIds.map(id => [id, '未知发言人']));
  const emptyFaces = Object.fromEntries(speakerIds.map(id => [id, null]));
  const current: VideoResult = {
    speakers: { ...defaultSpeakers, ...prior?.speakers }, summary: prior?.summary ?? '',
    ...(prior?.faces ? { faces: { ...emptyFaces, ...prior.faces } } : {})
  };
  // 截图按工具调用 ID 暂存；只有附到模型请求后，候选 ID 才视为已展示。
  const pendingImages = new Map<string, CandidateFrame[]>();
  const inspectedRanges = new Set<string>();
  const shown = new Set(shownCandidateIds);
  const context: ToolContext = {
    speakerIds: new Set(speakerIds), current, emptyFaces, pendingImages, inspectedRanges,
    shown, inspectFaces, onSpeakerUpdate, onSummaryUpdate
  };
  // Pi 的工具接口接收本次调用参数；在这里把任务上下文绑定进去。
  const tools = toolDefinitions.filter(tool => tool.name !== 'inspect_faces' || inspectFaces)
    .map(({ execute, ...definition }) => ({
      ...definition,
      execute: (id: string, args: any, signal?: AbortSignal) => execute(context, id, args, signal)
    }));
  return {
    tools,
    getResult: () => context.current,
    // 截图只交给紧接着的一次模型请求；取出后即删除，不写入工具结果或消息快照。
    takeImages(toolCallId: string) {
      const frames = pendingImages.get(toolCallId);
      if (!frames) return;
      pendingImages.delete(toolCallId);
      for (const frame of frames) for (const face of frame.faces) shown.add(face.candidateId);
      return frames;
    }
  };
}
