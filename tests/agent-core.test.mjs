import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, assertTransition } from '../dist/agent/core/task-machine.js';
import { InMemoryJobQueue } from '../dist/agent/core/job-queue.js';
import { InMemoryQaSessionStore } from '../dist/agent/core/session-store.js';

test('任务状态机只允许定义好的转移，终态不可回退', () => {
  assert.equal(canTransition('receiving_audio', 'transcribing'), true);
  assert.equal(canTransition('analyzing', 'completed'), true);
  assert.equal(canTransition('completed', 'analyzing'), false);
  assert.throws(() => assertTransition('completed', 'failed'), /不允许/);
});

test('内存队列限制并发并在任务完成后继续消费', async () => {
  const queue = new InMemoryJobQueue(1);
  let running = 0;
  let peak = 0;
  const jobs = Array.from({ length: 3 }, (_, index) => new Promise(resolve => {
    queue.enqueue({ id: String(index), run: async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(done => setImmediate(done));
      running--;
      resolve();
    } });
  }));
  await Promise.all(jobs);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak, 1);
  assert.equal(queue.active, 0);
});

test('问答会话与一次性分析任务独立，过期后不可继续追加', async () => {
  const store = new InMemoryQaSessionStore();
  const session = await store.create({ taskId: 'task-1', expiresAt: Date.now() + 1000 });
  await store.appendTurn(session.id, { role: 'user', content: '问题', createdAt: Date.now() });
  assert.equal((await store.get(session.id)).turns.length, 1);
  await store.expire(session.id);
  assert.equal(await store.get(session.id), undefined);
});
