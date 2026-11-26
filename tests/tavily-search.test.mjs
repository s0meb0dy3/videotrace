import test from 'node:test';
import assert from 'node:assert/strict';
import { createTavilySearch } from '../dist/agent/tavily-search.js';

test('Tavily 只接收搜索词，最多返回五条有来源的片段', async () => {
  const search = createTavilySearch('test-key', async (url, options) => {
    assert.equal(url, 'https://api.tavily.com/search');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.deepEqual(JSON.parse(options.body), {
      query: '360 创始人', search_depth: 'basic', max_results: 5, include_answer: false
    });
    return Response.json({ results: Array.from({ length: 6 }, () => ({
      title: '公司简介', url: 'https://example.test', content: '节'.repeat(2000), score: 0.85, raw_content: '省略全文'
    })) });
  });
  const results = await search('360 创始人');
  assert.equal(results.length, 5);
  assert.deepEqual(results[0], { title: '公司简介', url: 'https://example.test', content: '节'.repeat(1500), score: 0.85 });
});

test('Tavily 错误不透出服务商正文，支持取消请求', async () => {
  const search = createTavilySearch('test-key', async () => new Response('private error', { status: 401 }));
  await assert.rejects(search('测试'), { message: '联网搜索失败，请检查 Tavily 配置或稍后重试' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(search('测试', controller.signal), { name: 'AbortError' });
});
