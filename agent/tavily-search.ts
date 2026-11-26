const SEARCH_URL = 'https://api.tavily.com/search';
const MAX_RESULTS = 5;

interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

/** 密钥留在后端闭包中；模型只传搜索词。 */
export function createTavilySearch(apiKey: string, fetchImpl = fetch) {
  return async (query: string, signal?: AbortSignal): Promise<SearchResult[]> => {
    const timeout = AbortSignal.timeout(15_000);
    try {
      const response = await fetchImpl(SEARCH_URL, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, search_depth: 'basic', max_results: MAX_RESULTS, include_answer: false }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
      if (!response.ok) throw new Error();
      const { results } = await response.json() as { results: SearchResult[] };
      // 只传搜索片段，不转发服务商的其他字段或整页正文。
      return results.slice(0, MAX_RESULTS).map(({ title, url, content, score }) => ({
        title: title.slice(0, 300), url, content: content.slice(0, 1_500), score
      }));
    } catch {
      signal?.throwIfAborted();
      throw new Error(timeout.aborted ? '联网搜索超时' : '联网搜索失败，请检查 Tavily 配置或稍后重试');
    }
  };
}
