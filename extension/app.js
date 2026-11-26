import { readStored, writeStored } from './storage.js';
import { createTabBridge } from './tabs.js';
import { TranscriptPanel, activeCueAt } from './panel.js';
import { loadPageAudio } from './audio-loader.js';
import { createFaceCapture, cropFaceImage } from './face-capture.js';
import { initialAvatar } from './avatar.js';
import { createAgentClient } from './agent-client.js';
import { createAgentView } from './agent-view.js';
import { paragraphize } from './transcript.js';

const request = createTabBridge();
let context = null;
let documentData = null;
let revision = 0;
let task = null;
let route = '';
let checking = false;
let syncAgain = false;
let checkingPlayback = false;
let windowId;
let tabId;
let readingTimer;
let savedReading;
let translations;
let translationJob;
let agentError = '';
let restoring = false;
const resultKey = ctx => `asr-document:v1:${ctx.key}`;
const avatarKey = ctx => `asr-avatars:v1:${ctx.key}`;
const panelStateKey = ctx => `asr-panel-state:v1:${ctx.key}`;
const translationKey = ctx => `asr-translation:zh-CN:v1:${ctx.key}`;

function saveReading() {
  clearTimeout(readingTimer);
  const target = context || documentData?.context;
  if (!target) return;
  const state = panel.getState();
  const serialized = JSON.stringify(state);
  if (serialized === savedReading) return;
  savedReading = serialized;
  void writeStored(panelStateKey(target), state).catch(() => {});
}

function cancel(message = '') {
  task?.abort();
  task = null;
  panel.setTaskState({ message });
}

function clear() {
  saveReading();
  translationJob?.abort();
  translationJob = undefined;
  translations = undefined;
  savedReading = undefined;
  agentView.detach();
  restoring = false;
  agentError = '';
  cancel();
  revision++;
  documentData = null;
  panel.clear();
}

function avatarLabel(speakerId, index) {
  const number = Number(speakerId);
  return Number.isInteger(number) && number >= 0 ? String(number + 1) : String.fromCharCode(65 + (index % 26));
}

function displayAvatars(data) {
  const avatars = { ...(data.avatars || {}) };
  const people = data.people || {};
  const shared = new Map();
  for (const [id, person] of Object.entries(people)) {
    const name = String(person?.name || '').trim();
    if (!name || /^(未知发言人|unknown|未知)$/i.test(name)) continue;
    if (avatars[id]) shared.set(name, avatars[id]);
  }
  const entries = Object.entries(people);
  entries.forEach(([id, person], index) => {
    if (avatars[id]) return;
    const name = String(person?.name || '').trim();
    if (name && shared.has(name)) avatars[id] = shared.get(name);
    else avatars[id] = initialAvatar(avatarLabel(id, index), `speaker-${id}`);
  });
  return avatars;
}

function present(data, state = { view: data.agentResult?.summary ? 'summary' : 'transcript' }) {
  documentData = { ...data, avatars: displayAvatars(data) };
  panel.renderDocument(documentData, { translations, bilingual: state.bilingual });
  panel.setSummary(data.agentResult?.summary);
  panel.setTranslationStatus(Boolean(translationJob));
  panel.setStatus(data.cues.length ? '' : '模型未识别到有效语音，可重新转写', { retry: !data.cues.length });
  panel.restoreState(state);
  updatePlayback();
}

async function load() {
  if (!context || task) return;
  const token = revision;
  const original = documentData;
  const target = context;
  panel.setStatus('正在读取本地转写…');
  try {
    const [cached, state] = await Promise.all([readStored(resultKey(target)), readStored(panelStateKey(target))]);
    if (token !== revision || task || documentData !== original) return;
    savedReading = JSON.stringify(state);
    if (cached) {
      const [avatars, translated] = await Promise.all([readStored(avatarKey(target)), readStored(translationKey(target))]);
      if (token !== revision || task || documentData !== original) return;
      translations = translated?.savedAt === cached.savedAt ? translated?.translations : undefined;
      present({ ...cached, context: target, avatars: avatars || {} }, state && { ...state, manualReading: true });
    } else {
      panel.setStatus('');
      if (state) panel.restoreState(state);
    }
  } catch {
    if (token === revision) panel.setStatus('本地结果读取失败，请重试', { error: true, retry: true });
  }
}

