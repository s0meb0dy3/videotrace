# VideoTrace

面向 B 站视频的多模态理解与问答 Agent：生成带时间戳的逐字稿、说话人头像和视频摘要，并支持基于转写与画面的多轮对话。

## 快速开始

需要 Chrome / Edge 116+、Node.js ≥22.19.0 和 Python 3。

```bash
npm ci
cp .env.example .env
# 在 .env 中填写 BAILIAN_API_KEY（转写）和 AI_API_KEY（主模型）
npm run agent:dev
```

随后在浏览器扩展管理页加载 `extension/`，打开 B 站视频并点击「开始分析」。在「Agent」页可以展开每轮执行过程，分析结束后继续提问；返回同一视频分 P 时会恢复本地会话。

## 目录结构

下面列出主要源码和运行数据。想读 Agent 的执行逻辑，从 `agent/runner.ts` 开始；想改工具描述、参数或行为，直接看 `agent/tools.ts`。

```text
.
├── agent/                         # 本地 Node.js + TypeScript 后端
│   ├── server.ts                  # HTTP/SSE 入口：接收音频、启动任务、恢复视频会话
│   ├── runner.ts                  # 组装提示词和消息，调用 PI；模型与工具的循环由 PI 执行
│   ├── tools.ts                   # 采帧、更新说话人、更新摘要的定义与实现
│   ├── asr-service.ts             # 上传音频到百炼、等待转写并整理结果
│   ├── face-broker.ts             # 向扩展请求采帧、等待回传并生成头像候选
│   ├── session-trace.ts           # 将用户输入、模型响应和工具调用追加到本地会话轨迹
│   ├── tracing.ts                 # 可选的 Langfuse 链路观测
│   ├── translate.ts               # 独立的字幕翻译，不走 Agent 工具循环
│   ├── core/                      # 任务调度、状态、存储和事件回放
│   │   ├── task-manager.ts        # 管理任务状态、终态与重启恢复
│   │   ├── task-machine.ts        # 定义允许的任务状态转换
│   │   ├── task-store.ts          # 读写本地任务、消息和事件文件
│   │   ├── event-log.ts           # 事件编号及历史回放
│   │   ├── sse-hub.ts             # SSE 连接、心跳和事件广播
│   │   ├── job-queue.ts           # 限制并发运行的任务数
│   │   └── schema.ts              # 校验转写文稿和分析结果
│   └── README.md                  # 后端配置、接口与存储说明
├── extension/                     # Chrome / Edge 扩展
│   ├── manifest.json              # 扩展权限、入口和资源声明
│   ├── background.js              # 注册侧栏和设置菜单
│   ├── sidepanel.html             # 侧栏页面入口
│   ├── app.js                     # 协调当前视频、侧栏状态与本地缓存
│   ├── panel.js                   # 展示转写、总结、播放进度与导出内容
│   ├── agent-chat.js              # 展示 Agent 对话和可折叠的执行过程
│   ├── agent-view.js              # 发起和恢复分析、订阅回合事件、处理采帧请求
│   ├── agent-client.js            # 调用本地 Agent 的 HTTP 接口并读取 SSE
│   ├── content.js                 # 在视频页转发扩展消息
│   ├── bridge.js                  # 在页面环境读取 B 站视频信息、获取音频并截图
│   ├── audio-loader.js            # 从页面分片读取音频并拼成上传用的 Blob
│   ├── face-capture.js            # 本地人脸检测、代表图筛选与头像裁剪
│   ├── transcript.js              # 转写规范化与分段，后端也复用
│   ├── storage.js                 # 读写 Chrome 扩展本地存储
│   └── vendor/mediapipe/          # 本地人脸检测依赖与模型资源
├── tests/                         # 后端、扩展与集成测试
├── scripts/                       # 资源检查、浏览器验证和扩展打包
├── docs/                          # 开发说明、测试记录和界面截图
├── .env.example                   # 主模型、百炼转写与可选追踪的配置模板
└── package.json                   # Node.js 依赖与开发命令
```

### 本地生成的文件

```text
.
├── .private/agent/                # 本地运行数据，不提交到 Git
│   ├── connection.json            # 服务地址、进程 ID 和本地访问令牌，不要分享
│   ├── tasks/                     # 每次请求的任务快照、消息快照和原始事件流
│   │   ├── <任务ID>.json           # 转写、分析结果、回复和选中的头像素材
│   │   ├── <任务ID>.messages.json  # 回合退出时的模型消息快照
│   │   └── <任务ID>.events.jsonl   # 供侧栏回放的逐条事件（含流式片段）
│   ├── traces/                    # 给人看的会话轨迹：同一视频会话追加到同一份 JSONL
│   └── uploads/                   # 待转写的临时音频，任务结束后通常会删除
└── dist/                          # 编译后的 Agent（dist/agent/）和扩展打包产物
```

`.private/` 中如果还有旧实验脚本或缓存，不属于上述运行目录。浏览器扩展的转写和界面缓存保存在 `chrome.storage.local`，不在项目目录里。

## 开发

```bash
npm test
npm run typecheck
npm run build:agent
npm run check
npm run package
```

Agent 后端使用 TypeScript + Node.js。源码位于 [`agent/`](agent/)，运行前由 `build:agent` 编译到 `dist/agent/`，Node.js 直接执行编译后的 `dist/agent/server.js`。HTTP 请求体、SSE 连接管理和任务持久化分别由 `agent/http-body.ts`、`agent/core/sse-hub.ts`、`agent/core/task-store.ts` 负责。

后端以视频分 P 为单位恢复会话，每次分析和追问都有独立的回合记录与流式事件。当前扩展只支持 B 站；YouTube 尚未接入。

本地服务监听 `127.0.0.1:43127`。Langfuse 为可选的链路观测服务；配置 `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY` 后重启 Agent 即可启用。

完整的本地服务接口和数据边界见 [`agent/README.md`](agent/README.md)。
