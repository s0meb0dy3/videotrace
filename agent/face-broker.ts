import { randomUUID } from 'node:crypto';

/** 人脸采集的统一输入输出类型，供任务 worker 和页面适配器共享。 */
export interface FaceFrame {
  timeMs: number;
  image?: string;
  faces: Array<{ box: number[]; score: number }>;
}
export interface FaceBroker {
  candidates: Set<string>;
  sources: Map<string, { image: string; box: number[] }>;
  inspect(range: { startMs: number; endMs: number }): Promise<unknown>;
  receive(requestId: string, frames: unknown): boolean;
}

interface PendingCapture {
  requestId: string;
  times: number[];
  finish: (frames: FaceFrame[] | null) => void;
}

export function createFaceBroker(publish: (data: unknown) => void | Promise<unknown>, signal: AbortSignal, timeoutMs = 90_000): FaceBroker {
  let pending: PendingCapture | undefined;
  const candidates = new Set<string>();
  const sources: FaceBroker['sources'] = new Map();
  return {
    candidates, sources,
    async inspect({ startMs, endMs }) {
      const range = { startMs, endMs };
      const times = Array.from({ length: Math.ceil((endMs - startMs) / 1000) }, (_, i) => startMs + i * 1000);
      const requestId = randomUUID();
      const frames = await new Promise<FaceFrame[] | null>(resolve => {
        const finish = (value: FaceFrame[] | null) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          pending = undefined;
          resolve(value);
        };
        const abort = () => finish(null);
        const timer = setTimeout(abort, timeoutMs);
        if (signal.aborted) return abort();
        pending = { requestId, times, finish };
        signal.addEventListener('abort', abort, { once: true });
        void publish({ requestId, times, deadline: Date.now() + timeoutMs });
      });
      if (!frames?.length) return { status: 'unavailable', range, detections: [], representativeFrames: [] };
      const detections = [];
      const representativeFrames = [];
      for (const [index, frame] of frames.entries()) {
        const faces = frame.faces.map((face, faceIndex) => {
          const candidateId = `${requestId}-${index}-${faceIndex}`;
          if (frame.image) {
            candidates.add(candidateId);
            sources.set(candidateId, { image: frame.image, box: face.box });
          }
          return { box: face.box, score: face.score, ...(frame.image ? { candidateId } : {}) };
        });
        detections.push({ timeMs: frame.timeMs, faces });
        if (frame.image) representativeFrames.push({ timeMs: frame.timeMs, image: frame.image, faces });
      }
      return { status: 'ok', range, detections, representativeFrames };
    },
    receive(requestId, frames) {
      if (!pending || pending.requestId !== requestId) return false;
      if (!validFrames(frames, pending.times)) throw new TypeError('无效采帧结果');
      pending.finish(frames);
      return true;
    },
  };
}

function validFrames(frames: unknown, times: number[]): frames is FaceFrame[] {
  if (!Array.isArray(frames) || frames.length > times.length || frames.filter(frame => frame?.image !== undefined).length > 3) return false;
  return frames.every((frame, index) => frame && Number.isFinite(frame.timeMs)
    && times.some(time => Math.abs(time - frame.timeMs) <= 500)
    && (!index || frame.timeMs > frames[index - 1].timeMs)
    && Array.isArray(frame.faces) && frame.faces.length <= 32
    && frame.faces.every(face => face && Number.isFinite(face.score) && face.score >= 0 && face.score <= 1
      && Array.isArray(face.box) && face.box.length === 4 && face.box.every(number => Number.isFinite(number) && number >= 0 && number <= 1)
      && face.box[2] > 0 && face.box[3] > 0 && face.box[0] + face.box[2] <= 1.00001 && face.box[1] + face.box[3] <= 1.00001)
    && (frame.image === undefined || (typeof frame.image === 'string' && frame.image.length <= 280_000 && /^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(frame.image))));
}
