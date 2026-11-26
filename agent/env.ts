import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 进程环境变量优先于项目根目录的 .env。 */
export async function readEnv(root: string, env = process.env) {
  const values: Record<string, string> = {};
  try {
    const text = await readFile(join(root, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      const value = match[2];
      values[match[1]] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value.replace(/\s+#.*$/, '');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return (name: string) => env[name] || values[name];
}
