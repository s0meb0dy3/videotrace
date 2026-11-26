# 本地 ASR + Pi Agent 服务

## 启动和配置

运行环境：Node.js ≥22.19.0。后端源码使用 TypeScript，先执行 `npm ci` 安装依赖，再执行 `npm run build:agent` 编译。项目已锁定 `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai` 1.5.2。

在项目根目录运行 `npm run agent:dev`。该命令会先执行 `npm run build:agent`，再启动编译后的 `dist/agent/server.js`。服务只监听 `127.0.0.1:43127`，端口占用会安全失败，不切换地址或端口。

主模型统一使用 PIAI 的 OpenAI 兼容 Chat Completions。通过本地 `.env` 或环境变量设置 `AI_MODEL`、`AI_BASE_URL` 和 `AI_API_KEY`（地址填 API 根路径，不包含 `/chat/completions`）。在同一服务换模型只需改 `AI_MODEL`；换服务还需换地址和密钥。默认模型和地址为 `deepseek-flash` 与 `https://api.deepseek.com`。完整功能要求模型支持流式工具调用；头像功能还要求图片输入。可选 `AI_MAX_TOKENS` 和 `AI_CONTEXT_WINDOW` 用于声明输出和上下文规格。

音频转写使用本机环境变量 `BAILIAN_API_KEY`（优先）或 `BAILIAN_KEY`，也支持根目录 `.env` 的同名配置。密钥仅由后台读取，不从请求接收，不进入任务和日志。固定北京地域百炼 API，模型固定为 `qwen-audio-3.1-asr-flash-filetrans`。网页负责在 B站页面环境下载音频（保留页面的 CDN 访问条件），然后上传给本服务；服务不直接拉取客户端提供的音频 URL，也不接收 JSON/base64 音频。

启动随机生成的本地 Bearer token 保存到 `.private/agent/connection.json`，权限 `0600`，内容 `{url,token,pid}`。每次启动更换 token。侧栏通过 `POST /connection` 自动连接，该接口要求扩展 Origin；本机脚本可直接读取连接文件。该目录包含原始字幕和模型会话，请勿分享或提交。

`AI_REASONING=false` 让 PI 不请求推理档位，不保证关闭服务端默认思考。项目不再自动发送厂商专用的思考和联网参数；原 `AI_PROVIDER`、`AI_WEB_SEARCH` 不再读取。主模型密钥请填写 `AI_API_KEY`；`BAILIAN_API_KEY` 仅用于转写。

## HTTP 接口

所有业务请求必须带 `Authorization: Bearer <本机token>`。Host 必须精确匹配 loopback 主机及实际端口（127.0.0.1、localhost 或 [::1]），拒绝 DNS rebinding 域名。带 Origin 的请求仅接受标准 Chrome 扩展 origin（`chrome-extension://` 加32位 a-p 扩展ID）；普通网页 origin、null origin 均拒绝。扩展 CORS 预检不带 token，但仅放行预检，本身不能查询或修改任务。

