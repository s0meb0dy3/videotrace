/** 兼容旧导入路径；核心 schema 已迁移到 core/schema.ts。 */
export { prepareDocument, validateResult } from './core/schema.js';
export type { Cue, PreparedDocument, AnalysisResult } from './core/schema.js';
export type { Cue as DocumentCue, AnalysisResult as VideoResult } from './core/schema.js';
export type VideoDocument = { cues: Array<{ id: string; speakerId?: string | number | null; startMs: number; endMs: number; text: string }>; [key: string]: unknown };
