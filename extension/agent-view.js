import { createAgentClient } from './agent-client.js';

export const terminalTask = status => ['completed', 'failed', 'cancelled', 'timed_out'].includes(status);

export const taskStatus = {
  receiving_audio: '等待音频', queued: '排队中', transcribing: '正在转写', analyzing: '正在分析',
  completed: '已完成', failed: '失败', cancelled: '已取消', timed_out: '超时'
};

// 离开侧栏只断开订阅。显式取消才停止服务器任务。
export function createAgentView({ getDocument, loadAudio, releaseAudio, captureFaces, cropFace, onProgress, onResult, onTasks, onEvent, onSessionError, client = createAgentClient() }) {
  let session;
  let active;

  function update(task) {
    const index = session.tasks.findIndex(({ id }) => id === task.id);
    if (index === -1) session.tasks.push(task);
    else session.tasks[index] = { ...session.tasks[index], ...task };
    onTasks(session.tasks);
  }

  async function snapshot(task, original, signal) {
    signal.throwIfAborted();
    const { avatars: cache } = session;
    const result = task.result ? {
      ...task.speakerState, ...task.result,
      faces: { ...task.speakerState?.faces, ...task.result.faces }
    } : task.speakerState;
    // 本地转写可能已有段落划分；任务从缓存开始时继续使用原始文档。
    const transcript = original?.cues?.length ? original : task.document;
    if (transcript) {
      const avatars = {};
      for (const [id, source] of Object.entries(task.avatarSources || {})) {
        const candidateId = result?.faces?.[id];
        if (!candidateId) continue;
        if (!cache.has(candidateId)) {
          try { cache.set(candidateId, `data:image/jpeg;base64,${await cropFace(source.image, source.box)}`); }
          catch { /* 使用默认头像 */ }
        }
        const avatar = cache.get(candidateId);
        if (avatar) avatars[id] = avatar;
      }
      signal.throwIfAborted();
      await onResult(result, transcript, signal, avatars);
    }
    signal.throwIfAborted();
    // 不在聊天记录中复制字幕和截图。
    const { document, avatarSources, speakerState, result: _result, ...metadata } = task;
    update({ ...metadata, hasTranscript: Boolean(transcript?.cues?.length), summary: result?.summary });
  }

  async function watch(task, target, signal, original) {
    const seen = new Set();
    let capturing;
    const refresh = async () => snapshot(await client.get(task.id, signal), original, signal);
    async function capture({ requestId, times, deadline }) {
      const remaining = deadline - Date.now();
      if (!captureFaces || seen.has(requestId) || remaining <= 0) return;
      seen.add(requestId);
      capturing?.abort();
      const current = capturing = new AbortController();
      const captureSignal = AbortSignal.any([signal, current.signal, AbortSignal.timeout(remaining)]);
      let frames = [];
      try { ({ frames } = await captureFaces(target, times, captureSignal)); } catch { /* 头像失败不影响文本分析 */ }
      if (!captureSignal.aborted) await client.submitFaces(task.id, requestId, frames, captureSignal);
    }
    try {
      await client.watch(task.id, async event => {
        signal.throwIfAborted();
        onEvent(task.id, event);
        if (event.type === 'capture_faces') { void capture(event.data).catch(() => {}); return; }
        if (event.type === 'status') {
          const { status } = event.data;
          if (!terminalTask(status)) onProgress(`${taskStatus[status]}…`);
          if (status !== 'analyzing') return;
        } else if (!['transcript_ready', 'speaker_updated', 'summary_updated'].includes(event.type)) return;
        await refresh();
      }, signal);
      const completed = await client.get(task.id, signal);
      await snapshot(completed, original, signal);
      if (!terminalTask(completed.status)) throw new Error('Agent 事件连接已断开，请重新连接');
      return completed.error || '';
    } finally { capturing?.abort(); }
  }

  async function upload(taskId, target, signal) {
    try {
      onProgress('正在获取音频…');
      const audio = await loadAudio(target, signal);
      signal.throwIfAborted();
      onProgress('正在上传音频…');
      await client.uploadAudio(taskId, audio, signal);
    } finally { releaseAudio?.(target); }
  }

  async function restore(target) {
    detach();
    const current = session = { target, controller: new AbortController(), tasks: [], avatars: new Map() };
    const job = active = { controller: new AbortController() };
    const signal = AbortSignal.any([job.controller.signal, current.controller.signal]);
    let progressError = '';
    onSessionError('');
    try {
      const { tasks } = await client.session(target.key, signal);
      signal.throwIfAborted();
      current.tasks = tasks.map(({ document, speakerState, avatarSources, result, ...task }) => ({ ...task, summary: result?.summary ?? speakerState?.summary ?? task.summary, hasTranscript: Boolean(document?.cues?.length) }));
      onTasks(current.tasks);
      const latest = tasks.at(-1);
      if (!latest) return;
      job.id = latest.id;
      const task = await client.get(latest.id, signal);
      await snapshot(task, undefined, signal);
      if (terminalTask(task.status)) {
        progressError = task.error || '';
        return;
      }
      onProgress(`${taskStatus[task.status]}…`);
      if (task.status === 'receiving_audio') await upload(task.id, target, signal);
      progressError = await watch(task, target, signal);
    } catch (error) {
      if (!signal.aborted) onSessionError(error.message);
    } finally {
      if (active === job) { active = null; onProgress(progressError, { error: Boolean(progressError) }); }
    }
  }

  async function analyze({ inspectFaces = false, prompt } = {}) {
    if (active) return;
    const original = getDocument();
    const target = original.context;
    session ||= { target, controller: new AbortController(), tasks: [], avatars: new Map() };
    const latest = session.tasks.at(-1);
    if (prompt && (!latest?.hasTranscript || !terminalTask(latest.status))) return;
    const previousTaskId = prompt ? latest.id : undefined;
    const job = active = { controller: new AbortController() };
    const signal = AbortSignal.any([job.controller.signal, session.controller.signal]);
    const options = { signal, prompt, inspectFaces: inspectFaces && Boolean(captureFaces) };
    try {
      const task = previousTaskId
        ? await client.followUp(previousTaskId, prompt, options)
        : original.cues?.length
          ? await client.start({ context: target, cues: original.cues }, options)
          : await client.startContext(target, options);
      signal.throwIfAborted();
      job.id = task.id;
      update({ ...task, prompt, previousTaskId });
      if (!previousTaskId && !original.cues?.length) await upload(task.id, target, signal);
      const error = await watch(task, target, signal, previousTaskId ? undefined : original);
      onProgress(error, { error: Boolean(error) });
    } catch (error) {
      if (!signal.aborted) {
        if (job.id) onSessionError(error.message);
        throw error;
      }
    } finally {
      if (active === job) active = null;
    }
  }

  function detach() {
    session?.controller.abort();
    session = null;
    active = null;
  }

  async function cancel() {
    const job = active;
    const target = session?.target;
    job?.controller?.abort();
    if (!job) return;
    if (job.id) await client.cancel(job.id);
    if (target && session?.target === target) await restore(target);
  }

  function replay(id) {
    return client.watch(id, event => onEvent(id, event), session.controller.signal);
  }

  return { analyze, cancel, detach, restore, replay,
    get busy() { return Boolean(active); },
    get ready() {
      const latest = session?.tasks.at(-1);
      return Boolean(latest?.hasTranscript && terminalTask(latest.status));
    }
  };
}
