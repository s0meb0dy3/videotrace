/** 任务事件日志：内存中提供回放，并按 JSONL 追加到磁盘。 */
import { appendFileSync } from 'node:fs';
import type { AgentEvent, EventListener, Sanitizer } from './types.js';
import type { TaskStore } from './task-store.js';

export class EventLog {
  private readonly events = new Map<string, AgentEvent[]>();
  private readonly nextIds = new Map<string, number>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly asyncLanes = new Map<string, Promise<void>>();

  constructor(
    private readonly store: TaskStore,
    private readonly sanitize: Sanitizer = value => value,
    private readonly maxEvents = 500,
  ) {}

  load(id: string): AgentEvent[] {
    const events = this.store.readEvents(id).filter(EventLog.isValidEvent) as AgentEvent[];
    this.events.set(id, events.slice(-this.maxEvents));
    this.nextIds.set(id, events.reduce((max, event) => Math.max(max, event.id), 0) + 1);
    return this.events.get(id)!;
  }

  initialize(id: string, events: AgentEvent[] = []): void {
    const valid = events.filter(EventLog.isValidEvent);
    this.events.set(id, valid.slice(-this.maxEvents));
    this.nextIds.set(id, valid.reduce((max, event) => Math.max(max, event.id), 0) + 1);
  }

  list(id: string): AgentEvent[] {
    return this.events.get(id) || [];
  }

  /**
   * 从磁盘按游标读取完整历史，避免内存窗口导致旧 SSE 无法重放。
   * 活跃连接仍优先使用内存事件，历史连接才触发一次磁盘读取。
   */
  replay(id: string, after = 0): AgentEvent[] {
    const saved = this.store.readEvents(id).filter(EventLog.isValidEvent) as AgentEvent[];
    return EventLog.merge(saved, this.list(id)).filter(event => event.id > after);
  }

  async flush(id: string): Promise<void> {
    await this.store.flush(id);
    await this.asyncLanes.get(id);
  }

  async flushAll(): Promise<void> {
    while (this.asyncLanes.size) await Promise.all([...this.asyncLanes.values()]);
    await this.store.flushAll();
  }

  private static merge(saved: AgentEvent[], memory: AgentEvent[]): AgentEvent[] {
    const merged = new Map<number, AgentEvent>();
    for (const event of saved) merged.set(event.id, event);
    for (const event of memory) merged.set(event.id, event);
    return [...merged.values()].sort((a, b) => a.id - b.id);
  }

  private static isValidEvent(value: unknown): value is AgentEvent {
    if (!value || typeof value !== 'object') return false;
    const event = value as Partial<AgentEvent>;
    return Number.isSafeInteger(event.id) && event.id > 0
      && typeof event.type === 'string' && event.type.length > 0
      && typeof event.createdAt === 'number' && Number.isFinite(event.createdAt)
      && 'data' in event;
  }

  append(id: string, type: string, data: unknown): AgentEvent {
    const event = this.create(id, type, data);
    appendFileSync(this.store.pathFor(id, '.events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    this.remember(id, event);
    this.notify(id, event);
    return event;
  }

  /** 异步追加；同一任务的事件严格按调用顺序写入。 */
  appendAsync(id: string, type: string, data: unknown): Promise<AgentEvent> {
    const previous = this.asyncLanes.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const event = this.create(id, type, data);
      await this.store.appendEventAsync(id, event);
      this.remember(id, event);
      this.notify(id, event);
      return event;
    });
    const lane = operation.then(() => {}, () => {});
    this.asyncLanes.set(id, lane);
    lane.finally(() => {
      if (this.asyncLanes.get(id) === lane) this.asyncLanes.delete(id);
    }).catch(() => {});
    return operation;
  }

  private create(id: string, type: string, data: unknown): AgentEvent {
    return { id: this.nextIds.get(id) ?? 1, type, data: this.sanitize(data), createdAt: Date.now() };
  }

  private remember(id: string, event: AgentEvent): void {
    const list = this.events.get(id) || [];
    list.push(event);
    if (list.length > this.maxEvents) list.splice(0, list.length - this.maxEvents);
    this.events.set(id, list);
    this.nextIds.set(id, event.id + 1);
  }

  private notify(id: string, event: AgentEvent): void {
    for (const listener of this.listeners.get(id) || []) listener(event);
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
    this.asyncLanes.delete(id);
  }

  async removeAsync(id: string): Promise<void> {
    await this.store.removeAsync(id);
    this.remove(id);
  }
}
