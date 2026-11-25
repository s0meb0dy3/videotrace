/**
 * 任务生命周期管理：集中处理状态更新、终态冻结和重启恢复。
 * HTTP 层不应自行拼接状态字符串，所有 worker 都通过这里变更任务。
 */
import type { EventLog } from './event-log.js';
import type { AgentEvent, Task, TaskStatus } from './types.js';
import { isTerminalStatus } from './types.js';
import { canTransition } from './task-machine.js';
import type { TaskStore } from './task-store.js';

export interface TaskManagerOptions {
  store: TaskStore;
  events: EventLog;
  onEvent?: (id: string, event: AgentEvent) => void | Promise<void>;
  onFinish?: (task: Task, status: TaskStatus, result?: unknown, error?: string) => void | Promise<void>;
}

export class TaskManager {
  readonly tasks = new Map<string, Task>();
  private readonly lanes = new Map<string, Promise<void>>();
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
      if (!isTerminalStatus(task.status)) {
        task.status = 'failed';
        task.error = '服务重启，任务已中断';
        delete task.result;
        task.updatedAt = Date.now();
        this.store.save(task);
        const event = this.events.append(task.id, 'status', { status: task.status, error: task.error });
        void this.onEvent?.(task.id, event);
      }
    }
    return [...this.tasks.values()];
  }

  async addAsync(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
    this.events.initialize(task.id);
    await this.store.saveAsync(task);
  }

  publishAsync(id: string, type: string, data: unknown): Promise<AgentEvent> {
    return this.enqueue(id, async () => {
      const event = await this.events.appendAsync(id, type, data);
      await this.onEvent?.(id, event);
      return event;
    });
  }

  updateStatusAsync(task: Task, status: TaskStatus): Promise<boolean> {
    return this.enqueue(task.id, async () => {
      if (isTerminalStatus(task.status) || !canTransition(task.status, status)) return false;
      task.status = status;
      task.updatedAt = Date.now();
      await this.store.saveAsync(task);
      const event = await this.events.appendAsync(task.id, 'status', { status });
      await this.onEvent?.(task.id, event);
      return true;
    });
  }

  finishAsync(task: Task, status: Extract<TaskStatus, 'completed' | 'failed' | 'cancelled' | 'timed_out'>, result?: unknown, error?: string): Promise<boolean> {
    if (isTerminalStatus(task.status) || !canTransition(task.status, status)) return Promise.resolve(false);
    task.status = status;
    task.updatedAt = Date.now();
    if (result !== undefined) task.result = result as Task['result']; else delete task.result;
    if (error !== undefined) task.error = error; else delete task.error;
    const eventData = { status, ...(task.result ? { result: task.result } : {}), ...(error ? { error } : {}) };
    return this.enqueue(task.id, async () => {
      await this.store.saveAsync(task);
      const event = await this.events.appendAsync(task.id, 'status', eventData);
      await this.onEvent?.(task.id, event);
      await this.onFinish?.(task, status, result, error);
      return true;
    });
  }

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    const lane = next.then(() => {}, () => {});
    this.lanes.set(id, lane);
    lane.finally(() => {
      if (this.lanes.get(id) === lane) this.lanes.delete(id);
    }).catch(() => {});
    return next;
  }
}
