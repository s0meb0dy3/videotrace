/** Agent 后端共享数据类型。运行时数据仍保持 JSON 兼容，便于与旧版客户端互通。 */

export type TaskStatus =
  | 'receiving_audio'
  | 'queued'
  | 'transcribing'
  | 'analyzing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface Task {
  id: string;
  status: TaskStatus;
  mode: 'analyze';
  context?: JsonObject;
  document?: JsonObject;
  prompt?: string;
  inspectFaces?: boolean;
  result?: JsonObject;
  error?: string;
  createdAt: number;
  updatedAt: number;
  [key: string]: unknown;
}

export interface AgentEvent {
  id: number;
  type: string;
  data: unknown;
  createdAt: number;
}

export type EventListener = (event: AgentEvent) => void;
export type Sanitizer = (value: unknown) => unknown;

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'timed_out',
];

export function isTerminalStatus(status: string): status is Extract<TaskStatus, 'completed' | 'failed' | 'cancelled' | 'timed_out'> {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
