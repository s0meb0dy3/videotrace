declare module '../extension/transcript.js' {
  export function normalizeTranscript(raw: unknown): unknown[];
  export function paragraphize(cues: unknown[]): unknown[];
}
