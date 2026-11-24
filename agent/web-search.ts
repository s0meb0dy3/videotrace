export interface SearchResult {
  title?: string;
  url?: string;
  summary: string;
}
export type WebSearch = (query: string, signal?: AbortSignal) => Promise<SearchResult[]>;

/** 创建 DeepSeek 公开信息搜索函数；未配置密钥时返回 undefined。 */
export function createWebSearch(apiKey?: string, fetchImpl: typeof fetch = fetch): WebSearch | undefined {
  if (!apiKey) return undefined;
  return async (query: string, signal?: AbortSignal): Promise<SearchResult[]> => {
    const response = await fetchImpl('https://api.deepseek.com/v1/tools/search', {
      method: 'POST', signal, redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: query.trim(), count: 5, need_content: false })
    });
    if (!response.ok) throw new Error('联网搜索失败，可依据已有资料继续判断');
    const { results = [] } = await response.json() as { results?: Array<{ title?: string; url?: string; summary?: string; snippet?: string }> };
    return results.slice(0, 5).map(({ title, url, summary, snippet }) => ({ title, url, summary: summary || snippet || '' }));
  };
}
