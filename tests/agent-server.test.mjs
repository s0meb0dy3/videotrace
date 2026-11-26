import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../dist/agent/server.js';
const document = { context: { bvid: 'BVtest' }, cues: [{ id: 'c1', speakerId: '0', text: '原始句子', startMs: 0, endMs: 100 }], paragraphs: [], raw: { keep: true } };
const result = { speakers: { '0': '未知发言人' }, summary: '摘要' };
async function setup(t, options = {}) {
  const root = options.root || await mkdtemp(join(tmpdir(), 'pi-agent-test-'));
  const server = await createServer({ root, port: 0, apiKey: 'provider-secret', ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = server.connection.url;
  const headers = { Authorization: `Bearer ${server.connection.token}` };
  const request = (path, options = {}) => fetch(url + path, { ...options, headers: { ...headers, ...options.headers } });
  const create = async () => { const response = await request('/tasks', { method: 'POST', body: JSON.stringify({ document, mode: 'analyze' }) }); assert.equal(response.status, 202); return response.json(); };
  return { server, root, request, create, url, headers };
}
async function complete(request, id) {
  const response = await request(`/tasks/${id}/events`);
  const text = await response.text();
  const task = await (await request(`/tasks/${id}`)).json();
  return { task, text };
}

test('后端从 .env 启用搜索，不将密钥写入会话轨迹', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-agent-search-'));
  const key = 'local-tavily-test-secret';
  await writeFile(join(root, '.env'), `TAVILY_API_KEY="${key}"\n`, { mode: 0o600 });
  const app = await setup(t, { root, runner: async ({ webSearch, onEvent }) => {
    assert.equal(typeof webSearch, 'function');
    await onEvent({ type: 'tool_execution_start', toolCallId: 'search', toolName: 'web_search', args: { query: '查找公开资料' } });
    await onEvent({ type: 'tool_execution_end', toolCallId: 'search', toolName: 'web_search',
      result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ title: key, url: 'https://example.test' }] }) }] },
      isError: false, durationMs: 11 });
    return result;
  } });
  const { id } = await app.create();
  const { task } = await complete(app.request, id);
  assert.equal(task.status, 'completed');
  const trace = await readFile(join(root, '.private/agent/traces', `${id}.jsonl`), 'utf8');
  assert.ok(!trace.includes(key));
  const search = trace.trim().split('\n').map(JSON.parse).find(event => event.toolName === 'web_search');
  assert.deepEqual(search.args, { query: '查找公开资料' });
  assert.equal(search.result.results[0].url, 'https://example.test');
  assert.equal(search.durationMs, 11);
});

