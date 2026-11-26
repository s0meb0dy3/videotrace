import assert from 'node:assert/strict';
import test from 'node:test';
import { createFaceCapture } from '../extension/face-capture.js';

const prefix = 'data:image/jpeg;base64,';
const times = [0, 250, 500];
const detection = x => ({ boundingBox: { originX: x, originY: 20, width: 25, height: 30 }, categories: [{ score: .9 }] });

function mockCanvas(t) {
  const text = [];
  const previous = globalThis.document;
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  globalThis.document = { createElement(tag) {
    assert.equal(tag, 'canvas');
    let sampled;
    const surface = {
      getContext: () => ({
        drawImage: (image, ...args) => { sampled = { image, width: args.length === 8 ? args[2] : 100 }; },
        getImageData: () => ({ data: new Uint8ClampedArray(surface.width * surface.height * 4)
          .fill(sampled.image.cut ? 200 : sampled.width < 90 && sampled.image.faceChanged ? 200 : 30) }),
        fillRect() {}, strokeRect() {}, measureText: () => ({ width: 12 }), fillText: label => text.push(label)
      }),
      toDataURL: (type, quality) => {
        assert.equal(type, 'image/jpeg');
        assert.ok(quality > 0);
        return prefix + '/9j/' + 'A'.repeat(Math.round(surface.width * surface.height * 2));
      }
    };
    return surface;
  } };
  return text;
}

function capture({ faces = time => time === 250 ? [detection(60), detection(10)] : [detection(10), detection(60)],
  cut, faceChanged, oversized, captureFrames } = {}) {
  return createFaceCapture({
    captureFrames: captureFrames || (async times => times.map(timeMs => ({ timeMs, dataUrl: `${prefix}/9j/${timeMs}${oversized ? 'A'.repeat(130_000) : ''}` }))),
    decode: async dataUrl => {
      const timeMs = Number(dataUrl.slice((prefix + '/9j/').length).match(/^\d+/)[0]);
      return { width: oversized ? 700 : 100, height: oversized ? 456 : 100, timeMs, cut: timeMs === cut, faceChanged: timeMs === faceChanged };
    },
    getDetector: async () => ({ detect: source => ({ detections: faces(source.timeMs) }) })
  });
}

test('captures actual adjacent frames, tracks reordered detections, and keeps a bounded candidate source', async t => {
  const text = mockCanvas(t);
  const options = { continuous: true };
  const signal = new AbortController().signal;
  const result = await capture({
    oversized: true,
    faces: time => time === 255 ? [detection(460), detection(110)] : [detection(110), detection(460)],
    captureFrames: async (samples, capturedSignal, capturedOptions) => {
      assert.deepEqual(samples, times);
      assert.equal(capturedSignal, signal);
      assert.equal(capturedOptions, options);
      return [509, 8, 255].map(timeMs => ({ timeMs, dataUrl: `${prefix}/9j/${timeMs}${'A'.repeat(130_000)}` }));
    }
  })(times, signal, options);
  const { evidence, frames } = result;
  assert.deepEqual(frames.map(frame => frame.timeMs), [8, 255, 509]);
  assert.deepEqual(evidence.times, [8, 255, 509]);
  assert.equal(evidence.status, 'stable_tracks');
  assert.equal(evidence.images.length, 2);
  assert.deepEqual(evidence.tracks, [{ label: 'T1', timeMs: 255, faceIndex: 0 }, { label: 'T2', timeMs: 255, faceIndex: 1 }]);
  assert.equal(frames.filter(frame => frame.image).length, 1);
  for (const track of evidence.tracks) {
    const frame = frames.find(frame => frame.timeMs === track.timeMs);
    assert.ok(frame.image && frame.faces[track.faceIndex]);
  }
  for (const image of [...evidence.images, frames[1].image]) {
    assert.match(image, /^\/9j\/[A-Za-z0-9+/]*$/);
    assert.ok(image.length <= 125_000);
  }
  for (const label of ['T1', 'T2', '0.008 s', '0.255 s', '0.509 s']) assert.ok(text.includes(label));
});

test('does not link tracks across likely cuts, face appearance changes, gaps, or ambiguous overlap', async t => {
  mockCanvas(t);
  for (const [samples, setup] of [
    [times, { cut: 500 }],
    [times, { faceChanged: 500 }],
    [[0, 250, 700], {}],
    [times, { faces: () => [detection(10), detection(18)] }],
    [times, { faces: time => time === 500 ? [detection(10)] : [detection(10), detection(60)] }]
  ]) {
    const { evidence, frames } = await capture(setup)(samples, undefined, { continuous: true });
    assert.equal(evidence.status, 'full_frame_only');
    assert.equal(evidence.images.length, 1);
    assert.deepEqual(evidence.times, [250]);
    assert.deepEqual(evidence.tracks, []);
    assert.equal(frames.find(frame => frame.image).timeMs, 250);
  }
});

test('keeps the annotated full image without detected faces, and reports when capture is empty', async t => {
  const text = mockCanvas(t);
  const options = { continuous: true };
  const { frames, evidence } = await capture({ faces: () => [] })(times, undefined, options);
  assert.ok(frames.every(frame => !frame.image));
  assert.equal(evidence.status, 'full_frame_only');
  assert.equal(evidence.images.length, 1);
  assert.deepEqual(evidence.times, [250]);
  assert.deepEqual(evidence.tracks, []);
  assert.deepEqual(text, ['0.250 s']);
  const unavailable = { frames: [], evidence: { images: [], tracks: [], times: [], status: 'no_frames' } };
  assert.deepEqual(await capture()([], undefined, options), unavailable);
  assert.deepEqual(await capture({ captureFrames: async () => [] })(times, undefined, options), unavailable);
});
