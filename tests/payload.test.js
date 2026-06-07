import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendTagsToDescription,
  buildPlatformQueue,
  createPublishTask,
  normalizeTags,
  PLATFORM_CONFIGS,
} from "../extension/shared/payload.js";
import { joinBase64Chunks, splitBase64IntoChunks } from "../extension/shared/file-chunks.js";
import {
  chooseBestTextMatch,
  chooseXiaohongshuOriginalStatementMatch,
  chooseUploadZoneTextMatch,
  chooseWechatCoverDialogMatch,
  chooseWechatPersonalCoverMatch,
  createStableSourceSignature,
} from "../extension/shared/text-match.js";

describe("normalizeTags", () => {
  it("splits space-separated Chinese tags and strips hash prefixes", () => {
    assert.deepEqual(normalizeTags("标签1 #标签2  标签3"), ["标签1", "标签2", "标签3"]);
  });

  it("also accepts common comma separators and removes duplicates", () => {
    assert.deepEqual(normalizeTags("标签1,标签2，标签1、标签3"), ["标签1", "标签2", "标签3"]);
  });
});

describe("buildPlatformQueue", () => {
  it("keeps the fixed platform order no matter how the selection object is ordered", () => {
    assert.deepEqual(
      buildPlatformQueue({
        youtube: true,
        bilibili: true,
        wechatChannels: true,
        douyin: true,
        xiaohongshu: true,
      }).map((item) => item.id),
      ["douyin", "xiaohongshu", "wechatChannels", "bilibili", "youtube"],
    );
  });

  it("throws when no platform is selected", () => {
    assert.throws(() => buildPlatformQueue({}), /至少选择一个平台/);
  });
});

describe("PLATFORM_CONFIGS", () => {
  it("includes Bilibili upload as a sync target with its own adapter", () => {
    assert.equal(PLATFORM_CONFIGS.bilibili.name, "B站创作中心");
    assert.equal(
      PLATFORM_CONFIGS.bilibili.url,
      "https://member.bilibili.com/platform/upload/video/frame",
    );
    assert.equal(PLATFORM_CONFIGS.bilibili.adapterFile, "content/adapters/bilibili.js");
  });

  it("includes YouTube Studio upload as a sync target with its own adapter", () => {
    assert.equal(PLATFORM_CONFIGS.youtube.name, "YouTube Studio");
    assert.equal(
      PLATFORM_CONFIGS.youtube.url,
      "https://studio.youtube.com/channel/UCR-vsPTItFNaehqa0zv4iaA/videos/upload?d=ud&filter=%5B%5D&sort=%7B%22columnType%22%3A%22date%22%2C%22sortOrder%22%3A%22DESCENDING%22%7D",
    );
    assert.equal(PLATFORM_CONFIGS.youtube.adapterFile, "content/adapters/youtube.js");
  });
});

describe("createPublishTask", () => {
  it("normalizes form data into a reusable task payload", () => {
    const task = createPublishTask({
      title: "  新鞋开箱  ",
      description: "第一眼质感不错",
      tags: "球鞋 开箱",
      platforms: { douyin: true, xiaohongshu: false, wechatChannels: true },
      video: { id: "video", name: "demo.mp4", size: 123, type: "video/mp4", chunks: 3 },
      cover: { id: "cover", name: "cover.jpg", size: 456, type: "image/jpeg", chunks: 1 },
    });

    assert.equal(task.title, "新鞋开箱");
    assert.equal(task.description, "第一眼质感不错");
    assert.equal(task.youtubeTitle, "新鞋开箱\n第一眼质感不错\n#球鞋 #开箱");
    assert.deepEqual(task.tags, ["球鞋", "开箱"]);
    assert.deepEqual(task.queue.map((item) => item.id), ["douyin", "wechatChannels"]);
    assert.equal(task.video.name, "demo.mp4");
    assert.equal(task.cover.name, "cover.jpg");
  });

  it("requires a selected video file", () => {
    assert.throws(
      () =>
        createPublishTask({
          title: "标题",
          platforms: { douyin: true },
        }),
      /请选择视频文件/,
    );
  });
});

describe("appendTagsToDescription", () => {
  it("appends normalized hash tags without duplicating blank lines", () => {
    assert.equal(
      appendTagsToDescription("正文内容\n", ["球鞋", "开箱"]),
      "正文内容\n#球鞋 #开箱",
    );
  });

  it("returns the original description when there are no tags", () => {
    assert.equal(appendTagsToDescription("正文内容", []), "正文内容");
  });
});