const panel = new TranscriptPanel(chrome.runtime.getURL('panel.css'), {
  refresh: () => context ? load() : syncContext(),
  analyze: () => analyze(),
  ask: prompt => analyze(prompt),
  reconnect: () => restoreSession(),
  replay: id => agentView.replay(id),
  cancelTask: () => {
    cancel();
    const token = revision;
    void agentView.cancel().catch(error => {
      if (token !== revision) return;
      panel.setTaskState({ message: error.message, error: true });
    }).finally(updateChat);
  },
  seek: async (milliseconds, { play = false } = {}) => {
    if (!context) return;
    const token = revision;
    try {
      const result = await request('seek', { tabId: context.tabId, key: context.key, milliseconds, play });
      if (token !== revision) return;
      if (result.playBlocked) panel.setStatus('已跳转，请点击左侧播放器继续播放');
      updatePlayback();
    } catch (error) { if (token === revision) panel.setStatus(error.message, { error: true }); }
  },
  follow: follow => writeStored('settings', { follow }).catch(() => {}),
  state: saveReading,
  scroll: () => { clearTimeout(readingTimer); readingTimer = setTimeout(saveReading, 250); },
  translate: async () => {
    if (!documentData?.cues.length || translationJob) return;
    if (translations) {
      present(documentData, { ...panel.getState(), bilingual: !panel.bilingual });
      saveReading();
      return;
    }
    const target = documentData;
    const job = translationJob = new AbortController();
    panel.setTranslationStatus(true);
    try {
      const cues = target.cues.filter(({ text }) => text.trim()).map(({ id, text }) => ({ id, text }));
      const output = await createAgentClient().translate(cues, job.signal);
      if (job.signal.aborted || documentData?.savedAt !== target.savedAt) return;
      translationJob = undefined;
      translations = output.translations;
      void writeStored(translationKey(target.context), { savedAt: target.savedAt, translations }).catch(() => {});
      present(documentData, { ...panel.getState(), bilingual: true });
      saveReading();
    } catch {
      if (!job.signal.aborted && documentData === target) panel.setTranslationStatus(false, '翻译失败，点击重试');
      return;
    } finally {
      if (translationJob === job) translationJob = undefined;
    }
    panel.setTranslationStatus(false);
  }
});
const releaseAudio = target => request('clearAudio', { tabId: target.tabId, key: target.key }).catch(() => {});
const agentView = createAgentView({
  getDocument: () => documentData ? { ...documentData, context } : { context },
  loadAudio: (target, signal) => loadPageAudio({ request, context: target, signal }),
  releaseAudio,
  captureFaces: (target, times, signal) => createFaceCapture({
    captureFrames: (times, signal) => request('framesAt', { tabId: target.tabId, key: target.key, times }, signal)
  })(times, signal),
  cropFace: (...args) => cropFaceImage(...args),
  onProgress: (message, { error = false } = {}) => {
    panel.setTaskState({ busy: Boolean(message) && !error, message, error });
    updateChat();
  },
  onTasks: tasks => panel.chat.setTasks(tasks),
  onEvent: (id, event) => panel.chat.addEvent(id, event),
  onSessionError: message => { agentError = message; updateChat(); },
  onResult: async (result, original, signal, avatars = {}) => {
    const current = documentData;
    const sameTranscript = current?.cues === original.cues || (
      current?.cues.length === original.cues.length && current.cues.every((cue, i) => {
        const next = original.cues[i];
        return cue.id === next.id && cue.text === next.text && cue.speakerId === next.speakerId && cue.startMs === next.startMs && cue.endMs === next.endMs;
      })
    );
    const people = Object.fromEntries(original.cues.map(({ speakerId: id }) => {
      const name = result?.speakers?.[id];
      return [id, { id, name, inferred: Boolean(name) }];
    }));
    const updated = {
      ...(sameTranscript ? current : original), context, cues: original.cues,
      paragraphs: (sameTranscript ? current.paragraphs : original.paragraphs) || paragraphize(original.cues),
      savedAt: sameTranscript ? current.savedAt : (original.savedAt ?? Date.now()),
      people, agentResult: result, avatars
    };
    const state = { ...panel.getState(), bilingual: sameTranscript && panel.bilingual };
    if (!sameTranscript) {
      translations = undefined;
      translationJob?.abort();
      translationJob = undefined;
    }
    signal.throwIfAborted();
    present(updated, state);
    await Promise.all([
      writeStored(resultKey(updated.context), { ...updated, avatars: undefined }),
      writeStored(avatarKey(updated.context), avatars)
    ]).catch(() => {});
  }
});

