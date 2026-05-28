export const PLATFORM_ORDER = ["douyin", "xiaohongshu", "wechatChannels"];

export const PLATFORM_CONFIGS = {
  douyin: {
    id: "douyin",
    name: "抖音创作者中心",
    icon: "icons/douyin.svg",
    url: "https://creator.douyin.com/creator-micro/content/upload",
    adapterFile: "content/adapters/douyin.js",
  },
  xiaohongshu: {
    id: "xiaohongshu",
    name: "小红书创作服务平台",
    icon: "icons/xiaohongshu.svg",
    url: "https://creator.xiaohongshu.com/publish/publish?from=menu&target=video",
    adapterFile: "content/adapters/xiaohongshu.js",
  },
  wechatChannels: {
    id: "wechatChannels",
    name: "视频号助手",
    icon: "icons/wechat-channels.svg",
    url: "https://channels.weixin.qq.com/platform/post/create",
    adapterFile: "content/adapters/wechat-channels.js",
  },
};

const TAG_SPLIT_PATTERN = /[\s,，、;；]+/u;

export function normalizeTags(input) {
  if (Array.isArray(input)) {
    return uniqueTags(input.map(cleanTag).filter(Boolean));
  }

  if (!input || typeof input !== "string") {
    return [];
  }

  return uniqueTags(input.split(TAG_SPLIT_PATTERN).map(cleanTag).filter(Boolean));
}

export function buildPlatformQueue(platforms = {}) {
  const queue = PLATFORM_ORDER.filter((id) => Boolean(platforms[id])).map((id) => ({
    id,
    name: PLATFORM_CONFIGS[id].name,
    url: PLATFORM_CONFIGS[id].url,
    status: "pending",
    attempts: 0,
  }));

  if (queue.length === 0) {
    throw new Error("至少选择一个平台");
  }

  return queue;
}

export function appendTagsToDescription(description = "", tags = []) {
  const normalizedTags = normalizeTags(tags);
  if (normalizedTags.length === 0) {
    return description;
  }

  const body = String(description || "").trimEnd();
  const tagLine = normalizedTags.map((tag) => `#${tag}`).join(" ");
  return body ? `${body}\n${tagLine}` : tagLine;
}

export function createPublishTask(formData) {
  const title = String(formData?.title || "").trim();
  const description = String(formData?.description || "").trim();
  const tags = normalizeTags(formData?.tags);
  const queue = buildPlatformQueue(formData?.platforms);

  if (!formData?.video?.id) {
    throw new Error("请选择视频文件");
  }

  return {
    id: `task-${Date.now()}`,
    createdAt: new Date().toISOString(),
    title,
    description,
    tags,
    platforms: { ...formData.platforms },
    queue,
    video: cloneFileDescriptor(formData.video),
    cover: formData.cover?.id ? cloneFileDescriptor(formData.cover) : null,
  };
}

function cleanTag(tag) {
  return String(tag || "")
    .trim()
    .replace(/^#+/u, "")
    .replace(/[，,。.!！?？:：;；]+$/u, "")
    .trim();
}

function uniqueTags(tags) {
  const seen = new Set();
  const result = [];

  for (const tag of tags) {
    if (seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    result.push(tag);
  }

  return result;
}

function cloneFileDescriptor(file) {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    chunks: file.chunks,
  };
}
