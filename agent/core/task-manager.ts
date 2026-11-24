/**
 * 任务生命周期管理：集中处理状态更新、终态冻结和重启恢复。
 * HTTP 层不应自行拼接状态字符串，所有 worker 都通过这里变更任务。
 */
import type { EventLog } from './event-log.js';
import type { Task, TaskStatus } from './types.js';
import { isTerminalStatus } from './types.js';
import { canTransition } from './task-machine.js';
import type { TaskStore } from './task-store.js';

export interface TaskManagerOptions {
  store: TaskStore;
  events: EventLog;
  onEvent?: (id: string, type: string, data: unknown) => void;
  onFinish?: (task: Task, status: TaskStatus, result?: unknown, error?: string) => void;
}

export class TaskManager {
  readonly tasks = new Map<string, Task>();
  private readonly active = new Map<string, AbortController>();
  private readonly store: TaskStore;
  private readonly events: EventLog;
  private readonly onEvent?: TaskManagerOptions['onEvent'];
  private readonly onFinish?: TaskManagerOptions['onFinish'];

  constructor(options: TaskManagerOptions) {
    this.store = options.store;
    this.events = options.events;
    this.onEvent = options.onEvent;
    this.onFinish = options.onFinish;
  }

  load(): Task[] {
    for (const task of this.store.loadTasks()) {
      this.tasks.set(task.id, task);
      this.events.load(task.id);
      // 已经产生过收费请求的中间阶段不自动重放，避免重启后重复计费。
      if (!isTerminalStatus(task.status)) {
        task.status = 'failed';
        task.error = '服务重启，任务已中断';
        delete task.result;
        task.updatedAt = Date.now();
        this.store.save(task);
        const data = { status: task.status, error: task.error };
        this.events.append(task.id, 'status', data);
        this.onEvent?.(task.id, 'status', data);
      }
    }
    return [...this.tasks.values()];
  }

  add(task: Task): void {
    this.tasks.set(task.id, task);
    this.events.initialize(task.id);
    this.store.save(task);
  }

  get(id: string): Task | undefined { return this.tasks.get(id); }
  all(): Task[] { return [...this.tasks.values()]; }
  save(task: Task): void { this.store.save(task); }
  publish(id: string, type: string, data: unknown): void { this.events.append(id, type, data); }

  updateStatus(task: Task, status: TaskStatus): boolean {
    if (isTerminalStatus(task.status) || !canTransition(task.status, status)) return false;
    task.status = status;
    task.updatedAt = Date.now();
    this.store.save(task);
    const data = { status };
    this.events.append(task.id, 'status', data);
    this.onEvent?.(task.id, 'status', data);
    return true;
  }

  begin(task: Task): AbortController {
    const controller = new AbortController();
    this.active.set(task.id, controller);
    return controller;
  }

  controller(id: string): AbortController | undefined { return this.active.get(id); }

  finish(task: Task, status: Extract<TaskStatus, 'completed' | 'failed' | 'cancelled' | 'timed_out'>, result?: unknown, error?: string): boolean {
    if (isTerminalStatus(task.status) || !canTransition(task.status, status)) return false;
    task.status = status;
    task.updatedAt = Date.now();
    if (result !== undefined) task.result = result as Task['result']; else delete task.result;
    if (error !== undefined) task.error = error; else delete task.error;
    this.store.save(task);
    const data = { status, ...(task.result ? { result: task.result } : {}), ...(error ? { error } : {}) };
    this.events.append(task.id, 'status', data);
    this.onEvent?.(task.id, 'status', data);
    this.onFinish?.(task, status, result, error);
    return true;
  }

  removeActive(id: string): void { this.active.delete(id); }

  cancel(task: Task): boolean {
    const changed = this.finish(task, 'cancelled');
    if (changed) this.active.get(task.id)?.abort();
    return changed;
  }

  abortAll(): void {
    for (const [id, controller] of this.active) {
      const task = this.tasks.get(id);
      if (task && !isTerminalStatus(task.status)) this.finish(task, 'cancelled');
      controller.abort();
    }
    this.active.clear();
  }
}
