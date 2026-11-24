// 兼容入口：由 build:agent 生成的 JavaScript 才是生产运行时。
export { ASR_MODEL, loadBailianApiKey, transcribeAudioFile } from '../dist/agent/asr-service.js';
