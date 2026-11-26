import { taskStatus, terminalTask } from './agent-view.js';

function node(tag, className, text = '') {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function stepItem(event, text, className = '') {
  const item = node('li', className);
  if (Number.isFinite(event.createdAt)) {
    const time = node('time', 'agent-step-time', clock.format(event.createdAt));
    time.dateTime = new Date(event.createdAt).toISOString();
    item.append(time);
  }
  const content = node('span', '', text);
  item.append(content);
  return { item, content };
}

function toolDetails(item, title, value) {
  if (value === undefined) return;
  const details = node('details', 'agent-tool-data');
  details.append(node('summary', '', title), node('pre', '', typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
  item.append(details);
}

export class AgentChat {
  constructor(handlers) {
    this.handlers = handlers;
    this.history = node('div', 'agent-history');
    this.history.setAttribute('aria-label', 'Agent 对话');
    this.empty = node('div', 'agent-empty');
    this.start = node('button', 'tool-button', '开始分析');
    this.start.onclick = () => handlers.analyze();
    this.empty.append(node('p', '', '先分析当前视频，再向 Agent 提问。'));
    this.messages = node('div', 'agent-messages');
    this.bootstrap = node('div', 'agent-bootstrap');
    this.bootstrap.append(this.start);
    this.history.append(this.empty, this.messages, this.bootstrap);
    this.form = node('form', 'agent-form');
    this.input = node('textarea', 'agent-input');
    this.input.placeholder = '询问这个视频…';
    this.input.setAttribute('aria-label', this.input.placeholder);
    this.input.rows = 2;
    this.input.maxLength = 8000;
    this.send = node('button', 'agent-send', '发送');
    this.send.type = 'submit';
    this.form.append(this.input, this.send);
    this.notice = node('div', 'agent-notice');
    this.notice.setAttribute('role', 'status');
    this.retry = node('button', 'retry', '重新连接');
    this.retry.type = 'button';
    this.retry.onclick = () => handlers.retry();
    this.noticeText = node('span', '');
    this.notice.append(this.noticeText, this.retry);
    this.form.onsubmit = async event => {
      event.preventDefault();
      const text = this.input.value.trim();
      if (!text || this.send.disabled) return;
      const generation = this.turns;
      this.input.value = '';
      if (!await handlers.send(text) && this.turns === generation && !this.input.value) this.input.value = text;
    };
    this.clear();
  }

  clear() {
    this.turns = new Map();
    this.messages.replaceChildren();
    this.empty.hidden = false;
    this.input.value = '';
    this.setState({ available: false });
  }

  setState({ available, ready = false, busy = false, error = '' }) {
    this.input.disabled = this.send.disabled = !available || !ready || busy || Boolean(error);
    this.start.disabled = !available || busy;
    this.bootstrap.hidden = !available || ready || busy;
    this.input.placeholder = ready ? '询问这个视频…' : '分析完成后可继续提问';
    this.error = error;
    this.notice.hidden = !this.visible || !error;
    this.noticeText.textContent = error;
  }

  setTasks(tasks) {
    const atEnd = this.history.scrollHeight - this.history.clientHeight - this.history.scrollTop < 48;
    this.empty.hidden = Boolean(tasks.length);
    for (const task of tasks) {
      const turn = this.turns.get(task.id) || this.addTurn(task.id);
      turn.prompt.textContent = task.prompt || '分析当前视频';
      turn.task = task;
      this.renderAnswer(turn);
      const status = taskStatus[task.status] || '';
      turn.status.textContent = task.error ? `${status}：${task.error}` : status;
    }
    if (atEnd) this.history.scrollTop = this.history.scrollHeight;
  }

  addTurn(id) {
    const turn = { root: node('article', 'agent-turn'), prompt: node('p', 'agent-prompt'), answer: node('p', 'agent-answer'),
      status: node('p', 'agent-turn-status'), details: node('details', 'agent-details'), steps: node('ol', 'agent-steps'), seen: new Set(), round: 0, reply: '' };
    const heading = node('summary', '', '过程详情');
    turn.details.append(heading, turn.steps);
    turn.root.append(turn.prompt, turn.details, turn.answer, turn.status);
    this.messages.append(turn.root);
    this.turns.set(id, turn);
    turn.details.ontoggle = async () => {
      if (!turn.details.open || turn.loaded || turn.loading || !terminalTask(turn.task?.status)) return;
      turn.loading = true;
      try { await this.handlers.replay(id); turn.loaded = true; }
      catch { heading.textContent = '过程详情（重新展开以重试）'; }
      finally { turn.loading = false; }
      if (turn.loaded) heading.textContent = '过程详情';
    };
    return turn;
  }

  renderAnswer(turn) {
    const { answer, previousTaskId, summary, status } = turn.task;
    const fallback = !previousTaskId && (summary?.overview || summary);
    turn.answer.textContent = answer || (terminalTask(status) ? fallback : turn.reply || fallback) || '';
    turn.answer.hidden = !turn.answer.textContent;
  }

  addEvent(id, event) {
    const turn = this.turns.get(id);
    if (!turn || turn.seen.has(event.id)) return;
    if (event.id !== undefined) turn.seen.add(event.id);
    const { type, data } = event;
    let description;
    if (type === 'status') {
      description = taskStatus[data.status];
      if (description) turn.status.textContent = description;
      if (terminalTask(data.status)) turn.loaded = true;
    } else if (type === 'transcript_ready') description = '转写已就绪';
    else if (type === 'speaker_updated') description = data.label ? `说话人更新：${data.label}` : '说话人头像已更新';
    else if (type === 'summary_updated') description = '总结已更新';
    else if (type === 'capture_faces') description = '请求检查视频画面';
    else if (type === 'pi') {
      const part = data.assistantMessageEvent;
      const running = !terminalTask(turn.task?.status);
      if (data.type === 'message_update' && part?.type === 'thinking_delta') {
        if (!turn.thinking) {
          const { item, content } = stepItem(event, '', 'agent-thinking');
          turn.thinking = content;
          turn.steps.append(item);
        }
        turn.thinking.textContent += part.delta;
      } else if (data.type === 'message_update' && part?.type === 'text_delta' && running) {
        turn.reply += part.delta;
        this.renderAnswer(turn);
      } else if (data.type === 'message_end' && data.message?.role === 'assistant') {
        const thinking = data.message.content.filter(part => part.type === 'thinking').map(part => part.thinking).join('\n\n');
        if (thinking && turn.thinking) turn.thinking.textContent = thinking;
        else if (thinking) turn.steps.append(stepItem(event, thinking, 'agent-thinking').item);
        turn.thinking = null;
        if (running) {
          turn.reply = data.message.content.some(part => part.type === 'toolCall') ? '' : data.message.content
            .filter(part => part.type === 'text').map(part => part.text).join('');
          this.renderAnswer(turn);
        }
      } else if (data.type === 'turn_start') {
        turn.round++;
        turn.reply = '';
        if (running) this.renderAnswer(turn);
        description = `模型第 ${turn.round} 轮`;
      } else if (data.type === 'turn_end') description = '模型轮次结束';
      else if (data.type === 'tool_execution_start' || data.type === 'tool_execution_end') {
        const start = data.type === 'tool_execution_start';
        const duration = Number.isFinite(data.durationMs) ? `（${(data.durationMs / 1000).toFixed(1)} 秒）` : '';
        const text = start ? `调用工具：${data.toolName}` : `工具${data.isError ? '失败' : '完成'}：${data.toolName}${duration}`;
        const { item } = stepItem(event, text);
        const output = data.result?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');
        toolDetails(item, start ? '输入参数' : '输出结果', start ? data.args : output || data.result?.details);
        turn.steps.append(item);
      }
    }
    if (description) turn.steps.append(stepItem(event, description).item);
  }

  setVisible(visible) {
    this.visible = visible;
    this.history.hidden = this.form.hidden = !visible;
    this.notice.hidden = !visible || !this.error;
  }
}
