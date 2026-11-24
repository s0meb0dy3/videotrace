/**
 * 纯状态机：集中定义任务可以走向哪里。
 * 不接触文件和 HTTP，便于单元测试，也避免 worker 在不同地方写出非法状态。
 */
import type { TaskStatus } from './types.js';
import { isTerminalStatus } from './types.js';

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  receiving_audio: ['transcribing', 'cancelled', 'failed', 'timed_out'],
  queued: ['analyzing', 'cancelled', 'failed', 'timed_out'],
  transcribing: ['analyzing', 'cancelled', 'failed', 'timed_out'],
  analyzing: ['completed', 'cancelled', 'failed', 'timed_out'],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return !isTerminalStatus(from) && TASK_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`不允许的任务状态转移：${from} → ${to}`);
  }
}
