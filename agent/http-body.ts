import type http from 'node:http';

export class BodyTooLargeError extends Error {
  constructor() {
    super('请求体过大');
    this.name = 'BodyTooLargeError';
  }
}

/** 按字节读取请求体，最后一次性解码，避免中文跨 chunk 被破坏。 */
export async function readRequestBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
