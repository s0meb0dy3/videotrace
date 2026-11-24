import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider, startObservation } from '@langfuse/tracing';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';

type Env = Record<string, string | undefined>;
type Observation = any;
export interface TraceScope {
  child(name: string, data?: Record<string, unknown>, asType?: string): TraceScope | undefined;
  end(status: string, data?: Record<string, unknown>): void;
}
export interface Tracing {
  start(name: string, data?: Record<string, unknown>): TraceScope;
  shutdown(): Promise<void>;
}

/** 从 .env 和进程环境初始化 Langfuse，缺少任一密钥时保持禁用。 */
export function initializeTracing(root: string, env: Env = process.env): Tracing | undefined {
  let config: Record<string, string | undefined> = {};
  try {
    config = parseEnv(readFileSync(join(root, '.env'), 'utf8')) as Record<string, string | undefined>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  config = { ...config, ...env };
  const publicKey = config.LANGFUSE_PUBLIC_KEY;
  const secretKey = config.LANGFUSE_SECRET_KEY;
  const baseUrl = config.LANGFUSE_BASE_URL || config.LANGFUSE_HOST;
  if (!publicKey || !secretKey || !baseUrl) return undefined;
  const processor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl,
    environment: config.LANGFUSE_TRACING_ENVIRONMENT || 'development', mediaUploadEnabled: false });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  setLangfuseTracerProvider(provider);
  return { start: (name, data) => scope(startObservation(name, data)), shutdown: () => provider.shutdown() };
}

// 跨 HTTP 请求保留父子关系；取消/超时立即结束尚未完成的观测。
function scope(observation: Observation, onEnd?: () => void): TraceScope {
  const children = new Set<TraceScope>();
  let ended = false;
  return {
    child(name, data, asType = 'span') {
      if (ended) return undefined;
      let child: TraceScope;
      child = scope(observation.startObservation(name, data, { asType }), () => children.delete(child));
      children.add(child);
      return child;
    },
    end(status, data = {}) {
      if (ended) return;
      ended = true;
      for (const child of children) child.end(status);
      observation.update({ ...data, level: status === 'completed' ? 'DEFAULT' : status === 'cancelled' ? 'WARNING' : 'ERROR', statusMessage: status });
      observation.end();
      onEnd?.();
    }
  };
}

export function documentStats(document: { cues: Array<{ speakerId?: string | null }> }): { cueCount: number; speakerCount: number } {
  const { cues } = document;
  return { cueCount: cues.length, speakerCount: new Set(cues.map(cue => cue.speakerId ?? 'unknown')).size };
}

export function resultStats(result: { speakers: Record<string, unknown>; summary: string }): { speakerCount: number; summaryChars: number } {
  return { speakerCount: Object.keys(result.speakers).length, summaryChars: result.summary.length };
}
