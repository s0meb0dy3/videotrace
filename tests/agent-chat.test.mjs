import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentChat } from '../extension/agent-chat.js';

class Node {
  children = [];
  textContent = '';
  setAttribute() {}
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
}

test('completed turn details replay provider thinking and tool activity in order', async () => {
  globalThis.document = { createElement: () => new Node() };
  try {
    const chat = new AgentChat({ replay: async id => {
      const emit = (seq, type, data) => chat.addEvent(id, { id: seq, type, data });
      emit(1, 'status', { status: 'analyzing' });
      emit(2, 'pi', { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '第一' } });
      emit(3, 'pi', { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '段' } });
      emit(4, 'pi', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '第一段' }] } });
      emit(5, 'pi', { type: 'tool_execution_start', toolName: 'update_speaker', args: { label: '嘉宾' } });
      emit(5, 'pi', { type: 'tool_execution_start', toolName: 'update_speaker' });
      emit(6, 'speaker_updated', { label: '嘉宾' });
      emit(7, 'pi', { type: 'tool_execution_end', toolName: 'update_speaker', durationMs: 150, result: { content: [{ type: 'text', text: '成功' }] } });
      emit(8, 'status', { status: 'completed' });
    } });
    chat.setTasks([{ id: 'turn', prompt: '谁在说话？', answer: '嘉宾', status: 'completed' }]);
    const turn = chat.turns.get('turn');
    assert.equal(turn.answer.textContent, '嘉宾');
    assert.deepEqual(turn.steps.children, []);
    turn.details.open = true;
    await turn.details.ontoggle();
    const steps = turn.steps.children;
    assert.deepEqual(steps.map(step => step.children[0].textContent), ['正在分析', '第一段', '调用工具：update_speaker', '说话人更新：嘉宾', '工具完成：update_speaker（0.1 秒）', '已完成']);
    assert.deepEqual(JSON.parse(steps[2].children[1].children[1].textContent), { label: '嘉宾' });
    assert.equal(steps[4].children[1].children[1].textContent, '成功');
    await turn.details.ontoggle();
    assert.equal(steps.length, 6);
  } finally { delete globalThis.document; }
});

test('follow-up reply streams separately from details, then uses the saved answer', () => {
  globalThis.document = { createElement: () => new Node() };
  try {
    let starts = 0;
    const chat = new AgentChat({ analyze: () => starts++ });
    chat.setState({ available: true });
    assert.equal(chat.bootstrap.hidden, false);
    assert.equal(chat.send.disabled, true);
    chat.start.onclick();
    assert.equal(starts, 1);
    const task = { id: 'turn', previousTaskId: 'initial', status: 'analyzing', prompt: '还有谁？' };
    chat.setTasks([task]);
    const emit = (type, payload = {}) => chat.addEvent(task.id, { type: 'pi', data: { type, ...payload } });
    emit('turn_start');
    emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: '可能' } });
    const turn = chat.turns.get(task.id);
    assert.equal(turn.answer.textContent, '可能');
    assert.equal(turn.steps.children[0].children[0].textContent, '模型第 1 轮');
    chat.setTasks([{ ...task, status: 'completed', answer: '还有一位主持人。' }]);
    chat.setState({ available: true, ready: true });
    assert.equal(turn.answer.textContent, '还有一位主持人。');
    assert.equal(chat.bootstrap.hidden, true);
    assert.equal(chat.send.disabled, false);
  } finally { delete globalThis.document; }
});
