import { PLATFORM_CONFIGS, PLATFORM_ORDER } from "./shared/payload.js";

const TASK_KEY = "publisher.currentTask";
const STATUS_KEY = "publisher.status";
const FILE_PREFIX = "publisher.file";

let isProcessing = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response ?? { ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "START_SYNC":
      await startSync(message.task);
      return { ok: true };
    case "GET_STATE":
      return getState();
    case "RETRY_PLATFORM":
      await retryPlatform(message.platformId);
      return { ok: true };
    case "GET_FILE_META":
      return getFileMeta(message.kind);
    case "GET_FILE_CHUNK":
      return getFileChunk(message.kind, message.index);
    case "CONTENT_STATUS":
      await updatePlatformStatus(message.platformId, message.patch);
      return { ok: true };
    default:
      return { ok: false, error: "未知消息类型" };
  }
}

async function startSync(task) {
  await chrome.storage.local.set({
    [TASK_KEY]: task,
    [STATUS_KEY]: createInitialStatus(task),
  });

  processQueue(task).catch((error) => {
    console.error("Sync queue failed", error);
  });
}

async function retryPlatform(platformId) {
  const { [TASK_KEY]: task } = await chrome.storage.local.get(TASK_KEY);
  if (!task) {
    throw new Error("没有可重试的同步任务，请先在工作台开始同步");
  }
  if (!task.platforms?.[platformId]) {
    throw new Error("这个平台没有包含在当前任务中");
  }

  processSinglePlatform(task, platformId, { reuseExistingTab: true }).catch((error) => {
    console.error("Retry failed", error);
  });
}

async function processQueue(task) {
  if (isProcessing) {
    throw new Error("已有同步任务正在执行");
  }

  isProcessing = true;
  try {
    for (const item of task.queue) {
      try {
        await processSinglePlatform(task, item.id);
      } catch (error) {
        console.error(`${item.id} sync failed`, error);
      }
    }
  } finally {
    isProcessing = false;
  }
}

async function processSinglePlatform(task, platformId, { reuseExistingTab = false } = {}) {
  const config = PLATFORM_CONFIGS[platformId];
  if (!config) {
    throw new Error(`未知平台：${platformId}`);
  }

  try {
    await updatePlatformStatus(platformId, {
      status: "opening",
      message: `正在打开 ${config.name}`,
      active: true,
      updatedAt: new Date().toISOString(),
    });

    const tab = reuseExistingTab ? await findExistingPlatformTab(config) : null;
    const activeTab = tab || (await chrome.tabs.create({ url: config.url, active: true }));
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { active: true });
    }
    await waitForTabComplete(activeTab.id);

    await updatePlatformStatus(platformId, {
      status: "uploading",
      message: tab ? "已复用打开的页面，正在注入同步脚本" : "页面已打开，正在注入同步脚本",
      active: true,
    });

    await injectAdapterScripts(activeTab.id, config.adapterFile);
    const frameId = await findBestFrameForPlatform(activeTab.id, platformId);

    await updatePlatformStatus(platformId, {
      status: "uploading",
      message: frameId === 0 ? "已定位主页面上传区域" : `已定位上传区域 frame ${frameId}`,
      active: true,
    });

    const result = await sendTabMessage(
      activeTab.id,
      {
        type: "RUN_PUBLISHER_ADAPTER",
        platformId,
        task,
      },
      frameId,
    );

    if (!result?.ok) {
      throw new Error(result?.error || `${config.name} 同步失败`);
    }

    await updatePlatformStatus(platformId, {
      status: result.warnings?.length ? "warning" : "ready",
      message: result.message || "已填充，等待人工确认发布",
      warnings: result.warnings || [],
      active: false,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    await updatePlatformStatus(platformId, {
      status: "failed",
      message: error.message || `${config.name} 同步失败`,
      active: false,
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }
}

async function findExistingPlatformTab(config) {
  const origin = new URL(config.url).origin;
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  return (
    tabs
      .filter((tab) => typeof tab.id === "number" && tab.url?.startsWith(origin))
      .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)))[0] || null
  );
}

async function injectAdapterScripts(tabId, adapterFile) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content/runner.js", adapterFile],
    });
  } catch (error) {
    console.warn("All-frame injection failed, falling back to main frame", error);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/runner.js", adapterFile],
    });
  }
}

async function findBestFrameForPlatform(tabId, platformId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (id) => window.ShortVideoPublisherUtils?.probePlatform?.(id) || { score: 0, reasons: [] },
      args: [platformId],
    });

    const best = results
      .filter((item) => item.result && item.result.score > 0)
      .sort((a, b) => b.result.score - a.result.score)[0];

    return best?.frameId ?? 0;
  } catch (error) {
    console.warn("Frame probing failed, using main frame", error);
    return 0;
  }
}

function sendTabMessage(tabId, message, frameId) {
  return new Promise((resolve, reject) => {
    const options = Number.isInteger(frameId) ? { frameId } : undefined;
    chrome.tabs.sendMessage(tabId, message, options, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("页面加载超时"));
    }, 60000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

async function getState() {
  const result = await chrome.storage.local.get([TASK_KEY, STATUS_KEY]);
  return {
    ok: true,
    task: result[TASK_KEY] || null,
    status: result[STATUS_KEY] || {},
  };
}

async function getFileMeta(kind) {
  const result = await chrome.storage.local.get(metaKey(kind));
  const descriptor = result[metaKey(kind)];
  if (!descriptor) {
    throw new Error(`缺少${kind === "video" ? "视频" : "封面"}文件`);
  }
  return { ok: true, descriptor };
}

async function getFileChunk(kind, index) {
  const key = chunkKey(kind, index);
  const result = await chrome.storage.local.get(key);
  const chunk = result[key];
  if (typeof chunk !== "string") {
    throw new Error(`文件分片缺失：${kind} #${index}`);
  }
  return { ok: true, chunk };
}

async function updatePlatformStatus(platformId, patch) {
  const result = await chrome.storage.local.get(STATUS_KEY);
  const status = result[STATUS_KEY] || {};
  status[platformId] = {
    ...(status[platformId] || {}),
    ...patch,
  };
  await chrome.storage.local.set({ [STATUS_KEY]: status });
}

function createInitialStatus(task) {
  return Object.fromEntries(
    PLATFORM_ORDER.map((id) => [
      id,
      {
        status: task.platforms?.[id] ? "pending" : "idle",
        message: task.platforms?.[id] ? "等待同步" : "未选择",
        active: false,
      },
    ]),
  );
}

function metaKey(kind) {
  return `${FILE_PREFIX}.${kind}.meta`;
}

function chunkKey(kind, index) {
  return `${FILE_PREFIX}.${kind}.chunk.${index}`;
}
