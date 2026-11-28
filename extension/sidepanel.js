// 只负责在「总结 / 转写 / Agent」三个空页面之间切换。
const tabs = document.querySelectorAll(".tab");
const views = document.querySelectorAll(".view");

for (const tab of tabs) {
  tab.onclick = () => {
    for (const t of tabs) t.classList.toggle("active", t === tab);
    for (const v of views) v.hidden = v.id !== tab.dataset.view;
  };
}

// 取到三个元素
const messagesEl = document.querySelector("#messages");
const inputEl = document.querySelector("#input");
const sendBtn = document.querySelector("#send");

// 滚到消息区底部（让最新消息可见）
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// 往消息列表追加一条普通气泡（我发的 / 错误提示）
function addMessage(text, who) {
  const div = document.createElement("div");
  div.className = `msg ${who}`;
  div.textContent = text;
  messagesEl.append(div);
  scrollToBottom();
}

// 点发送
sendBtn.onclick = async () => {
  const text = inputEl.value.trim();
  if (!text) return;

  addMessage(text, "me");
  inputEl.value = "";

  // 生成中：禁用输入，按钮转圈
  sendBtn.disabled = true;
  inputEl.disabled = true;
  sendBtn.classList.add("loading");

  // 本轮的“当前文本块”状态：同类续写、异类新建，保证按到达顺序显示
  let currentKind = null;   // "think" | "bot" | null
  let append = null;        // 当前块的“追加文字”函数
  const toolBlocks = new Map();   // toolCallId -> { summary, resultEl }

  // 开始一个新块
  function startBlock(kind) {
    if (kind === "bot") {
      // 正文：普通气泡
      const el = document.createElement("div");
      el.className = "msg bot";
      messagesEl.append(el);
      append = t => { el.textContent += t; };
    } else {
      // 思考：可折叠，默认只露一行预览
      const details = document.createElement("details");
      details.className = "msg think";
      const summary = document.createElement("summary");
      const body = document.createElement("div");
      body.className = "think-body";
      details.append(summary, body);
      messagesEl.append(details);
      append = t => {
        body.textContent += t;
        const p = body.textContent;
        summary.textContent = "思考 · " + p.slice(0, 30) + (p.length > 30 ? "…" : "");
      };
    }
    currentKind = kind;
  }

  function appendChunk(kind, chunk) {
    if (currentKind !== kind) startBlock(kind);
    append(chunk);
    scrollToBottom();
  }

  // 工具：可折叠，展开看参数和结果
  function addToolBlock(toolCallId, toolName, args) {
    const details = document.createElement("details");
    details.className = "msg tool";
    const summary = document.createElement("summary");
    summary.textContent = `🔧 ${toolName}`;
    const body = document.createElement("div");
    body.className = "tool-body";
    const argsEl = document.createElement("div");
    argsEl.className = "tool-args";
    argsEl.textContent = "参数：" + JSON.stringify(args);
    const resultEl = document.createElement("div");
    resultEl.className = "tool-result";
    resultEl.textContent = "运行中…";
    body.append(argsEl, resultEl);
    details.append(summary, body);
    messagesEl.append(details);
    toolBlocks.set(toolCallId, { summary, resultEl });

    // 工具打断当前文本块，后面的内容另起一块
    currentKind = null;
    append = null;
  }

  try {
    const res = await fetch("http://127.0.0.1:43128/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let i;
      while ((i = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const line = frame.split("\n").find(l => l.startsWith("data:"));
        if (!line) continue;
        const msg = JSON.parse(line.slice(5).trim());

        if (msg.type === "thinking") {
          appendChunk("think", msg.text);
        } else if (msg.type === "text") {
          appendChunk("bot", msg.text);
        } else if (msg.type === "tool") {
          addToolBlock(msg.toolCallId, msg.toolName, msg.args);
        } else if (msg.type === "tool_end") {
          const block = toolBlocks.get(msg.toolCallId);
          if (block) {
            block.summary.textContent = `${msg.isError ? "⚠️" : "🔧"} ${msg.toolName}`;
            block.resultEl.textContent = msg.result || (msg.isError ? "调用失败" : "完成");
            scrollToBottom();
          }
        } else if (msg.type === "error") {
          addMessage("出错了：" + msg.message, "error");
        }
      }
    }
  } catch (err) {
    addMessage("连接后端失败：" + err.message, "error");
  } finally {
    sendBtn.disabled = false;
    inputEl.disabled = false;
    sendBtn.classList.remove("loading");
    inputEl.focus();
  }
};

// 回车发送
inputEl.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});
