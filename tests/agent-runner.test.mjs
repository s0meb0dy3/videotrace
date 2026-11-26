import test from 'node:test';
import assert from 'node:assert/strict';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai';
import { runPiTask, createOpenAICompatibleRuntime, loadModelConfig } from '../dist/agent/runner.js';
import { prepareDocument, validateResult } from '../dist/agent/document.js';
import { createVideoTools } from '../dist/agent/tools.js';

export const document = { context: { bvid: 'BVtest', title: '测试视频', description: '节目简介', uploader: { name: '测试UP主', bio: '主持栏目' } }, cues: [{ id: 'c1', speakerId: '0', startMs: 0, endMs: 1000, text: '你好，我是主持人。' }, { id: 'c2', speakerId: '1', startMs: 1000, endMs: 2000, text: '大家好。' }], paragraphs: [], raw: { original: true } };
const result = { speakers: { '0': '主持人', '1': '未知发言人' }, summary: '相互问候' };
const defaultSpeakers = { '0': '未知发言人', '1': '未知发言人' };
const range = { startMs: 0, endMs: 1000 };
function runtime(responses) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  const contexts = [];
  return { faux, contexts, runtime: { model: faux.getModel(), streamFn: (model, context, options) => { contexts.push(structuredClone(context)); return models.streamSimple(model, context, options); } } };
}
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const reply = text => fauxAssistantMessage([fauxText(text)]);
const messageText = message => typeof message.content === 'string' ? message.content : message.content[0].text;
const declaredTools = context => context.messages.flatMap(message => message.toolsAdded || []).map(tool => tool.name);

test('配置后模型可调用搜索并读取结果；失败后仍能回复', async () => {
  const script = runtime([call('web_search', { query: ' 360 创始人 ' }), call('web_search', { query: '另一个查询' }), reply('已查证。')]);
  const results = [{ title: '创始人', url: 'https://example.test/', content: '公司介绍', score: 0.9 }];
  const queries = [];
  const output = await runPiTask({ document, runtime: script.runtime, webSearch: async query => {
    queries.push(query);
    if (queries.length > 1) throw new Error('联网搜索失败');
    return results;
  } });
  assert.equal(output.answer, '已查证。');
  assert.deepEqual(queries, ['360 创始人', '另一个查询']);
  assert.ok(declaredTools(script.contexts[0]).includes('web_search'));
  const calls = script.contexts.at(-1).messages.filter(message => message.role === 'toolResult');
  assert.deepEqual(JSON.parse(messageText(calls[0])), { results });
  assert.equal(calls[1].isError, true);
  assert.ok(!createVideoTools(['0'], undefined, {}).tools.some(tool => tool.name === 'web_search'));
});

test('复用工具定义，但不同任务的说话人、截图与更新互不影响', async () => {
  const changes = [];
  const seeds = new Set();
  const makeTools = speakerId => createVideoTools([speakerId], undefined, {
    shownCandidateIds: seeds,
    inspectFaces: async () => ({ representativeFrames: [{ image: speakerId, faces: [{ candidateId: speakerId }] }] }),
    onSpeakerUpdate: async patch => { changes.push([speakerId, patch]); }
  });
  const a = makeTools('a');
  const b = makeTools('b');
  const [inspectA, updateA] = a.tools;
  const [inspectB, updateB] = b.tools;
  assert.equal(updateA.parameters, updateB.parameters);
  await Promise.all([inspectA.execute('capture', range), inspectB.execute('capture', range)]);
  assert.equal(a.takeImages('capture')[0].image, 'a');
  assert.equal(b.takeImages('capture')[0].image, 'b');
  await assert.rejects(updateB.execute('write', { speakerId: 'a', label: '主持人' }), /无效说话人 ID/);
  await assert.rejects(updateB.execute('write', { speakerId: 'b', candidateId: 'a' }), /已展示/);
  await updateA.execute('write', { speakerId: 'a', candidateId: 'a' });
  assert.deepEqual(changes, [['a', { speakerId: 'a', candidateId: 'a' }]]);
  assert.deepEqual(a.getResult().faces, { a: 'a' });
  assert.equal(b.getResult().faces, undefined);
  assert.equal(seeds.size, 0);
});