function updateChat() {
  panel.chat.setState({ available: Boolean(context), ready: agentView.ready, busy: Boolean(task || restoring || agentView.busy), error: agentError });
}

async function restoreSession() {
  if (!context || task || restoring) return;
  const token = revision;
  restoring = true;
  updateChat();
  await agentView.restore(context);
  if (token !== revision) return;
  restoring = false;
  updateChat();
}

async function analyze(prompt) {
  if (!context || task || restoring || agentView.busy || (prompt && !agentView.ready)) return false;
  const target = context;
  const active = task = new AbortController();
  panel.setTaskState({ busy: true, message: '正在准备…' });
  updateChat();
  let error;
  try {
    const metadata = await request('identityMetadata', { tabId: target.tabId, key: target.key }).catch(() => null);
    if (active.signal.aborted) return false;
    context = { ...target, ...metadata };
    const inspectFaces = await readStored('speakerAvatars').catch(() => false);
    if (active.signal.aborted) return false;
    agentError = '';
    await agentView.analyze({ inspectFaces: inspectFaces === true, prompt });
    return true;
  } catch (failure) {
    error = failure;
    return false;
  } finally {
    if (task === active) {
      task = null;
      if (error) panel.setTaskState({ message: error.message, error: true });
      else panel.setBusy(false);
      updateChat();
    }
  }
}

readStored('settings').then(settings => { if (settings) panel.setFollow(settings.follow, false); }).catch(() => {});

async function updatePlayback() {
  if (!documentData || !context || checkingPlayback) return;
  const token = revision;
  checkingPlayback = true;
  try {
    const state = await request('playback', { tabId: context.tabId, key: context.key });
    if (token === revision) panel.setActive(state ? activeCueAt(documentData.cues, state.timeMs) : null);
  } catch { if (token === revision) panel.setActive(null); }
  finally { checkingPlayback = false; }
}

async function syncContext() {
  if (checking) { syncAgain = true; return; }
  checking = true;
  const token = revision;
  try {
    const snapshot = await request('snapshot');
    if (token !== revision) return;
    windowId = snapshot.windowId; tabId = snapshot.tabId;
    const nextRoute = `${snapshot.tabId}:${snapshot.context?.key || snapshot.url}`;
    panel.setAvailable(snapshot.available);
    if (route !== nextRoute) { route = nextRoute; clear(); context = null; }
    if (!snapshot.available) { panel.setStatus('请在左侧打开 B站视频'); return; }
    if (!snapshot.context) { panel.setStatus('等待播放器就绪，请刷新视频页或重试', { retry: true }); return; }
    if (!context) {
      context = { ...snapshot.context, tabId: snapshot.tabId };
      panel.setContext(context);
      const current = revision;
      void load().then(() => { if (current === revision) void restoreSession(); });
    }
  } catch (error) { if (token === revision) panel.setStatus(error.message, { error: true, retry: true }); }
  finally { checking = false; if (syncAgain) { syncAgain = false; syncContext(); } }
}
function invalidate() { clear(); context = null; route = ''; syncContext(); }
chrome.tabs.onActivated.addListener(info => { if (windowId === undefined || info.windowId === windowId) invalidate(); });
chrome.tabs.onUpdated.addListener((id, change) => { if (id === tabId && (change.url || change.status === 'loading')) invalidate(); });
chrome.tabs.onRemoved.addListener(id => { if (id === tabId) invalidate(); });
syncContext();
setInterval(syncContext, 1000);
setInterval(updatePlayback, 250);
