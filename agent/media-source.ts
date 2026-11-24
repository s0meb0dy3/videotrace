/**
 * 视频来源适配器契约。
 * B站和 YouTube 的页面抓取逻辑留在扩展端；Agent 只接收规范化 context、字幕或二进制音频。
 * 这样新增 YouTube 不会把平台判断散落到任务编排器中，也避免服务端下载任意 URL。
 */
import type { VideoContext } from './contracts.js';

export interface MediaSourceAdapter {
  readonly platform: VideoContext['platform'];
  supports(context: VideoContext): boolean;
  resolveMetadata(context: VideoContext, signal?: AbortSignal): Promise<VideoContext>;
}

export class BilibiliMediaSource implements MediaSourceAdapter {
  readonly platform = 'bilibili' as const;
  supports(context: VideoContext): boolean { return context.platform === this.platform; }
  async resolveMetadata(context: VideoContext): Promise<VideoContext> { return context; }
}

/** YouTube 适配器预留：真正接入时由扩展页面取得字幕/音频后上传。 */
export class YoutubeMediaSource implements MediaSourceAdapter {
  readonly platform = 'youtube' as const;
  supports(context: VideoContext): boolean { return context.platform === this.platform; }
  async resolveMetadata(context: VideoContext): Promise<VideoContext> { return context; }
}