- `POST /tasks`：推荐 JSON `{context:{title?,desc?,bvid?,cid?,part?,...},prompt?,mode:'analyze'}`，返回 HTTP 202 `{id,status:'receiving_audio'}`，此时不运行 ASR 或 Agent。也兼容离线实验 `{document,prompt?,mode}`，返回 `{id,status:'queued'}` 并直接分析；document 必须有非空 cues，每句有唯一字符串 id、text，speakerId 缺失归入 unknown。JSON 大小上限16MiB，不允许 `audio` 字段。
- `POST /tasks/:id/audio`：同样需要 Bearer，`Content-Type: audio/mp4`，body 是原始 m4a 二进制而不是 JSON 或 multipart。仅 receiving_audio 任务可接收，禁止重复/并发上传。大小上限512MiB，流式写完整临时文件后返回 HTTP 202 `{id,received:true,size}`，再启动 ASR。空 body 返回400，类型错误415，超限413，状态不允许409；失败上传可重试，取消后不能上传。服务先保存到 `.private/agent/uploads/<id>.m4a`（0600、目录0700），再执行百炼 policy→OSS→异步提交→轮询→结果下载，原始音频不传给 Pi。
- `GET /session?key=...`：查询当前视频分 P 的回合列表，按创建时间排列。只返回回合元数据和回复，不重复传输转写或头像图像。
- `POST /tasks` 也接受 `{previousTaskId,prompt,inspectFaces?}` 来继续对话。上一回合必须是该视频最新的终态回合且有转写；同一视频一次只允许一个回合运行。追问复用已有转写，不再上传音频。
- `GET /tasks/:id`：获取回合快照，包括状态、转写、人物和摘要的当前状态（`speakerState`）、已选头像素材、回复（`answer`）及最终结果（`result`）。失败、取消或超时不会清除已保存的转写和增量更新。
- `GET /tasks/:id/events`：用 **fetch + Authorization header** 读取 SSE，不能使用不支持 header 的普通 EventSource。帧包含 `id`、`event` 和 JSON `data`；data 是 `{id,type,data,createdAt}`。事件包括 `status`、`pi`（模型输出和工具）、`transcript_ready`、`speaker_updated`、`summary_updated` 和 `capture_faces`。`Last-Event-ID` header 或 `?after=N` 重放 N 后的事件，事件序号单任务单调递增。终态输出后关闭流，运行中有心跳。
- `POST /tasks/:id/cancel`：返回 `{id,status}`。重复取消终态任务无副作用；取消不会把已完成任务改写为失败。
- `POST /translate`：按需接收 `{cues:[{id,text}]}`，返回 `{translations:{[id]:译文}}`。仅主模型地址为 DeepSeek 官方地址时可用，服务分批调用固定的 DeepSeek 翻译模型，不进入 Agent 工具循环，也不写入任务日志；客户端断开时取消请求。

结果示例：`{"speakers":{"0":"主持人","1":"未知发言人"},"summary":"两位发言人讨论了……"}`。本地服务校验说话人编号无遗漏、无新增，标签与摘要非空。标签是推断，不是身份认证。结果不重传正文或时间戳。

## Pi 执行与存储

首次分析和追问使用同一份系统提示词与工具。首次消息要求分析视频；追问使用用户的问题。PI 原生运行模型与工具循环，自然语言回复结束当前回合。模型可以调用 `update_speaker`、`update_summary` 保存资料，或在已启用头像时调用 `inspect_faces`。如果只回复、不调用 `update_summary`，聊天依然完成，「总结」页不会因此更新。模型可读取带时间戳的全文、当前摘要和人物标签，以及最近 12 个历史回合；历史工具原文、思考和截图不重新发给模型。

开启头像后，创建任务时传 `inspectFaces: true`，允许 Agent 自选时间范围调用 `inspect_faces`。扩展收到 `capture_faces` SSE 事件后在当前视频采帧，并通过 `POST /tasks/:id/faces` 回传 `{requestId,frames}`。单次最多 20 秒，每秒在浏览器本地检测一次，只从检测到脸的帧里均匀取最多 3 张完整截图，仅附在下一次模型请求里。未选截图不保存，也不进入 Langfuse。已选头像的截图和裁剪框保存在本地回合快照中，侧栏可以在重开时重新裁剪。

硬限制：ASR 最长30分钟，随后 Pi 分析独立计时200秒。默认单进程最多并发运行2个任务、最多保留500个任务，音频默认上限512MiB；音频上传采用5分钟无数据空闲超时，不限制整个上传过程的总时长；普通 HTTP 请求默认总超时5分钟，SSE 不设总超时；单句字幕限制32,000字符、单个文稿最多10,000句，context 默认限制256KiB；等待首次音频上传超过10分钟会自动超时。不额外限制模型轮数、工具次数或采帧总次数；视频会话内单次采帧最多等待 12 秒。取消和超时立即冻结任务状态，不接受晚到结果或后续事件。失败无 result，HTTP/SSE/磁盘错误信息不保存完整 provider error。服务退出后未完成任务在下次启动标记失败，不自动重放收费请求。终态任务默认保留7天，启动时自动清理过期任务；事件内存只保留最近500条，SSE历史回放从磁盘读取。

