/** 任务文件持久化：只负责读写 JSON，不参与任务业务状态流转。 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { chmod, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Task } from './types.js';

export interface TaskStoreOptions {
  root: string;
  directory?: string;
}

export class TaskStore {
  readonly directory: string;
  readonly taskDirectory: string;
  private readonly lanes = new Map<string, Promise<void>>();

  constructor({ root, directory = '.private/agent' }: TaskStoreOptions) {
    this.directory = resolve(root, directory);
    this.taskDirectory = join(this.directory, 'tasks');
    mkdirSync(this.taskDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.directory, 'uploads'), { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    chmodSync(this.taskDirectory, 0o700);
    chmodSync(join(this.directory, 'uploads'), 0o700);
  }

  pathFor(id: string, suffix = '.json'): string {
    return join(this.taskDirectory, `${id}${suffix}`);
  }

  /** 同步保存仅供启动恢复等同步代码；HTTP 热路径使用 saveAsync。 */
  save(task: Task): void {
    const target = this.pathFor(task.id);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(task), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
  }

  saveAsync(task: Task): Promise<void> {
    const serialized = JSON.stringify(task);
    return this.enqueue(task.id, () => this.atomicWrite(this.pathFor(task.id), serialized));
  }

  saveMessagesAsync(id: string, messages: unknown): Promise<void> {
    const serialized = JSON.stringify(messages);
    const bounded = serialized.length > 2_000_000
      ? JSON.stringify({ truncated: true, originalBytes: Buffer.byteLength(serialized) })
      : serialized;
    return this.enqueue(id, () => this.atomicWrite(this.pathFor(id, '.messages.json'), bounded));
  }

  appendEventAsync(id: string, event: unknown): Promise<void> {
    const serialized = `${JSON.stringify(event)}\n`;
    return this.enqueue(id, () => writeFile(this.pathFor(id, '.events.jsonl'), serialized, { flag: 'a', mode: 0o600 }));
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, content, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private enqueue(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.lanes.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.lanes.set(id, next);
    next.then(() => {
      if (this.lanes.get(id) === next) this.lanes.delete(id);
    }, () => {
      if (this.lanes.get(id) === next) this.lanes.delete(id);
    });
    return next;
  }

  flush(id: string): Promise<void> { return this.lanes.get(id) || Promise.resolve(); }

  async flushAll(): Promise<void> {
    while (this.lanes.size) await Promise.all([...this.lanes.values()]);
  }

  loadTasks(): Task[] {
    const tasks: Task[] = [];
    for (const name of readdirSync(this.taskDirectory).filter(name => /^[\da-f-]{36}\.json$/.test(name))) {
      const path = join(this.taskDirectory, name);
      try {
        const task = JSON.parse(readFileSync(path, 'utf8')) as Task;
        if (!task || task.id !== name.slice(0, -5)) throw new Error('任务文件无效');
        tasks.push(task);
      } catch {
        renameSync(path, `${path}.corrupt-${Date.now()}`);
      }
    }
    return tasks;
  }

  async removeAsync(id: string): Promise<void> {
    await this.enqueue(id, async () => {
      for (const suffix of ['.json', '.events.jsonl', '.messages.json']) {
        await unlink(this.pathFor(id, suffix)).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
    });
  }

  readEvents(id: string): unknown[] {
    try {
      const text = readFileSync(this.pathFor(id, '.events.jsonl'), 'utf8').trim();
      return text ? text.split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      }) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

}
