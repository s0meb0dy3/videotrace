/**
 * 交互式问答会话的最小持久化抽象。
 * 首版只定义接口，不与一次性视频分析任务混用；后续可实现 FS/SQLite 存储。
 */
import { randomUUID } from 'node:crypto';
import type { QaSession, QaTurn } from '../contracts.js';

export interface QaSessionStore {
  create(input: Pick<QaSession, 'taskId' | 'expiresAt'>): Promise<QaSession>;
  get(id: string): Promise<QaSession | undefined>;
  appendTurn(id: string, turn: QaTurn): Promise<QaSession>;
  expire(id: string): Promise<void>;
}

export class InMemoryQaSessionStore implements QaSessionStore {
  private readonly sessions = new Map<string, QaSession>();

  async create(input: Pick<QaSession, 'taskId' | 'expiresAt'>): Promise<QaSession> {
    const now = Date.now();
    const session: QaSession = { id: randomUUID(), taskId: input.taskId, createdAt: now, updatedAt: now, expiresAt: input.expiresAt, turns: [] };
    this.sessions.set(session.id, session);
    return structuredClone(session);
  }

  async get(id: string): Promise<QaSession | undefined> {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) return undefined;
    return structuredClone(session);
  }

  async appendTurn(id: string, turn: QaTurn): Promise<QaSession> {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) throw new Error('问答会话已过期');
    session.turns.push(turn);
    session.updatedAt = Date.now();
    return structuredClone(session);
  }

  async expire(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}