任务持久化在 `.private/agent/tasks/`，包括任务 JSON、messages JSON 和带 id 的 events JSONL；任务文件为0600、目录0700。保存原始字幕用于本地回看，不重写字幕内容。凭证和 SDK errorMessage 等敏感字段不写入任务或模型事件日志。Langfuse 追踪保留每轮模型调用、最终 speaker 映射和摘要；完整逐字稿和音频不发送到 Langfuse。上传临时 m4a 在流水线结束时删除；进程异常退出可能遗留的上传文件仅供本机手动清理，不会自动续接收费请求。

## 本地会话轨迹

新发起的分析和追问会自动追加到 `.private/agent/traces/<视频会话键的 SHA-256>.jsonl`。同一视频分 P 共用一个文件；没有视频会话键的任务用任务 ID 命名。每行是一条完整的 JSON 记录，`turn` 表示第几次用户请求，不是 PI 内部的模型轮次。服务重启后继续编号。

轨迹包含用户输入、任务状态、PI 开始和结束、完整助手消息、模型用量，以及配对后的工具参数、结果和耗时。不记录流式碎片，不复制整份输入转写或截图。没有收到工具结果时标记 `no_result`。无需前端或 Langfuse；在编辑器里直接打开即可。历史任务不补写；轨迹独立于任务快照的 7 天清理，保留到手动删除。文件包含对话正文，请勿公开或提交。

## 后端架构与扩展边界

后端当前按以下职责拆分：

- `agent/server.ts`：HTTP/SSE 协议适配和 provider 编排，编译后由 `dist/agent/server.js` 运行。
- `agent/core/task-machine.ts`：唯一的合法状态转移表，终态任务不可回退。
- `agent/core/task-manager.ts`：任务状态、取消、超时和重启恢复。
- `agent/core/task-store.ts`：任务 JSON、模型消息的原子写入与损坏文件隔离。
- `agent/core/event-log.ts`：事件序号、磁盘回放、SSE 订阅和内存窗口。
- `agent/core/job-queue.ts`：有界并发队列；未来可替换为 SQLite 持久队列。
- `agent/contracts.ts`：统一 `VideoContext`、`VideoSourceAdapter`、字幕检索和问答会话契约。
- `agent/media-source.ts`：B站/YouTube 来源适配器骨架；当前只开放 B站扩展端。
- `agent/core/session-store.ts`：独立问答会话存储骨架；问答不会复用一次性分析的 `result`。

YouTube 接入时，扩展负责在页面环境获取字幕或音频，后端只接收统一文档或二进制上传，不在核心服务中实现任意 URL 下载。当前侧栏按视频键恢复同一视频的回合；每个回合独立取消和超时。

## 测试和集成

运行 `npm test`（会先编译 Agent，再执行全部测试）。ASR 单元测试用 fake fetch 验证 policy/OSS/固定模型提交/轮询/原始与规范化结果，不访问真实百炼；HTTP 注入 asrRunner 验证上传落盘、阶段切换、取消、限流大小及密钥脱敏。使用已安装 Pi faux provider 驱动真实 Agent loop，测试采帧、更新资料、自然结束和取消；模拟模型请求验证通用 OpenAI 兼容参数；HTTP 注入 runner 覆盖鉴权、CORS、Host、SSE重放、存储、取消/超时竞态、错误清理、重启恢复。测试不发送真实 API 请求，不收费。

`dist/agent/server.js` 导出异步 `createServer(options)`（返回未 listen 的 Node HTTP Server）和 `startCLI()`。测试可传 root、port、runner、asrRunner、modelConfig、apiKey、bailianApiKey、timeoutMs、asrTimeoutMs、maxAudioBytes；生产 CLI 固定默认限制。asrRunner 接收 `{audioPath,context,apiKey,signal}`，返回 `{context,raw,cues,paragraphs}`。`server.connection` 供本地嵌入/测试读取连接信息，不能作为远程无认证接口。