test('首轮传入完整资料，逐项更新后返回最后一条自然语言回复', async () => {
  const patch = { speakerId: '0', label: '主持人' };
  const script = runtime([fauxAssistantMessage([
    fauxText('先保存分析。'),
    fauxToolCall('update_speaker', { ...patch, label: ' 主持人 ' }),
    fauxToolCall('update_summary', { summary: result.summary })
  ], { stopReason: 'toolUse' }), reply('视频中两位发言人相互问候。'), reply('不应继续')]);
  const changes = [];
  assert.deepEqual(await runPiTask({ document, runtime: script.runtime,
    onSpeakerUpdate: async update => { changes.push(update); },
    onSummaryUpdate: async summary => { changes.push(summary); }
  }), { ...result, answer: '视频中两位发言人相互问候。' });
  assert.deepEqual(changes, [patch, result.summary]);
  assert.equal(script.faux.getPendingResponseCount(), 1);
  const input = JSON.parse(messageText(script.contexts[0].messages.find(message => message.role === 'user')));
  assert.deepEqual(input, { prompt: '推断发言人并概括视频。', context: document.context, cues: document.cues });
  assert.deepEqual(declaredTools(script.contexts[0]), ['update_speaker', 'update_summary']);
});

test('inspect_faces attaches each image once without persisting it or approving unseen candidates', async () => {
  const visual = runtime([
    fauxAssistantMessage([fauxToolCall('inspect_faces', range), fauxToolCall('update_speaker', { speakerId: '0', candidateId: 'req-0-0' })], { stopReason: 'toolUse' }),
    call('inspect_faces', range),
    call('update_speaker', { speakerId: '0', candidateId: 'req-0-0' }),
    call('update_speaker', { speakerId: '1', candidateId: 'req-0-0' }),
    reply('已找到头像')
  ]);
  let scans = 0;
  const events = []; const messages = [];
  const output = await runPiTask({ document, runtime: visual.runtime, inspectFaces: async range => { scans++; return { range, detections: [], representativeFrames: [{ timeMs: 10, image: 'private-source-base64', faces: [{ box: [0.1, 0.1, 0.2, 0.3], candidateId: 'req-0-0' }] }], visual: { images: ['private-annotated-base64', 'private-image-base64'], times: [10], tracks: [{ label: 'T1', timeMs: 10, candidateId: 'req-0-0' }] } }; }, onEvent: event => events.push(event), onMessages: state => messages.push(state) });
  assert.deepEqual(declaredTools(visual.contexts[0]), ['inspect_faces', 'update_speaker', 'update_summary']);
  assert.deepEqual(output.faces, { '0': 'req-0-0', '1': null });
  const faceResult = visual.contexts[1].messages.find(message => message.role === 'toolResult' && message.toolName === 'inspect_faces');
  assert.deepEqual(faceResult.content.at(-1), { type: 'image', data: 'private-image-base64', mimeType: 'image/jpeg' });
  assert.deepEqual(JSON.parse(faceResult.content[0].text).representativeFrames[0].faces[0].candidateId, 'req-0-0');
  assert.equal(scans, 1);
  assert.ok(visual.contexts.slice(2).every(context => context.messages.every(message => !Array.isArray(message.content) || message.content.every(block => block.type !== 'image'))));
  assert.equal(JSON.stringify(events).includes('private-image-base64'), false);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].at(-1).role, 'assistant');
  assert.equal(JSON.stringify(messages).includes('private-image-base64'), false);
  assert.deepEqual(events.filter(event => event.type === 'tool_execution_end').map(event => [event.toolName, event.isError]), [
    ['inspect_faces', false], ['update_speaker', true], ['inspect_faces', false], ['update_speaker', false], ['update_speaker', true]
  ]);
});

test('可直接自然回复，不需要为了结束而修改分析结果', async () => {
  const script = runtime([reply('可以回答这个问题。'), reply('不应继续')]);
  assert.deepEqual(await runPiTask({ document, runtime: script.runtime }), {
    speakers: defaultSpeakers, summary: '', answer: '可以回答这个问题。'
  });
  assert.equal(script.faux.getPendingResponseCount(), 1);
});

