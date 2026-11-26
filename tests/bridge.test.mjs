import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/bridge.js', import.meta.url), 'utf8');
function environment(timers = { setTimeout, clearTimeout }) {
  let handler;
  const messages = [], seeks = [], playMutes = [];
  let time = 5;
  let callbackId = 0;
  const events = new Map(), callbacks = new Map();
  const video = {
    paused: false, muted: false, playbackRate: 1, duration: 100, videoWidth: 1920, videoHeight: 1080,
    get currentTime() { return time; },
    set currentTime(value) {
      time = value; seeks.push(value);
      queueMicrotask(() => events.get('seeked')?.());
    },
    pause() { this.paused = true; },
    async play() { this.paused = false; playMutes.push(this.muted); },
    requestVideoFrameCallback(callback) { callbacks.set(++callbackId, callback); return callbackId; },
    cancelVideoFrameCallback(id) { callbacks.delete(id); },
    addEventListener(name, listener) { events.set(name, listener); },
    removeEventListener(name) { events.delete(name); }
  };
  const window = {
    __INITIAL_STATE__: { videoData: { bvid: 'BVtest', aid: 1, pages: [{ page: 1, cid: 2 }] } },
    addEventListener(_name, listener) { handler = listener; },
    postMessage(message) { messages.push(message); }
  };
  const location = { pathname: '/video/BVtest/', href: 'https://www.bilibili.com/video/BVtest/', origin: 'https://www.bilibili.com' };
  vm.runInNewContext(source, { window, location, URL, Number, AbortController, ...timers,
    document: {
      querySelector: () => video,
      createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,frame' })
    }
  });
  return { video, seeks, playMutes, events, callbacks, frame(mediaTime) {
    const [id, callback] = callbacks.entries().next().value;
    callbacks.delete(id);
    callback(0, { mediaTime });
  }, async request(action, payload) {
    await handler({ source: window, origin: location.origin, data: { channel: 'bili-transcript-request', id: 1, action, payload } });
    return messages.at(-1);
  } };
}

test('页面采帧保留时间戳，结束后恢复播放位置和状态', async () => {
  const page = environment();
  const result = await page.request('framesAt', { key: 'BVtest:2', times: [10000, 20000] });
  assert.equal(result.error, undefined);
  assert.deepEqual(Array.from(result.data, frame => frame.timeMs), [10000, 20000]);
  assert.equal(page.video.currentTime, 5);
  assert.equal(page.video.paused, false);
});

test('采当前帧不等待不会触发的seeked，原暂停状态保持', async () => {
  const page = environment();
  page.video.paused = true;
  const result = await page.request('framesAt', { key: 'BVtest:2', times: [5000] });
  assert.equal(result.data.length, 1);
  assert.equal(page.video.paused, true);
});

test('连续采帧只定位一次，使用实际帧时间且播放时静音', async () => {
  const page = environment();
  const result = page.request('framesAt', { key: 'BVtest:2', times: [10500, 10000, 10250], continuous: true });
  await new Promise(setImmediate);
  assert.deepEqual(page.seeks, [10]);
  assert.deepEqual(page.playMutes, [true]);
  for (const time of [9.99, 10.01, 10.17, 10.26, 10.51]) page.frame(time);
  assert.deepEqual(Array.from((await result).data, frame => frame.timeMs), [10010, 10260, 10510]);
  assert.deepEqual(page.seeks, [10, 5]);
  assert.deepEqual(page.playMutes, [true, false]);
  assert.equal(page.video.paused, false);
  assert.equal(page.video.muted, false);
});

test('取消连续采帧会清理回调并恢复暂停和静音状态', async () => {
  const page = environment();
  page.video.paused = true;
  page.video.muted = true;
  const result = page.request('framesAt', { key: 'BVtest:2', times: [10000, 10250], continuous: true, captureId: 'continuous' });
  await new Promise(setImmediate);
  assert.equal(page.callbacks.size, 1);
  await page.request('cancelFramesAt', { captureId: 'continuous' });
  assert.match((await result).error, /aborted/i);
  assert.equal(page.callbacks.size, 0);
  assert.equal(page.events.size, 0);
  assert.equal(page.video.currentTime, 5);
  assert.equal(page.video.paused, true);
  assert.equal(page.video.muted, true);
});

test('视频结束时返回已经采集的画面，不等待未到达的目标', async () => {
  const page = environment();
  const result = page.request('framesAt', { key: 'BVtest:2', times: [99500, 100000], continuous: true });
  await new Promise(setImmediate);
  page.frame(99.51);
  page.events.get('ended')();
  assert.deepEqual(Array.from((await result).data, frame => frame.timeMs), [99510]);
  assert.equal(page.callbacks.size, 0);
  assert.equal(page.video.currentTime, 5);
});

test('连续采帧超时时停止播放并移除帧回调', async () => {
  const timers = new Set();
  const page = environment({
    setTimeout: callback => (timers.add(callback), callback),
    clearTimeout: callback => timers.delete(callback)
  });
  page.video.paused = true;
  const result = page.request('framesAt', { key: 'BVtest:2', times: [10000], continuous: true });
  await new Promise(setImmediate);
  assert.equal(timers.size, 1);
  assert.equal(page.callbacks.size, 1);
  for (const fire of timers) fire();
  assert.match((await result).error, /连续截帧超时/);
  assert.equal(timers.size, 0);
  assert.equal(page.callbacks.size, 0);
  assert.equal(page.video.currentTime, 5);
  assert.equal(page.video.paused, true);
  assert.equal(page.video.muted, false);
});

test('拒绝其他视频的采帧请求', async () => {
  const page = environment();
  const result = await page.request('framesAt', { key: 'other', times: [10000] });
  assert.match(result.error, /视频已切换/);
  assert.equal(page.seeks.length, 0);
});
