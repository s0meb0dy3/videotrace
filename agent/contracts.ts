/**
 * Agent 后端的稳定扩展契约。
 *
 * 这里刻意不放 B 站或 YouTube 的页面细节：平台适配器负责把页面数据
 * 转换为统一的 VideoContext/Document，任务服务只处理统一模型。
 */
import type { AnalysisResult, PreparedDocument } from './core/schema.js';

export type Platform = 'bilibili' | 'youtube' | 'uploaded';

export interface VideoContext {
  platform: Platform;
  key: string;
  title?: string;
  description?: string;
  channelName?: string;
  videoId?: string;
  part?: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface VideoSourceAdapter {
  readonly platform: Platform;
  supports(context: VideoContext): boolean;
  resolveMetadata(context: VideoContext, signal?: AbortSignal): Promise<VideoContext>;
  /** 音频由扩展在页面环境取得；服务端不接收任意 URL。 */
  acceptAudio(context: VideoContext, signal?: AbortSignal): Promise<{ mimeType: string; size: number }>;
}

export interface AnalysisDocument {
  context: VideoContext;
  prepared: PreparedDocument;
  raw?: unknown;
}

export interface TranscriptSnippet {
  cueId: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptRetriever {
  search(document: AnalysisDocument, question: string, limit?: number): Promise<TranscriptSnippet[]>;
}

export interface QaTurn {
  role: 'user' | 'assistant';
  content: string;
  citations?: Array<Pick<TranscriptSnippet, 'cueId' | 'startMs' | 'endMs'>>;
  createdAt: number;
}

export interface QaSession {
  id: string;
  taskId: string;
  createdAt: number;
  updatedAt: number;
  turns: QaTurn[];
  expiresAt: number;
}

export interface QuestionAnswerer {
  answer(input: {
    document: AnalysisDocument;
    question: string;
    history: QaTurn[];
    snippets: TranscriptSnippet[];
    signal?: AbortSignal;
  }): Promise<{ answer: string; citations: QaTurn['citations'] }>;
}

export type { AnalysisResult };