test('空回复不重试，已取消任务不发出请求', async () => {
  const script = runtime([reply('   '), reply('不应继续')]);
  const snapshots = [];
  await assert.rejects(runPiTask({ document, runtime: script.runtime, onMessages: messages => snapshots.push(messages) }), /分析未完成/);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].at(-1).role, 'assistant');
  assert.equal(script.faux.getPendingResponseCount(), 1);
  await assert.rejects(runPiTask({ document, runtime: script.runtime, signal: AbortSignal.abort() }), /任务已取消/);
  assert.equal(script.faux.getPendingResponseCount(), 1);
});

test('追问读取视频、历史、当前结果，等待更新后流式返回普通文本', async () => {
  const current = { ...result, faces: { '0': 'prior-avatar', '1': null } };
  const history = [{ role: 'user', content: '先介绍节目' }, { role: 'assistant', content: '这是访谈节目' }];
  const patch = { speakerId: '0', label: '节目主持人' };
  const text = '已经更新了。';
  const script = runtime([call('update_speaker', patch), call('update_summary', { summary: '新摘要' }), reply(text), reply('不应继续')]);
  const changes = [];
  const deltas = [];
  let releaseUpdate;
  const updating = new Promise(resolve => { releaseUpdate = resolve; });
  let updateStarted;
  const started = new Promise(resolve => { updateStarted = resolve; });
  const task = runPiTask({ document, prompt: '更正主持人并更新摘要', conversation: { history, result: current }, runtime: script.runtime,
    onSpeakerUpdate: async update => { updateStarted(); await updating; changes.push(update); },
    onSummaryUpdate: async summary => { changes.push(summary); },
    onEvent: event => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') deltas.push(event.assistantMessageEvent.delta);
    }
  });
  await started;
  assert.equal(script.faux.state.callCount, 1);
  releaseUpdate();
  const output = await task;
  assert.deepEqual(output, { speakers: { ...result.speakers, '0': patch.label }, summary: '新摘要', faces: current.faces, answer: text });
  assert.deepEqual(changes, [patch, '新摘要']);
  assert.equal(current.speakers['0'], result.speakers['0']);
  assert.equal(deltas.join(''), text);
  assert.equal(script.faux.getPendingResponseCount(), 1);
  assert.deepEqual(declaredTools(script.contexts[0]), ['update_speaker', 'update_summary']);
  const initial = runtime([reply('第一次分析')]);
  await runPiTask({ document, runtime: initial.runtime });
  const systemMessages = context => context.messages.filter(message => message.role === 'system').map(messageText);
  assert.equal(systemMessages(initial.contexts[0]).length, 1);
  assert.deepEqual(systemMessages(script.contexts[0]), systemMessages(initial.contexts[0]));
  const messages = script.contexts[0].messages.filter(message => message.role !== 'system');
  assert.deepEqual(JSON.parse(messageText(messages[0])), { context: document.context, cues: document.cues });
  assert.deepEqual(messages.slice(1, 3).map(message => ({ role: message.role, content: messageText(message) })), history);
  assert.deepEqual(JSON.parse(messageText(messages[3])), { prompt: '更正主持人并更新摘要', result });
});

test('校验工具参数且不接受未保存的补丁；允许移除已有头像', async () => {
  const current = { ...result, faces: { '0': 'inherited-avatar' } };
  const script = runtime([
    call('update_speaker', { speakerId: '2', label: '无效编号' }),
    call('update_speaker', { speakerId: '0', label: ' ' }),
    call('update_speaker', { speakerId: '0' }),
    call('update_speaker', { speakerId: '1', candidateId: 'unseen-avatar' }),
    call('update_speaker', { speakerId: '0', label: '没有保存的标签' }),
    call('update_summary', { summary: ' ' }),
    call('update_speaker', { speakerId: '0', candidateId: null }),
    call('update_summary', { summary: '已确定的摘要' }),
    reply('已更新')
  ]);
  const patches = [];
  assert.deepEqual(await runPiTask({ document, runtime: script.runtime, conversation: { history: [], result: current },
    onSpeakerUpdate: async patch => { patches.push(patch); if (patch.label) throw new Error('保存失败'); }
  }), { ...result, summary: '已确定的摘要', faces: { '0': null, '1': null }, answer: '已更新' });
  assert.deepEqual(patches, [{ speakerId: '0', label: '没有保存的标签' }, { speakerId: '0', candidateId: null }]);
  assert.equal(script.contexts.at(-1).messages.filter(message => message.role === 'toolResult' && message.isError).length, 6);
});

