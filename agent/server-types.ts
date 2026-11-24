import type { Server } from 'node:http';
import type { Tracing } from './tracing.js';

export interface AgentConnection {
  url: string;
  token: string;
  pid: number;
}

export interface AgentServer extends Server {
  connection: AgentConnection;
}

export interface CreateServerOptions {
  root?: string;
  port?: number;
  runner?: (...args: any[]) => any;
  asrRunner?: (...args: any[]) => any;
  apiKey?: string;
  bailianApiKey?: string;
  searchApiKey?: string;
  tracing?: Tracing;
  timeoutMs?: number;
  asrTimeoutMs?: number;
  maxAudioBytes?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  translationFetch?: typeof fetch;
  translationTimeoutMs?: number;
  maxTasks?: number;
  audioReceiveTimeoutMs?: number;
  maxConcurrentTasks?: number;
  requestTimeoutMs?: number;
  taskRetentionMs?: number;
}
