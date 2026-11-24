/** 任务文件持久化：只负责读写 JSON，不参与任务业务状态流转。 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Task } from './types.js';

export interface TaskStoreOptions {
  root: string;
  directory?: string;
}

export class TaskStore {
  readonly directory: string;
  readonly taskDirectory: string;

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

  /** 原子替换任务文件，避免进程中断时留下半个 JSON。 */
  save(task: Task): void {
    const target = this.pathFor(task.id);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(task), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
  }

  /** messages 只保存最近一次快照；调试内容过大时截断，避免无限增长。 */
  saveMessages(id: string, messages: unknown): void {
    const serialized = JSON.stringify(messages);
    // 截断必须仍然是合法 JSON，否则重启后的调试工具无法读取快照。
    const bounded = serialized.length > 2_000_000
      ? JSON.stringify({ truncated: true, originalBytes: Buffer.byteLength(serialized) })
      : serialized;
    const target = this.pathFor(id, '.messages.json');
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, bounded, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
  }

  /** 启动时隔离损坏任务文件，单个坏文件不应阻断整个服务。 */
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

  /** 删除任务的附属文件；历史任务 GC 由上层按 TTL 调用。 */
  remove(id: string): void {
    for (const suffix of ['.json', '.events.jsonl', '.messages.json']) {
      try { unlinkSync(this.pathFor(id, suffix)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
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