test('采帧工具拒绝超长区间，返回 unavailable 后仍可回答', async () => {
  const script = runtime([call('inspect_faces', { startMs: 0, endMs: 20001 }), call('inspect_faces', range), reply('仅根据转写分析。')]);
  const scans = [];
  await runPiTask({ document, runtime: script.runtime, inspectFaces: async range => { scans.push(range); return { status: 'unavailable' }; } });
  assert.deepEqual(scans, [range]);
  const inspectResults = script.contexts.at(-1).messages.filter(message => message.role === 'toolResult');
  assert.ok(inspectResults[0].isError);
  assert.deepEqual(JSON.parse(messageText(inspectResults[1])), { status: 'unavailable', range });
});

test('校验拒绝缺失、多出或空白的说话人标签与空摘要', () => {
  const prepared = prepareDocument(document);
  for (const speakers of [{ '0': '主持人' }, { ...result.speakers, '2': '来宾' }, { ...result.speakers, '1': ' ' }]) {
    assert.throws(() => validateResult({ ...result, speakers }, prepared), /全部/);
  }
  assert.throws(() => validateResult({ ...result, summary: ' ' }, prepared), /summary/);
});

test('OpenAI 兼容配置只接受 AI_API_KEY，不读取其他服务的凭据', async () => {
  const config = await loadModelConfig('/unused', { AI_PROVIDER: 'ignored', AI_MODEL: 'custom-model', AI_API_KEY: 'explicit-key', AI_BASE_URL: 'https://example.test/v1' });
  assert.deepEqual(config, { model: 'custom-model', apiKey: 'explicit-key', baseUrl: 'https://example.test/v1', maxTokens: 8192, contextWindow: 128000, input: ['text', 'image'], reasoning: true });
  const fallback = await loadModelConfig('/unused', { AI_PROVIDER: 'ignored', API_KEY: 'legacy-key', BAILIAN_API_KEY: 'asr-key', DEEPSEEK_API_KEY: 'provider-key', AI_REASONING: 'false' });
  assert.equal(fallback.apiKey, undefined);
  assert.equal(fallback.model, 'deepseek-flash');
  assert.equal(fallback.baseUrl, 'https://api.deepseek.com');
  assert.equal(fallback.reasoning, false);
  assert.equal((await loadModelConfig('/unused', { AI_API_KEY: 'env-key' }, 'injected-key')).apiKey, 'injected-key');
});

test('OpenAI 兼容请求使用 system 角色，不注入厂商专用参数', async () => {
  for (const reasoning of [true, false]) {
    const config = await loadModelConfig('/unused', {
      AI_PROVIDER: 'bailian', AI_WEB_SEARCH: 'true', AI_REASONING: String(reasoning), AI_MODEL: 'custom-model', AI_API_KEY: 'test-key', AI_BASE_URL: 'https://example.test/v1'
    });
    const runtime = createOpenAICompatibleRuntime(config);
    let request;
    const stream = runtime.streamFn(runtime.model, { messages: [
      { role: 'system', content: '系统提示', timestamp: 1 },
      { role: 'user', content: [{ type: 'text', text: '测试' }], timestamp: 1 }
    ] }, {
      reasoning: 'high',
      fetch: async (url, { body, headers }) => {
        request = { url: String(url), payload: JSON.parse(body), auth: new Headers(headers).get('authorization') };
        const chunk = { choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      },
      maxRetries: 0,
    });
    const response = await stream.result();
    assert.notEqual(response.stopReason, 'error', response.errorMessage);
    assert.equal(request.url, 'https://example.test/v1/chat/completions');
    assert.equal(request.auth, 'Bearer test-key');
    assert.equal(request.payload.model, 'custom-model');
    assert.equal(request.payload.messages[0].role, 'system');
    assert.equal(request.payload.reasoning_effort, reasoning ? 'high' : undefined);
    assert.equal(request.payload.enable_search, undefined);
    assert.equal(request.payload.enable_thinking, undefined);
    assert.equal(request.payload.extra_body, undefined);
  }
});
