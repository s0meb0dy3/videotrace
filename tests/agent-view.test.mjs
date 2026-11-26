import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentView } from '../extension/agent-view.js';

const context = { key: 'BVexample:1', tabId: 10 };
const document = { context, cues: [{ id: '1', speakerId: '0', startMs: 0, endMs: 1000, text: '你好' }] };
const event = (type, data) => ({ type, data });

function setup(client) {
  const snapshots = [], history = [], events = [];
  const view = createAgentView({ client, getDocument: () => ({ context }), loadAudio: async () => new Blob(),
    captureFaces: async () => ({ frames: [] }), cropFace: async (image, box) => { assert.deepEqual(box, [0, 0, 10, 10]); return `${image}-crop`; },
    onResult: (result, transcript, _signal, avatars) => snapshots.push({ result, transcript, avatars }),
    onProgress() {}, onTasks: tasks => history.push([...tasks]), onEvent: (id, event) => events.push({ id, ...event }),
    onSessionError: error => { assert.equal(error, ''); }
  });
  return { view, snapshots, history, events };
}

test('SSE snapshots show transcript before names and preserve partial analysis on failure', async () => {
  const task = { id: 'initial', status: 'receiving_audio' };
  let uploaded;
  const { view, snapshots } = setup({
    startContext: async () => task,
    uploadAudio: async id => { uploaded = id; },
    get: async () => structuredClone(task),
    watch: async (id, emit) => {
      assert.equal(uploaded, id);
      Object.assign(task, { status: 'analyzing', document });
      await emit(event('status', { status: 'analyzing' }));
      assert.equal(snapshots[0].transcript.cues[0].text, '你好');
      assert.deepEqual(snapshots[0].avatars, {});
      task.speakerState = { speakers: { '0': '嘉宾' }, faces: { '0': 'one' } };
      task.avatarSources = { '0': { image: 'one', box: [0, 0, 10, 10] } };
      await emit(event('speaker_updated', { speakerId: '0', label: '嘉宾' }));
      assert.equal(snapshots.at(-1).result.speakers['0'], '嘉宾');
      assert.equal(snapshots.at(-1).avatars['0'], 'data:image/jpeg;base64,one-crop');
      task.speakerState.summary = '开场';
      await emit(event('summary_updated', { summary: '开场' }));
      assert.equal(snapshots.at(-1).result.summary, '开场');
      task.status = 'failed';
    }
  });
  await view.analyze();
  assert.equal(snapshots.at(-1).result.summary, '开场');
  assert.equal(view.ready, true);
});

test('reopen restores ordered chat and selected avatars, then continues latest task', async () => {
  const tasks = [{ id: 'initial', status: 'completed', summary: '初始总结' }, { id: 'latest', status: 'completed', prompt: '问题一', answer: '回答一' }];
  const state = { speakers: { '0': '嘉宾' }, faces: { '0': 'one' }, summary: '总结' };
  const source = { '0': { image: 'one', box: [0, 0, 10, 10] } };
  const { view, snapshots, history, events } = setup({
    session: async key => { assert.equal(key, context.key); return { tasks }; },
    get: async id => ({ ...(tasks.find(task => task.id === id) || { id, status: 'completed', answer: '回答二' }), document, speakerState: state, avatarSources: source }),
    followUp: async (previous, prompt, options) => {
      assert.equal(previous, 'latest');
      assert.equal(prompt, '问题二');
      assert.equal(options.inspectFaces, true);
      return { id: 'new', status: 'queued', previousTaskId: previous };
    },
    watch: async (_id, emit) => emit(event('status', { status: 'completed' }))
  });
  // A capture callback is necessary before inspectFaces can be requested.
  await view.restore(context);
  assert.equal(view.ready, true);
  assert.deepEqual(history.at(-1).map(({ id }) => id), ['initial', 'latest']);
  assert.equal(history.at(-1)[0].summary, '初始总结');
  assert.equal(snapshots.at(-1).avatars['0'], 'data:image/jpeg;base64,one-crop');
  await view.replay('initial');
  assert.equal(events.at(-1).id, 'initial');
  await view.analyze({ prompt: '问题二', inspectFaces: true });
  assert.equal(history.at(-1).at(-1).answer, '回答二');
});
