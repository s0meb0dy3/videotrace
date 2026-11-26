import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaceBroker } from '../dist/agent/face-broker.js';

const range = { startMs: 2000, endMs: 3000 };

test('采帧分别报告超时、空画面、浏览器错误和取消', async () => {
  for (const reason of ['timeout', 'no_frames', 'browser_error', 'cancelled']) {
    const controller = new AbortController();
    let request;
    const broker = createFaceBroker(data => { request = data; }, controller.signal, 10);
    const result = broker.inspect(range);
    if (reason === 'cancelled') controller.abort();
    if (reason === 'no_frames') assert.equal(broker.receive(request.requestId, []), true);
    if (reason === 'browser_error') assert.equal(broker.receive(request.requestId, [], undefined, reason), true);
    assert.deepEqual(await result, { status: 'unavailable', reason, range, detections: [], representativeFrames: [] });
  }
});

test('没有检测到人脸也返回完整画面，但不生成头像候选', async () => {
  let request;
  const broker = createFaceBroker(data => { request = data; }, new AbortController().signal);
  const result = broker.inspect(range);
  const image = '/9j/QVZBVEFS';
  assert.equal(broker.receive(request.requestId, [{ timeMs: 2000, faces: [] }], {
    images: [image], times: [2000], tracks: [], status: 'full_frame_only'
  }), true);
  const scan = await result;
  assert.equal(scan.status, 'ok');
  assert.deepEqual(scan.visual.images, [image]);
  assert.deepEqual(scan.visual.tracks, []);
  assert.equal(broker.sources.size, 0);
});
