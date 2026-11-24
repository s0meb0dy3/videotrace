/**
 * 单进程有界任务队列。
 *
 * 当前 Agent 是本地单进程服务，因此先用内存队列控制并发；
 * 将来需要跨进程恢复时，可在不改变 Job 接口的前提下替换为 SQLite/文件队列。
 */
export interface Job {
  id: string;
  run: () => Promise<void> | void;
}

export class InMemoryJobQueue {
  private readonly pending: Job[] = [];
  private running = 0;
  private stopped = false;

  constructor(private readonly concurrency = 2) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error('队列并发数必须为正整数');
    }
  }

  get size(): number {
    return this.pending.length;
  }

  get active(): number {
    return this.running;
  }

  enqueue(job: Job): void {
    if (this.stopped) throw new Error('任务队列已停止');
    this.pending.push(job);
    this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.pending.length = 0;
  }

  private drain(): void {
    while (!this.stopped && this.running < this.concurrency && this.pending.length) {
      const job = this.pending.shift()!;
      this.running++;
      Promise.resolve()
        .then(job.run)
        .catch(() => {
          // 任务自身负责把失败写入任务状态；队列只负责释放并发槽位。
        })
        .finally(() => {
          this.running--;
          this.drain();
        });
    }
  }
}
