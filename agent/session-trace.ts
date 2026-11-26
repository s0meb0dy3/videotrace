import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEvent, Task } from './core/types.js';

/** 将已有的任务和 PI 事件整理成一份按会话追加的本地日志。 */
export class SessionTrace {
  private readonly calls = new Map<string, Map<string, unknown>>();

  constructor(private readonly directory: string) {}

  private path(task: Task) {
    // 视频键来自客户端，不直接用作文件路径；无视频键的任务单独记录。
    const name = task.sessionKey ? createHash('sha256').update(task.sessionKey).digest('hex') : task.id;
    return join(this.directory, `${name}.jsonl`);
  }

  async start(task: Task) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // 从文件延续编号，不受服务重启或旧任务快照清理影响。
    const existing = await readFile(this.path(task), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    // 意外退出可能只写了半行；保留之前完整的轨迹，下一条从新行开始。
    let turn = 0;
    for (const line of existing.trimEnd().split('\n').reverse()) {
      if (!line) break;
      try { turn = JSON.parse(line).turn; break; } catch { /* 跳过不完整行 */ }
    }
    task.traceTurn = turn + 1;
    const context = task.document?.context as Task['context'] ?? task.context;
    await this.append(task, task.createdAt, {
      type: 'message_end', role: 'user',
      text: task.prompt || (task.previousTaskId ? '继续分析视频。' : '推断发言人并概括视频。'),
      video: { key: task.sessionKey, title: context?.title, part: context?.part }
    }, existing && !existing.endsWith('\n') ? '\n' : '');
  }

  async record(task: Task, event: AgentEvent) {
    if (task.traceTurn === undefined) return;
    const data = event.data as any;
    let row: Record<string, unknown>;
    if (event.type === 'status') {
      row = { type: 'status', status: data.status, error: data.error };
      if (['completed', 'failed', 'cancelled', 'timed_out'].includes(data.status)) {
        const pending = this.calls.get(task.id);
        for (const [toolCallId, call] of pending ?? []) {
          await this.append(task, event.createdAt, { type: 'tool_result', toolCallId, ...(call as object), status: 'no_result' });
        }
        this.calls.delete(task.id);
      }
    } else if (event.type === 'transcript_ready') {
      row = { type: 'transcript_ready', cueCount: Array.isArray(task.document?.cues) ? task.document.cues.length : undefined };
    } else if (event.type !== 'pi') return;
    else if (data.type === 'agent_start' || data.type === 'agent_end') {
      // agent_end 自带消息数组，这里不重复写入。
      row = { type: data.type };
    } else if (data.type === 'message_end' && data.message?.role === 'assistant') {
      const { model, stopReason, durationMs, usage, content } = data.message;
      const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const thinking = content.filter(block => block.type === 'thinking').map(block => block.thinking).join('\n');
      row = { type: 'message_end', role: 'assistant', model, stopReason, durationMs, usage, text: text || undefined, thinking: thinking || undefined };
    } else if (data.type === 'tool_execution_start') {
      const calls = this.calls.get(task.id) ?? new Map();
      calls.set(data.toolCallId, { toolName: data.toolName, args: data.args });
      this.calls.set(task.id, calls);
      return;
    } else if (data.type === 'tool_execution_end') {
      const calls = this.calls.get(task.id);
      const call = calls?.get(data.toolCallId);
      calls?.delete(data.toolCallId);
      const { toolCallId, toolName, durationMs, isError, result } = data;
      // 只记录工具的文本结果和元数据，避免写入截图等二进制内容。
      const text = result?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
      let output: unknown = text || result?.details;
      if (text) { try { output = JSON.parse(text); } catch { /* 普通文本原样保留 */ } }
      row = { type: 'tool_result', toolCallId, toolName, ...(call as object), durationMs, isError, result: output };
    } else return;
    await this.append(task, event.createdAt, row);
  }

  private async append(task: Task, timestamp: number, row: Record<string, unknown>, prefix = '') {
    const line = JSON.stringify({ turn: task.traceTurn, taskId: task.id, timestamp: new Date(timestamp).toISOString(), ...row });
    await appendFile(this.path(task), `${prefix}${line}\n`, { mode: 0o600 });
  }
}
