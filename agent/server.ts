// 兼容旧 HTTP 合同的 TypeScript 实现；外部请求格式保持不变。
// HTTP 胶水层只负责协议转换，领域状态和持久化由 core 模块负责。
// 这里保留少量 any 是为了兼容现有注入式 provider；领域层保持严格类型。
import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createWebSearch } from './web-search.js';
import { documentStats, initializeTracing, resultStats } from './tracing.js';
import { open, unlink } from 'node:fs/promises';
import { loadBailianApiKey, transcribeAudioFile } from './asr-service.js';
import { prepareDocument, validateResult } from './document.js';
import { createFaceBroker } from './face-broker.js';
import { loadApiKey, runPiTask } from './runner.js';
import { translationBatches, translateBatches } from './translate.js';
import { TaskStore } from './core/task-store.js';
import { EventLog } from './core/event-log.js';
import { TaskManager } from './core/task-manager.js';
import type { AgentServer, CreateServerOptions } from './server-types.js';
import { InMemoryJobQueue } from './core/job-queue.js';
import { BodyTooLargeError, readRequestBody } from './http-body.js';
import { SseHub } from './core/sse-hub.js';

const terminal = (status: string) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(status);
const json = (response: http.ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };

// 只保存经过清理的 Pi 事件和消息，绝不持久化 provider 的原始报错。
function clean(value: unknown, secrets: Array<string | undefined>): any {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (['errorMessage', 'stack', 'headers', 'apiKey', 'authorization'].includes(key)) return '[已隐藏]';
    if (typeof item === 'string') {
      for (const secret of secrets) if (secret) item = item.split(secret).join('[已隐藏]');
    }
    return item;
  }));
}

