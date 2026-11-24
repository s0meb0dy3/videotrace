// 兼容入口：由 build:agent 生成的 JavaScript 才是生产运行时。
export { initializeTracing, documentStats, resultStats } from '../dist/agent/tracing.js';
