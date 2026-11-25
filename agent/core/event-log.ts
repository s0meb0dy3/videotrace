/** 任务事件日志：内存中提供回放，并按 JSONL 追加到磁盘。 */
import { appendFileSync } from 'node:fs';
import type { AgentEvent, Sanitizer } from './types.js';
import type { TaskStore } from './task-store.js';

export class EventLog {
  private readonly events = new Map<string, AgentEvent[]>();
  private readonly nextIds = new Map<string, number>();
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

  list(id: string): AgentEvent[] { return this.events.get(id) || []; }

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

  /** 启动恢复阶段使用的同步追加；HTTP 热路径使用 appendAsync。 */
  append(id: string, type: string, data: unknown): AgentEvent {
    const event = this.create(id, type, data);
    appendFileSync(this.store.pathFor(id, '.events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    this.remember(id, event);
    return event;
  }

  /** 异步追加；同一任务的事件严格按调用顺序写入。 */
  appendAsync(id: string, type: string, data: unknown): Promise<AgentEvent> {
    const previous = this.asyncLanes.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const event = this.create(id, type, data);
      await this.store.appendEventAsync(id, event);
      this.remember(id, event);
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

  async removeAsync(id: string): Promise<void> {
    await this.store.removeAsync(id);
    this.events.delete(id);
    this.nextIds.delete(id);
    this.asyncLanes.delete(id);
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
}