export async function createServer({ root = process.cwd(), port = 43127, runner = runPiTask, asrRunner = transcribeAudioFile, apiKey, bailianApiKey, searchApiKey, tracing, timeoutMs = 120_000, asrTimeoutMs = 30 * 60_000, maxAudioBytes = 512 * 1024 ** 2, maxTurns, maxToolCalls = 15, translationFetch = fetch, translationTimeoutMs = 120_000, maxTasks = 500, maxConcurrentTasks = 2, audioReceiveTimeoutMs = 10 * 60_000, taskRetentionMs = 7 * 24 * 60 * 60 * 1000, requestTimeoutMs = 5 * 60_000, audioIdleTimeoutMs = 5 * 60_000 }: CreateServerOptions = {}): Promise<AgentServer> {
  const directory = resolve(root, '.private/agent');
  const taskDirectory = join(directory, 'tasks');
  mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  chmodSync(taskDirectory, 0o700);
  const uploadDirectory = join(directory, 'uploads');
  mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });
  chmodSync(uploadDirectory, 0o700);
  apiKey ??= await loadApiKey(root);
  bailianApiKey ??= await loadBailianApiKey(root);
  searchApiKey ??= process.env.DEEPSEEK_SEARCH_API_KEY || apiKey;
  if (!searchApiKey) {
    try { searchApiKey = parseEnv(readFileSync(join(root, '.env'), 'utf8')).DEEPSEEK_SEARCH_API_KEY || apiKey; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const webSearch = createWebSearch(searchApiKey);
  const token = randomBytes(32).toString('hex');
  const secrets = [apiKey, bailianApiKey, searchApiKey, token];
  const active = new Map();
  const queue = new InMemoryJobQueue(maxConcurrentTasks);
  const traces = new Map();
  const faceBrokers = new Map();
  const uploads = new Set();
  const receiveTimers = new Map();
  const sse = new SseHub();
  // TaskStore/EventLog/TaskManager 形成领域层，HTTP 只负责协议转换和流式输出。
  const store = new TaskStore({ root });
  const eventLog = new EventLog(store, value => clean(value, secrets), 500);
  const manager = new TaskManager({
    store,
    events: eventLog,
    onEvent: (id, event) => sse.broadcast(id, event),
  });
  const tasks = manager.tasks;
  const publish = (id, type, data) => manager.publishAsync(id, type, data);
  manager.load();
  // 启动时清理过期终态任务，避免本地字幕、事件和模型消息无限增长。
  const pruneExpiredTasks = () => {
    const cutoff = Date.now() - taskRetentionMs;
    for (const task of [...tasks.values()]) {
      if (!terminal(task.status) || task.updatedAt > cutoff) continue;
      void eventLog.removeAsync(task.id).catch(() => {});
      tasks.delete(task.id);
    }
  };
  pruneExpiredTasks();
  const pruneTimer = setInterval(pruneExpiredTasks, Math.min(taskRetentionMs, 60 * 60 * 1000));
  pruneTimer.unref();
  async function finish(task, status, result = undefined, error = undefined) {
    if (!task) return;
    clearTimeout(receiveTimers.get(task.id));
    receiveTimers.delete(task.id);
    const changed = await manager.finishAsync(task, status, result ? clean(result, secrets) : undefined, error);
    if (!changed) return;
    traces.get(task.id)?.end(status, { output: { status, ...(result && resultStats(result)) } });
    traces.delete(task.id);
    sse.close(task.id);
  }
  function updateStatus(task, status) {
    return manager.updateStatusAsync(task, status);
  }
  function runTask(task, audioPath?: string): Promise<void> {
    // 队列等待期间可能已经被取消；终态任务不能再次启动 provider。
    // 同时清理尚未进入 provider 的临时音频，避免取消造成磁盘泄漏。
    if (terminal(task.status)) {
      if (audioPath) void unlink(audioPath).catch(() => {});
      return;
    }
    const controller = new AbortController();
    const trace = traces.get(task.id);
    active.set(task.id, controller);
    const broker = task.inspectFaces ? createFaceBroker(data => publish(task.id, 'capture_faces', data), controller.signal) : undefined;
    if (broker) faceBrokers.set(task.id, broker);
    let timer;
    const startTimer = (ms, message) => {
      clearTimeout(timer);
      timer = setTimeout(() => { finish(task, 'timed_out', null, message); controller.abort(); }, ms);
      timer.unref();
    };
    return Promise.resolve().then(async () => {
      await updateStatus(task, audioPath ? 'transcribing' : 'analyzing');
      startTimer(audioPath ? asrTimeoutMs : timeoutMs, audioPath ? '转写超过30分钟时限' : '分析超过时限');
      if (audioPath) {
        const asr = trace?.child('transcribe-audio', { input: { provider: 'bailian' } });
        let document;
        try {
          document = await asrRunner({ audioPath, context: structuredClone(task.context), apiKey: bailianApiKey, signal: controller.signal });
          if (terminal(task.status)) return;
          prepareDocument(document);
          asr?.end('completed', { output: documentStats(document) });
        } catch (error) {
          asr?.end('failed');
          throw error;
        }
        task.document = clean(document, secrets);
        await updateStatus(task, 'analyzing');
        startTimer(timeoutMs, '分析超过时限');
      }
      if (terminal(task.status)) return;
      const analysis = trace?.child('analyze-transcript', { input: documentStats(task.document) }, 'agent');
      try {
        const result = await runner({
          document: structuredClone(task.document), prompt: task.prompt, signal: controller.signal, apiKey, webSearch, inspectFaces: broker?.inspect, trace: analysis, maxTurns, maxToolCalls,
          onEvent: event => { if (!terminal(task.status)) publish(task.id, 'pi', event); },
          onMessages: messages => { if (!terminal(task.status)) return store.saveMessagesAsync(task.id, clean(messages, secrets)); }
        });
        if (terminal(task.status)) return;
        const validated = validateResult(result, prepareDocument(task.document));
        if (Object.values(validated.faces || {}).some(id => id !== null && !broker?.candidates.has(id))) throw new Error('无效头像候选');
        analysis?.end('completed', { output: resultStats(validated) });
        await finish(task, 'completed', validated);
      } catch (error) {
        analysis?.end('failed');
        throw error;
      }
    }).catch(() => {
      // HTTP / SSE / 磁盘上仅出现固定错误，不泄露 SDK、路径或凭证。
      if (!terminal(task.status)) void finish(task, 'failed', null, '分析失败，请检查本地配置或稍后重试');
    }).finally(async () => {
      clearTimeout(timer); active.delete(task.id); faceBrokers.delete(task.id);
      if (audioPath) await unlink(audioPath).catch(() => {});
    });
  }
  const server = http.createServer(async (request, response) => {
    const requestTimer = setTimeout(() => {
      if (!response.headersSent) json(response, 408, { error: '请求处理超时' });
      request.destroy();
    }, requestTimeoutMs);
    requestTimer.unref();
    response.once('close', () => clearTimeout(requestTimer));
    try {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}` ].includes(request.headers.host)) return json(response, 403, { error: 'Host 不允许' });
      const origin = request.headers.origin;
      const url = new URL(request.url, 'http://127.0.0.1');
      if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return json(response, 403, { error: 'Origin 不允许' });
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      // 只有扩展来源可领取本次启动的本地连接凭据。
      if (request.method === 'POST' && url.pathname === '/connection') {
        if (!origin) return json(response, 403, { error: '需要扩展 Origin' });
        return json(response, 200, { url: typedServer.connection.url, token });
      }
      // 浏览器预检不含 bearer；它不是业务请求，后续每个接口仍需鉴权。
      if (request.method === 'OPTIONS') {
        if (!origin) return json(response, 403, { error: '需要扩展 Origin' });
        response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID', 'Access-Control-Max-Age': '600' });
        return response.end();
      }
      const authorization = request.headers.authorization || '';
      const expected = `Bearer ${token}`;
      if (Buffer.byteLength(authorization) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) return json(response, 401, { error: '未授权' });
      if (request.method === 'POST' && url.pathname === '/translate') {
        const maxBytes = 1024 ** 2;
        if (Number(request.headers['content-length']) > maxBytes) return json(response, 413, { error: '翻译请求过大' });
        let batches;
        try {
          const body = JSON.parse((await readRequestBody(request, maxBytes)).toString('utf8'));
          batches = translationBatches(body.cues);
        } catch (error) {
          if (error instanceof BodyTooLargeError) return json(response, 413, { error: '翻译请求过大' });
          return json(response, 400, { error: '需要非空且 ID 唯一的翻译条目' });
        }
        const controller = new AbortController();
        response.once('close', () => controller.abort());
        if (response.destroyed) return;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(translationTimeoutMs)]);
        try {
          const result = await translateBatches(batches, { apiKey, signal, fetchImpl: translationFetch, concurrency: 3 });
          if (!response.destroyed) json(response, 200, result);
        } catch (error) {
          if (!response.destroyed) {
            const timedOut = error.name === 'TimeoutError' || signal.reason?.name === 'TimeoutError';
            json(response, timedOut ? 504 : 502, { error: timedOut ? '翻译超时，请重试' : '翻译失败，请稍后重试' });
          }
        }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/tasks') {
        let body;
        try {
          const raw = (await readRequestBody(request, 16 * 1024 * 1024)).toString('utf8');
          body = JSON.parse(raw);
          if (body.audio !== undefined || body.mode !== 'analyze' || (body.prompt !== undefined && typeof body.prompt !== 'string')) throw new Error();
          if (body.prompt !== undefined && body.prompt.length > 8_000) throw new Error();
          if (body.document !== undefined) { if (body.document.audio !== undefined) throw new Error(); prepareDocument(body.document); }
          else if (!body.context || typeof body.context !== 'object' || Array.isArray(body.context) || body.context.audio !== undefined || Buffer.byteLength(JSON.stringify(body.context)) > 256_000) throw new Error();
        } catch (error) {
          if (error instanceof BodyTooLargeError) return json(response, 413, { error: '请求过大' });
          return json(response, 400, { error: '需要有效 context 或 document、mode(analyze) 和可选字符串 prompt；音频请单独上传' });
        }
        pruneExpiredTasks();
        if (tasks.size >= maxTasks) return json(response, 429, { error: '任务队列已满，请稍后重试' });
        const task = clean({ id: randomUUID(), status: body.document ? 'queued' : 'receiving_audio', ...(body.document ? { document: body.document } : { context: body.context }), mode: body.mode, ...(body.inspectFaces === true ? { inspectFaces: true } : {}), ...(body.prompt !== undefined ? { prompt: body.prompt } : {}), createdAt: Date.now(), updatedAt: Date.now() }, secrets);
        await manager.addAsync(task);
         await publish(task.id, 'status', { status: task.status });
        if (task.status === 'receiving_audio') {
          const timer = setTimeout(() => {
            receiveTimers.delete(task.id);
            if (!terminal(task.status)) finish(task, 'timed_out', null, '等待音频上传超时');
          }, audioReceiveTimeoutMs);
          timer.unref();
          receiveTimers.set(task.id, timer);
        }
        if (tracing) traces.set(task.id, tracing.start('analyze-video', {
          metadata: { taskId: task.id }, input: task.document
            ? { source: 'cached-transcript', ...documentStats(task.document) } : { source: 'audio' }
        }));
        json(response, 202, { id: task.id, status: task.status });
        if (task.document) queue.enqueue({ id: task.id, run: () => runTask(task) });
        return;
      }
      const match = url.pathname.match(/^\/tasks\/([\da-f-]{36})(?:\/(events|cancel|audio|faces))?$/);
      const task = match && tasks.get(match[1]);
      if (!task) return json(response, 404, { error: '任务不存在' });
      if (request.method === 'GET' && !match[2]) return json(response, 200, task);
      if (request.method === 'POST' && match[2] === 'faces') {
        const broker = faceBrokers.get(task.id);
        if (!broker || task.status !== 'analyzing') return json(response, 409, { error: '采帧请求已结束' });
        try {
          const { requestId, frames } = JSON.parse((await readRequestBody(request, 1024 ** 2)).toString('utf8'));
          const accepted = broker.receive(requestId, frames);
          return json(response, accepted ? 200 : 409, { accepted });
        } catch { return json(response, 400, { error: '无效采帧结果' }); }
      }
      if (request.method === 'POST' && match[2] === 'audio') {
        clearTimeout(requestTimer);
        if (task.status !== 'receiving_audio' || uploads.has(task.id)) return json(response, 409, { error: '任务当前不能接收音频' });
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'audio/mp4') return json(response, 415, { error: '需要 Content-Type audio/mp4' });
        if (Number(request.headers['content-length']) > maxAudioBytes) return json(response, 413, { error: '音频超过上传限制' });
        const audioPath = join(uploadDirectory, `${task.id}.m4a`);
        uploads.add(task.id);
        const upload = traces.get(task.id)?.child('receive-audio');
        let file;
        let size = 0;
        let received = false;
        let idleTimer;
        let idleTimedOut = false;
        const resetIdleTimer = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            idleTimedOut = true;
            if (!response.headersSent) json(response, 408, { error: '音频上传空闲超时' });
            request.destroy();
          }, audioIdleTimeoutMs);
          idleTimer.unref();
        };
        try {
          resetIdleTimer();
          file = await open(audioPath, 'w', 0o600);
          for await (const chunk of request) {
            resetIdleTimer();
            size += chunk.length;
            if (size > maxAudioBytes) { json(response, 413, { error: '音频超过上传限制' }); return; }
            if (terminal(task.status)) { json(response, 409, { error: '任务已结束' }); return; }
            await file.writeFile(chunk);
          }
          clearTimeout(idleTimer);
          await file.close(); file = undefined;
          if (idleTimedOut) return;
          if (!size) return json(response, 400, { error: '音频不能为空' });
          if (terminal(task.status)) return json(response, 409, { error: '任务已结束' });
          received = true;
           clearTimeout(receiveTimers.get(task.id));
           receiveTimers.delete(task.id);
          json(response, 202, { id: task.id, received: true, size });
          upload?.end('completed', { output: { bytes: size } });
          queue.enqueue({ id: task.id, run: () => runTask(task, audioPath) });
        } finally {
          clearTimeout(idleTimer);
          await file?.close();
          uploads.delete(task.id);
          if (!received) upload?.end('failed', { output: { bytes: size } });
          if (!received) await unlink(audioPath).catch(() => {});
        }
        return;
      }
      if (request.method === 'POST' && match[2] === 'cancel') {
        if (!terminal(task.status)) {
          active.get(task.id)?.abort();
          await finish(task, 'cancelled');
        }
        return json(response, 200, { id: task.id, status: task.status });
      }
      if (request.method === 'GET' && match[2] === 'events') {
        const cursor = String(request.headers['last-event-id'] || url.searchParams.get('after') || '0');
        if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) return json(response, 400, { error: '事件游标无效' });
        clearTimeout(requestTimer);
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.flushHeaders();
        sse.subscribe(task.id, response, true);
        await eventLog.flush(task.id);
        const replay = eventLog.replay(task.id, Number(cursor));
        for (const event of replay) sse.writeEvent(response, event);
        const lastReplayId = replay.at(-1)?.id ?? Number(cursor);
        sse.resume(task.id, response, lastReplayId);
        if (terminal(task.status)) return sse.close(task.id);
        return;
      }
      return json(response, 405, { error: '方法不允许' });
    } catch {
      if (!response.headersSent) json(response, 500, { error: '本地服务处理失败' });
      else response.end();
    }
  });
  const typedServer = server as AgentServer;
  server.on('close', () => {
    clearInterval(pruneTimer);
    queue.stop();
    for (const task of tasks.values()) {
      if (!terminal(task.status)) {
        void finish(task, 'cancelled');
        active.get(task.id)?.abort();
      }
    }
    void eventLog.flushAll().catch(() => {});
  });
  typedServer.connection = { url: `http://127.0.0.1:${port}`, token, pid: process.pid };
  server.on('listening', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return;
    typedServer.connection.url = `http://127.0.0.1:${address.port}`;
    const connectionPath = join(directory, 'connection.json');
    writeFileSync(connectionPath, JSON.stringify(typedServer.connection), { mode: 0o600 });
    chmodSync(connectionPath, 0o600);
  });
  return typedServer;
}

export async function startCLI() {
  const tracing = initializeTracing(process.cwd());
  const server = await createServer({ tracing });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(43127, '127.0.0.1', resolve); });
  console.log('Pi Agent 本地服务已启动：http://127.0.0.1:43127（凭证仅保存在本地连接配置）');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => tracing?.shutdown().catch(() => console.warn('Langfuse 关闭时未能刷新追踪数据')));
    server.closeAllConnections();
  });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startCLI().catch(() => { console.error('Pi Agent 启动失败，请检查本地配置和端口'); process.exitCode = 1; });