test('视频会话保留渐进更新，重启后继续追问且不重新转写', async t => {
  const video = { ...document, context: { key: 'BVtest:part1', title: '测试访谈' } };
  const app = await setup(t, { runner: async ({ onSpeakerUpdate, onSummaryUpdate, onEvent }) => {
    await onEvent({ type: 'agent_start' });
    await onEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'update_speaker', args: { speakerId: '0', label: '主持人' } });
    await onSpeakerUpdate({ speakerId: '0', label: '主持人' });
    await onEvent({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'update_speaker', result: { content: [{ type: 'text', text: '{"accepted":true}' }] }, isError: false, durationMs: 18 });
    await onSummaryUpdate('首次摘要');
    await onEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '流式片段' } });
    await onEvent({ type: 'message_end', message: { role: 'assistant', model: 'test-model', stopReason: 'stop',
      content: [{ type: 'thinking', thinking: '角色有自我介绍' }, { type: 'text', text: '这是一次访谈' }], usage: { totalTokens: 99 } } });
    await onEvent({ type: 'agent_end' });
    return { speakers: { '0': '主持人' }, summary: '首次摘要' };
  } });
  const post = (app, body) => app.request('/tasks', { method: 'POST', body: JSON.stringify(body) });
  const initial = await post(app, { document: video, mode: 'analyze' });
  assert.equal(initial.status, 202);
  const { id } = await initial.json();
  const first = await complete(app.request, id);
  assert.equal(first.task.status, 'completed');
  assert.match(first.text, /transcript_ready[\s\S]*speaker_updated[\s\S]*summary_updated/);
  const resumed = await setup(t, { root: app.root, asrRunner: () => assert.fail('追问不可重新转写'),
    runner: async ({ document, conversation, prompt, onSummaryUpdate }) => {
      assert.deepEqual(document.cues, video.cues);
      assert.equal(conversation.result.speakers['0'], '主持人');
      assert.equal(conversation.history.at(-1).content, '首次摘要');
      assert.equal(prompt, '补充要点');
      await onSummaryUpdate('更新后的摘要');
      return { ...conversation.result, summary: '更新后的摘要', answer: '已补充' };
    } });
  const session = async () => (await resumed.request('/session?key=BVtest%3Apart1')).json();
  assert.deepEqual((await session()).tasks.map(task => task.id), [id]);
  const followup = await post(resumed, { previousTaskId: id, prompt: '补充要点' });
  assert.equal(followup.status, 202);
  const second = await complete(resumed.request, (await followup.json()).id);
  assert.equal(second.task.status, 'completed');
  assert.equal(second.task.answer, '已补充');
  assert.equal(second.task.speakerState.summary, '更新后的摘要');
  assert.equal((await session()).tasks.length, 2);
  assert.equal((await post(resumed, { previousTaskId: id, prompt: '重复提交' })).status, 409);
  const traceDir = join(app.root, '.private/agent/traces');
  const files = await readdir(traceDir);
  assert.equal(files.length, 1);
  const path = join(traceDir, files[0]);
  const raw = await readFile(path, 'utf8');
  const entries = raw.trim().split('\n').map(JSON.parse);
  assert.deepEqual(entries.filter(e => e.role === 'user').map(e => [e.turn, e.text]), [[1, '推断发言人并概括视频。'], [2, '补充要点']]);
  assert.deepEqual(entries.filter(e => e.status === 'completed').map(e => e.turn), [1, 2]);
  const tool = entries.find(e => e.type === 'tool_result');
  assert.deepEqual(tool.args, { speakerId: '0', label: '主持人' });
  assert.deepEqual(tool.result, { accepted: true });
  assert.equal(tool.durationMs, 18);
  const reply = entries.find(e => e.role === 'assistant');
  assert.equal(reply.text, '这是一次访谈');
  assert.equal(reply.thinking, '角色有自我介绍');
  assert.equal(reply.usage.totalTokens, 99);
  assert.doesNotMatch(raw, /原始句子|provider-secret|流式片段/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('avatar capture is task-scoped, returns candidates, and does not persist JPEGs', async t => {
  const app = await setup(t, { runner: async ({ inspectFaces }) => {
    const scan = await inspectFaces({ startMs: 2000, endMs: 4000 });
    assert.equal(scan.representativeFrames.length, 1);
    const candidateId = scan.representativeFrames[0].faces[0].candidateId;
    assert.deepEqual(scan.visual.tracks, [{ label: 'T1', timeMs: 2000, candidateId }]);
    assert.equal(scan.visual.images.length, 2);
    return { ...result, faces: { '0': candidateId } };
  } });
  const { id } = await (await app.request('/tasks', { method: 'POST', body: JSON.stringify({ document, mode: 'analyze', inspectFaces: true }) })).json();
  const response = await app.request(`/tasks/${id}/events`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '', event;
  while (!event) {
    const { value, done } = await reader.read();
    assert.ok(!done);
    text += decoder.decode(value, { stream: true });
    event = text.split('\n\n').filter(block => block.includes('event: capture_faces')).map(block => block.match(/\ndata: (.+)/)?.[1]).find(Boolean);
  }
  const { requestId, times, continuous } = JSON.parse(event).data;
  assert.equal(continuous, true);
  assert.deepEqual(times, [2000, 2250, 2500, 2750, 3000, 3250, 3500, 3750]);
  const image = '/9j/QVZBVEFS';
  const submit = requestId => app.request(`/tasks/${id}/faces`, { method: 'POST', body: JSON.stringify({ requestId,
    frames: [{ timeMs: 2000, image, faces: [{ box: [0.1, 0.2, 0.3, 0.4], score: 0.95 }] }],
    evidence: { status: 'stable_tracks', images: [image, image], times: [2000], tracks: [{ label: 'T1', timeMs: 2000, faceIndex: 0 }] }
  }) });
  assert.equal((await submit('stale')).status, 409);
  assert.equal((await submit(requestId)).status, 200);
  const { task } = await complete(app.request, id);
  assert.deepEqual(task.result.faces, { '0': `${requestId}-0-0` });
  assert.equal((await submit(requestId)).status, 409);
  for (const suffix of ['.json', '.events.jsonl']) assert.ok(!(await readFile(join(app.root, `.private/agent/tasks/${id}${suffix}`), 'utf8')).includes(image));
  await reader.cancel();
});

test('HTTP token, exact Host, extension-only Origin, preflight and validation', async t => {
  const app = await setup(t, { runner: async () => result });
  assert.equal((await fetch(app.url + '/tasks')).status, 401);
  assert.equal((await app.request('/tasks', { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await app.request('/tasks', { headers: { Origin: 'chrome-extension://invalid' } })).status, 403);
  const origin = 'chrome-extension://' + 'a'.repeat(32);
  const allowed = await app.request('/tasks', { method: 'OPTIONS', headers: { Origin: origin } });
  assert.equal(allowed.status, 204); assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
  assert.equal((await fetch(app.url + '/tasks', { headers: { Origin: origin } })).status, 401);
  const badHost = await new Promise(resolve => { const req = http.request(app.url + '/tasks', { headers: { ...app.headers, Host: '127.0.0.1.attacker.test:43127' } }, response => { response.resume(); resolve(response.statusCode); }); req.end(); });
  assert.equal(badHost, 403);
  assert.equal((await app.request('/tasks', { method: 'POST', body: '{}' })).status, 400);
  const connection = JSON.parse(await readFile(join(app.root, '.private/agent/connection.json'), 'utf8'));
  assert.equal(connection.token, app.server.connection.token);
  assert.equal((await stat(join(app.root, '.private/agent/connection.json'))).mode & 0o777, 0o600);
});

test('HTTP persistence, messages, SSE event ids/replay, original document retained', async t => {
  const app = await setup(t, { runner: async ({ onEvent, onMessages }) => {
    await onEvent({ type: 'message_end', message: { role: 'assistant', errorMessage: 'provider-secret /private/path', content: [] } });
    await onMessages([{ role: 'assistant', errorMessage: 'provider-secret', content: [{ type: 'text', text: 'provider-secret' }] }]);
    return result;
  } });
  const { id } = await app.create();
  const { task, text } = await complete(app.request, id);
  assert.equal(task.status, 'completed'); assert.deepEqual(task.document, document);
  assert.deepEqual(task.result, result);
  assert.ok(!text.includes('provider-secret')); assert.ok(!text.includes('/private/path'));
  const frames = text.split('\n\n').filter(frame => frame.startsWith('id:'));
  const ids = frames.map(frame => Number(frame.match(/^id: (\d+)/)[1]));
  assert.deepEqual(ids, ids.map((_, index) => index + 1));
  const replay = await (await app.request(`/tasks/${id}/events`, { headers: { 'Last-Event-ID': '2' } })).text();
  assert.ok(!replay.includes('id: 1\n')); assert.ok(!replay.includes('id: 2\n')); assert.ok(replay.includes('event: status'));
  const saved = JSON.parse(await readFile(join(app.root, `.private/agent/tasks/${id}.json`), 'utf8'));
  assert.deepEqual(saved.document, document);
  const messages = await readFile(join(app.root, `.private/agent/tasks/${id}.messages.json`), 'utf8');
  assert.ok(!messages.includes('provider-secret'));
});

test('cancel and timeout are terminal even if runner returns late', async t => {
  for (const status of ['cancelled', 'timed_out']) {
    let release; let started;
    const begun = new Promise(resolve => { started = resolve; });
    const app = await setup(t, { timeoutMs: 25, runner: ({ signal }) => new Promise(resolve => { release = () => resolve(result); started(signal); }) });
    const { id } = await app.create();
    const signal = await begun;
    if (status === 'cancelled') await app.request(`/tasks/${id}/cancel`, { method: 'POST' });
    const { task } = await complete(app.request, id);
    assert.equal(task.status, status); assert.ok(signal.aborted); assert.equal(task.result, undefined);
    release(); await new Promise(resolve => setImmediate(resolve));
    const final = await (await app.request(`/tasks/${id}`)).json();
    assert.equal(final.status, status); assert.equal(final.result, undefined);
    const trace = await readFile(join(app.root, `.private/agent/traces/${id}.jsonl`), 'utf8');
    const entries = trace.trim().split('\n').map(JSON.parse);
    assert.equal(entries.at(-1).status, status);
    assert.ok(entries.every(entry => entry.turn === 1));
  }
});

test('provider errors are fixed safe errors, invalid injected results fail', async t => {
  for (const runner of [async () => { throw new Error('provider-secret https://secret.test /Users/private'); }, async () => ({ ...result, speakers: [] })]) {
    const app = await setup(t, { runner }); const { id } = await app.create();
    const { task, text } = await complete(app.request, id);
    assert.equal(task.status, 'failed'); assert.equal(task.result, undefined);
    assert.ok(!JSON.stringify(task).includes('provider-secret')); assert.ok(!text.includes('/Users/private'));
  }
});

test('context/audio HTTP flow persists transcription before analysis and hides keys', async t => {
  let asrCalls = 0;
  let analysisCalls = 0;
  const app = await setup(t, { bailianApiKey: 'bailian-secret', asrRunner: async ({ audioPath, context, apiKey }) => {
    asrCalls++;
    assert.equal(apiKey, 'bailian-secret');
    assert.deepEqual(context, { bvid: 'BVtest', title: '视频', cid: 123 });
    assert.deepEqual(await readFile(audioPath), Buffer.from([0, 1, 2, 255]));
    assert.equal((await stat(audioPath)).mode & 0o777, 0o600);
    return { ...document, context, raw: { provider: 'bailian-secret', keep: true } };
  }, runner: async ({ document: prepared }) => {
    analysisCalls++;
    assert.deepEqual(prepared.raw, { provider: '[已隐藏]', keep: true });
    assert.deepEqual(prepared.cues, document.cues);
    return result;
  } });
  const created = await app.request('/tasks', { method: 'POST', body: JSON.stringify({ context: { bvid: 'BVtest', title: '视频', cid: 123 }, mode: 'analyze' }) });
  const { id, status } = await created.json();
  assert.equal(status, 'receiving_audio'); assert.equal(asrCalls, 0); assert.equal(analysisCalls, 0);
  assert.equal((await app.request(`/tasks/${id}/audio`, { method: 'POST', body: 'audio' })).status, 415);
  const uploaded = await app.request(`/tasks/${id}/audio`, { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: Buffer.from([0, 1, 2, 255]) });
  assert.equal(uploaded.status, 202); assert.deepEqual(await uploaded.json(), { id, received: true, size: 4 });
  const { task, text } = await complete(app.request, id);
  assert.equal(task.status, 'completed'); assert.equal(asrCalls, 1); assert.equal(analysisCalls, 1);
  assert.ok(text.includes('receiving_audio')); assert.ok(text.includes('transcribing')); assert.ok(text.includes('analyzing'));
  assert.ok(!JSON.stringify(task).includes('bailian-secret')); assert.ok(!text.includes('bailian-secret'));
  assert.equal((await app.request(`/tasks/${id}/audio`, { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: 'x' })).status, 409);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await readdir(join(app.root, '.private/agent/uploads')), []);
});

test('audio upload rejects oversized/empty bodies and cancelled tasks without calling ASR', async t => {
  const app = await setup(t, { maxAudioBytes: 3, asrRunner: () => { assert.fail('ASR must not start'); } });
  const { id } = await (await app.request('/tasks', { method: 'POST', body: JSON.stringify({ context: {}, mode: 'analyze' }) })).json();
  const upload = body => app.request(`/tasks/${id}/audio`, { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body });
  assert.equal((await upload('1234')).status, 413);
  assert.equal((await upload('')).status, 400);
  assert.deepEqual(await readdir(join(app.root, '.private/agent/uploads')), []);
  await app.request(`/tasks/${id}/cancel`, { method: 'POST' });
  assert.equal((await upload('12')).status, 409);
  const bad = await app.request('/tasks', { method: 'POST', body: JSON.stringify({ context: {}, audio: 'base64', mode: 'analyze' }) });
  assert.equal(bad.status, 400);
});

test('cancelling ASR prevents late document and analysis, errors stay private', async t => {
  let release;
  let begun;
  const started = new Promise(resolve => { begun = resolve; });
  const app = await setup(t, { asrRunner: ({ signal }) => new Promise(resolve => { release = resolve; begun(signal); }), runner: () => assert.fail('analysis must not start') });
  const { id } = await (await app.request('/tasks', { method: 'POST', body: JSON.stringify({ context: {}, mode: 'analyze' }) })).json();
  await app.request(`/tasks/${id}/audio`, { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: '12' });
  const signal = await started;
  await app.request(`/tasks/${id}/cancel`, { method: 'POST' });
  assert.ok(signal.aborted);
  release(document);
  const { task } = await complete(app.request, id);
  assert.equal(task.status, 'cancelled'); assert.equal(task.document, undefined);
});

test('ASR errors and timeout cannot launch analysis or expose credentials', async t => {
  for (const timeout of [false, true]) {
    const app = await setup(t, { bailianApiKey: 'bailian-private', asrTimeoutMs: 15,
      asrRunner: async ({ signal }) => {
        if (!timeout) throw new Error('bailian-private /private/provider/path');
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }, runner: () => assert.fail('analysis must not start') });
    const { id } = await (await app.request('/tasks', { method: 'POST', body: JSON.stringify({ context: {}, mode: 'analyze' }) })).json();
    await app.request(`/tasks/${id}/audio`, { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: '12' });
    const { task, text } = await complete(app.request, id);
    assert.equal(task.status, timeout ? 'timed_out' : 'failed');
    assert.equal(task.document, undefined); assert.ok(!text.includes('bailian-private')); assert.ok(!text.includes('/private/provider/path'));
  }
});

test('restart loads completed tasks, rotates token and fails interrupted tasks', async t => {
  const app = await setup(t, { runner: async () => result });
  const { id } = await app.create(); await complete(app.request, id);
  const path = join(app.root, `.private/agent/tasks/${id}.json`);
  const interrupted = JSON.parse(await readFile(path, 'utf8')); interrupted.status = 'running';
  await writeFile(path, JSON.stringify(interrupted));
  const restarted = await setup(t, { root: app.root, runner: async () => result });
  assert.notEqual(restarted.server.connection.token, app.server.connection.token);
  const task = await (await restarted.request(`/tasks/${id}`)).json();
  assert.equal(task.status, 'failed'); assert.equal(task.result, undefined);
});
