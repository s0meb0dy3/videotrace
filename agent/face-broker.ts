import { randomUUID } from 'node:crypto';

/** 人脸采集的统一输入输出类型，供任务 worker 和页面适配器共享。 */
export interface FaceFrame {
  timeMs: number;
  image?: string;
  faces: Array<{ box: number[]; score: number }>;
}
interface Evidence {
  images: string[];
  tracks: Array<{ label: string; timeMs: number; faceIndex: number }>;
  times: number[];
  status?: string;
}
type Capture = { frames: FaceFrame[]; evidence?: Evidence; error?: 'browser_error' };
type CaptureOutcome = Capture | 'timeout' | 'cancelled';

export interface FaceBroker {
  candidates: Set<string>;
  sources: Map<string, { image: string; box: number[] }>;
  inspect(range: { startMs: number; endMs: number }): Promise<unknown>;
  receive(requestId: string, frames: unknown, evidence?: unknown, error?: unknown): boolean;
}

interface PendingCapture {
  requestId: string;
  times: number[];
  finish: (outcome: CaptureOutcome) => void;
}

export function createFaceBroker(publish: (data: unknown) => void | Promise<unknown>, signal: AbortSignal, timeoutMs = 10_000): FaceBroker {
  let pending: PendingCapture | undefined;
  const candidates = new Set<string>();
  const sources: FaceBroker['sources'] = new Map();
  return {
    candidates, sources,
    async inspect({ startMs, endMs }) {
      const range = { startMs, endMs };
      const times = Array.from({ length: Math.ceil((endMs - startMs) / 250) }, (_, i) => startMs + i * 250);
      const requestId = randomUUID();
      const outcome = await new Promise<CaptureOutcome>(resolve => {
        const finish = (value: CaptureOutcome) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          pending = undefined;
          resolve(value);
        };
        const abort = () => finish('cancelled');
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        if (signal.aborted) return abort();
        pending = { requestId, times, finish };
        signal.addEventListener('abort', abort, { once: true });
        void publish({ requestId, times, continuous: true, deadline: Date.now() + timeoutMs });
      });
      if (typeof outcome === 'string' || outcome.error || !outcome.frames.length) {
        const reason = typeof outcome === 'string' ? outcome : outcome.error ?? 'no_frames';
        return { status: 'unavailable', reason, range, detections: [], representativeFrames: [] };
      }
      const { frames, evidence } = outcome;
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
      const visual = evidence && {
        images: evidence.images,
        times: evidence.times,
        status: evidence.status,
        tracks: evidence.tracks.map(({ label, timeMs, faceIndex }) => {
          const candidateId = representativeFrames.find(frame => frame.timeMs === timeMs)?.faces[faceIndex]?.candidateId;
          return { label, timeMs, candidateId };
        })
      };
      return { status: 'ok', range, detections, representativeFrames, visual };
    },
    receive(requestId, frames, evidence, error) {
      if (!pending || pending.requestId !== requestId) return false;
      if (!validFrames(frames, pending.times)) throw new TypeError('无效采帧结果');
      if (error !== undefined) {
        if (error !== 'browser_error' || frames.length || evidence !== undefined) throw new TypeError('无效的采帧状态');
        pending.finish({ frames, error });
      } else if (evidence === undefined) {
        pending.finish({ frames });
      } else {
        if (!validEvidence(evidence, frames)) throw new TypeError('无效的画面对照图');
        pending.finish({ frames, evidence });
      }
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

/** 证据图不保存；轨迹候选必须能指回真正用于裁头像的原始帧。 */
function validEvidence(value: unknown, frames: FaceFrame[]): value is Evidence {
  if (!value || typeof value !== 'object') return false;
  const { images, times, tracks, status } = value as Evidence;
  return (status === undefined || ['stable_tracks', 'full_frame_only', 'no_frames'].includes(status))
    && Array.isArray(images) && images.length <= 2
    && images.every(image => typeof image === 'string' && image.length <= 150_000 && /^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(image))
    && Array.isArray(times) && times.length <= frames.length && times.every((time, index) =>
      (!index || time > times[index - 1]) && frames.some(frame => frame.timeMs === time))
    && Array.isArray(tracks) && tracks.length <= 32 && tracks.every(track => track && /^T[1-9][0-9]?$/.test(track.label)
      && Number.isInteger(track.faceIndex) && track.faceIndex >= 0
      && frames.some(frame => frame.timeMs === track.timeMs && frame.image && frame.faces[track.faceIndex]));
}
