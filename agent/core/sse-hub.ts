/** SSE 连接管理：统一广播、心跳、回放期间缓冲和断开清理。 */
import type http from 'node:http';
import type { AgentEvent } from './types.js';

type Response = http.ServerResponse;
type Client = { response: Response; paused: boolean; buffered: AgentEvent[] };

const writable = (response: Response) => !response.destroyed && !response.writableEnded && !response.writableFinished;

export class SseHub {
  private readonly listeners = new Map<string, Set<Client>>();
  private readonly heartbeats = new Map<Response, NodeJS.Timeout>();

  /** paused=true 用于先订阅再回放，避免异步回放期间丢事件。 */
  subscribe(id: string, response: Response, paused = false): () => void {
    const client: Client = { response, paused, buffered: [] };
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id)!.add(client);
    const heartbeat = setInterval(() => {
      if (!writable(response)) return this.remove(id, client);
      try {
        if (!response.write(': heartbeat\n\n')) response.destroy();
      } catch { response.destroy(); }
    }, 15_000);
    heartbeat.unref();
    this.heartbeats.set(response, heartbeat);
    const cleanup = () => this.remove(id, client);
    response.once('close', cleanup);
    response.once('error', cleanup);
    return cleanup;
  }

  /** 回放完成后放行缓冲事件，只发送游标之后的事件。 */
  resume(id: string, response: Response, after: number): void {
    const client = [...(this.listeners.get(id) || [])].find(item => item.response === response);
    if (!client || !writable(response)) return;
    for (const event of client.buffered.sort((a, b) => a.id - b.id)) {
      if (event.id <= after) continue;
      if (!this.writeEvent(response, event)) return this.remove(id, client);
      after = event.id;
    }
    client.buffered = [];
    client.paused = false;
  }

  broadcast(id: string, event: AgentEvent, type = event.type): void {
    for (const client of [...(this.listeners.get(id) || [])]) {
      if (client.paused) {
        client.buffered.push(type === event.type ? event : { ...event, type });
        continue;
      }
      if (!this.writeEvent(client.response, event, type)) this.remove(id, client);
    }
  }

  writeEvent(response: Response, event: AgentEvent, type = event.type): boolean {
    return this.writeRaw(response, `id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  writeRaw(response: Response, payload: string): boolean {
    if (!writable(response)) return false;
    try { return response.write(payload); } catch { response.destroy(); return false; }
  }

  close(id: string): void {
    for (const client of [...(this.listeners.get(id) || [])]) {
      if (writable(client.response)) client.response.end();
      this.remove(id, client);
    }
  }

  clear(id: string): void {
    for (const client of [...(this.listeners.get(id) || [])]) this.remove(id, client);
  }

  private remove(id: string, client: Client): void {
    this.listeners.get(id)?.delete(client);
    if (!this.listeners.get(id)?.size) this.listeners.delete(id);
    const heartbeat = this.heartbeats.get(client.response);
    if (heartbeat) clearInterval(heartbeat);
    this.heartbeats.delete(client.response);
  }
}