describe("base64 file chunks", () => {
  it("splits and rejoins base64 strings without losing data", () => {
    const chunks = splitBase64IntoChunks("abcdefghijklmnopqrstuvwxyz", 5);

    assert.deepEqual(chunks, ["abcde", "fghij", "klmno", "pqrst", "uvwxy", "z"]);
    assert.equal(joinBase64Chunks(chunks), "abcdefghijklmnopqrstuvwxyz");
  });

  it("rejects invalid chunk sizes", () => {
    assert.throws(() => splitBase64IntoChunks("abc", 0), /chunkSize/);
  });
});

describe("chooseBestTextMatch", () => {
  it("prefers exact short action text over longer container text", () => {
    const match = chooseBestTextMatch(
      [
        { id: "container", text: "设置封面 取消 保存" },
        { id: "draft", text: "暂存离开" },
        { id: "save", text: "保存" },
      ],
      ["保存"],
    );

    assert.equal(match.id, "save");
  });

  it("ignores long page blocks that only contain the action word", () => {
    const match = chooseBestTextMatch(
      [
        { id: "page", text: "基础信息 作品描述 设置封面 添加合集 自主声明 保存 发布" },
        { id: "button", text: "保存" },
      ],
      ["保存"],
      { maxLength: 12 },
    );

    assert.equal(match.id, "button");
  });

  it("can match visible rich-text placeholder copy", () => {
    const match = chooseBestTextMatch(
      [
        { id: "section", text: "大大 输入正文描述，真诚有价值的分享予人温暖 #话题 @用户 表情" },
        { id: "placeholder", text: "输入正文描述，真诚有价值的分享予人温暖" },
      ],
      ["输入正文描述", "正文描述"],
      { maxLength: 40 },
    );

    assert.equal(match.id, "placeholder");
  });

  it("can match placeholder metadata when visible placeholder text is rendered by CSS", () => {
    const match = chooseBestTextMatch(
      [
        { id: "prosemirror", text: "" },
        { id: "placeholder", text: "", placeholder: "输入正文描述，真诚有价值的分享予人温暖" },
      ],
      ["输入正文描述", "正文描述"],
      { maxLength: 40 },
    );

    assert.equal(match.id, "placeholder");
  });

  it("can prefer short form labels such as video description and short title", () => {
    const description = chooseBestTextMatch(
      [
        { id: "section", text: "视频描述 #话题 @视频号 位置 添加到合集" },
        { id: "label", text: "视频描述" },
      ],
      ["视频描述"],
      { maxLength: 12 },
    );
    const title = chooseBestTextMatch(
      [
        { id: "row", text: "短标题 概括视频主要内容，字数建议6-16个字符" },
        { id: "label", text: "短标题" },
      ],
      ["短标题"],
      { maxLength: 12 },
    );

    assert.equal(description.id, "label");
    assert.equal(title.id, "label");
  });
});

describe("chooseUploadZoneTextMatch", () => {
  it("matches WeChat Channels upload rule text instead of requiring upload button copy", () => {
    const match = chooseUploadZoneTextMatch([
      { id: "location", text: "惠州市" },
      {
        id: "upload-zone",
        text: "上传时长8小时内，大小不超过20GB，建议分辨率720P及以上，码率10Mbps以内，格式为MP4/H.264格式",
      },
    ]);

    assert.equal(match.id, "upload-zone");
  });
});

describe("chooseXiaohongshuOriginalStatementMatch", () => {
  it("chooses the original statement switch instead of nearby content setting rows", () => {
    const match = chooseXiaohongshuOriginalStatementMatch([
      { id: "content-settings", text: "内容设置 添加章节 加入合集 原创声明 添加内容类型声明 添加地点" },
      { id: "type-statement", text: "添加内容类型声明" },
      { id: "original-switch", text: "原创声明" },
    ]);

    assert.equal(match.id, "original-switch");
  });
});

describe("chooseWechatPersonalCoverMatch", () => {
  it("chooses the personal homepage cover card instead of the share card", () => {
    const match = chooseWechatPersonalCoverMatch([
      { id: "share", text: "分享卡片 4:3 编辑" },
      { id: "personal", text: "个人主页卡片 3:4 编辑" },
    ]);

    assert.equal(match.id, "personal");
  });
});

describe("chooseWechatCoverDialogMatch", () => {
  it("accepts both WeChat cover dialog variants", () => {
    const match = chooseWechatCoverDialogMatch([
      { id: "generic", text: "编辑封面 从视频中选择封面 上传封面 个人主页卡片预览 分享卡片预览" },
      { id: "other", text: "视频描述 短标题" },
    ]);

    assert.equal(match.id, "generic");
  });
});

describe("createStableSourceSignature", () => {
  it("distinguishes data image URLs that share the same prefix", () => {
    const prefix = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg";

    assert.notEqual(
      createStableSourceSignature(`${prefix}${"a".repeat(200)}AAA`),
      createStableSourceSignature(`${prefix}${"a".repeat(200)}BBB`),
    );
  });
});
