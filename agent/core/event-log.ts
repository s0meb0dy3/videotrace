/** 任务事件日志：内存中提供回放，并按 JSONL 追加到磁盘。 */
import { appendFileSync } from 'node:fs';
import type { AgentEvent, EventListener, Sanitizer } from './types.js';
import type { TaskStore } from './task-store.js';

export class EventLog {
  private readonly events = new Map<string, AgentEvent[]>();
  private readonly nextIds = new Map<string, number>();
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(
    private readonly store: TaskStore,
    private readonly sanitize: Sanitizer = value => value,
    private readonly maxEvents = 500,
  ) {}

  load(id: string): AgentEvent[] {
    const events = this.store.readEvents(id) as AgentEvent[];
    this.events.set(id, events.slice(-this.maxEvents));
    this.nextIds.set(id, events.reduce((max, event) => Math.max(max, event.id), 0) + 1);
    return this.events.get(id)!;
  }

  initialize(id: string, events: AgentEvent[] = []): void {
    this.events.set(id, events.slice(-this.maxEvents));
    this.nextIds.set(id, events.reduce((max, event) => Math.max(max, event.id), 0) + 1);
  }

  list(id: string): AgentEvent[] {
    return this.events.get(id) || [];
  }

  /**
   * 从磁盘按游标读取完整历史，避免内存窗口导致旧 SSE 无法重放。
   * 活跃连接仍优先使用内存事件，历史连接才触发一次磁盘读取。
   */
  replay(id: string, after = 0): AgentEvent[] {
    const saved = this.store.readEvents(id) as AgentEvent[];
    return (saved.length ? saved : this.list(id)).filter(event => event.id > after);
  }

  append(id: string, type: string, data: unknown): AgentEvent {
    const list = this.events.get(id) || [];
    const event: AgentEvent = {
      id: this.nextIds.get(id) ?? 1,
      type,
      data: this.sanitize(data),
      createdAt: Date.now(),
    };
    appendFileSync(this.store.pathFor(id, '.events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    list.push(event);
    // 内存只保留最近窗口，磁盘仍保留完整历史供旧客户端回放。
    if (list.length > this.maxEvents) list.splice(0, list.length - this.maxEvents);
    this.events.set(id, list);
    this.nextIds.set(id, event.id + 1);
    for (const listener of this.listeners.get(id) || []) listener(event);
    return event;
  }

  subscribe(id: string, listener: EventListener): () => void {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    const listeners = this.listeners.get(id)!;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }

  clearListeners(id: string): void {
    this.listeners.delete(id);
  }

  /** 任务 GC 时同时释放内存中的事件和订阅者。 */
  remove(id: string): void {
    this.events.delete(id);
    this.nextIds.delete(id);
    this.listeners.delete(id);
  }
}
