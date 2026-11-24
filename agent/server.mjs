// 兼容入口：生产运行先编译 TypeScript，再加载 dist/agent/server.js。
// 这样 Node 不会直接执行未经编译的 .ts，也让旧测试继续使用原有导出路径。
export async function createServer(options) {
  const module = await import('../dist/agent/server.js');
  return module.createServer(options);
}

export async function startCLI() {
  const module = await import('../dist/agent/server.js');
  return module.startCLI();
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  startCLI().catch(error => {
    if (error?.code === 'EADDRINUSE') {
      console.error('Pi Agent 启动失败：127.0.0.1:43127 端口已被占用。已有 Agent 可能正在运行，请先停止旧进程后再重试。');
    } else {
      console.error('Pi Agent 启动失败，请检查本地配置和端口');
    }
    process.exitCode = 1;
  });
}
