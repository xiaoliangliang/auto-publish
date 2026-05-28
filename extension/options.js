import { splitBase64IntoChunks } from "./shared/file-chunks.js";
import { createPublishTask, PLATFORM_CONFIGS, PLATFORM_ORDER } from "./shared/payload.js";

const DRAFT_KEY = "publisher.draft";
const FILE_PREFIX = "publisher.file";

const elements = {
  form: document.querySelector("#publishForm"),
  title: document.querySelector("#titleInput"),
  description: document.querySelector("#descriptionInput"),
  tags: document.querySelector("#tagsInput"),
  video: document.querySelector("#videoInput"),
  cover: document.querySelector("#coverInput"),
  videoName: document.querySelector("#videoName"),
  coverName: document.querySelector("#coverName"),
  platformGrid: document.querySelector("#platformGrid"),
  selectAll: document.querySelector("#selectAllButton"),
  start: document.querySelector("#startButton"),
  formMessage: document.querySelector("#formMessage"),
  statusList: document.querySelector("#statusList"),
  refreshState: document.querySelector("#refreshStateButton"),
  restoreDraft: document.querySelector("#restoreDraftButton"),
};

renderPlatforms();
restoreDraft();
refreshState();

elements.form.addEventListener("submit", handleSubmit);
elements.selectAll.addEventListener("click", selectAllPlatforms);
elements.refreshState.addEventListener("click", refreshState);
elements.restoreDraft.addEventListener("click", restoreDraft);
elements.video.addEventListener("change", () => updateFileLabel("video"));
elements.cover.addEventListener("change", () => updateFileLabel("cover"));

for (const input of [elements.title, elements.description, elements.tags]) {
  input.addEventListener("input", saveDraft);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && (changes["publisher.status"] || changes["publisher.currentTask"])) {
    refreshState();
  }
});

function renderPlatforms() {
  elements.platformGrid.replaceChildren(
    ...PLATFORM_ORDER.map((id) => {
      const config = PLATFORM_CONFIGS[id];
      const label = document.createElement("label");
      label.className = "platform-card";
      label.innerHTML = `
        <input type="checkbox" name="platform" value="${id}" checked />
        <img src="${config.icon}" alt="" />
        <span>${config.name}</span>
      `;
      label.querySelector("input").addEventListener("change", saveDraft);
      return label;
    }),
  );
}

async function handleSubmit(event) {
  event.preventDefault();

  try {
    setBusy(true, "正在读取文件并准备同步...");
    await saveDraft();

    const videoFile = elements.video.files[0];
    const coverFile = elements.cover.files[0];
    const video = videoFile ? await persistFile("video", videoFile) : null;
    const cover = coverFile ? await persistFile("cover", coverFile) : null;

    const task = createPublishTask({
      title: elements.title.value,
      description: elements.description.value,
      tags: elements.tags.value,
      platforms: getSelectedPlatforms(),
      video,
      cover,
    });

    await sendMessage({ type: "START_SYNC", task });
    elements.formMessage.textContent = "已开始同步，请按打开的平台页面逐个检查。";
    await refreshState();
  } catch (error) {
    elements.formMessage.textContent = error.message || "启动同步失败";
  } finally {
    setBusy(false);
  }
}

function getSelectedPlatforms() {
  const selected = {};
  for (const checkbox of document.querySelectorAll('input[name="platform"]')) {
    selected[checkbox.value] = checkbox.checked;
  }
  return selected;
}

function selectAllPlatforms() {
  for (const checkbox of document.querySelectorAll('input[name="platform"]')) {
    checkbox.checked = true;
  }
  saveDraft();
}

function updateFileLabel(kind) {
  const input = kind === "video" ? elements.video : elements.cover;
  const label = kind === "video" ? elements.videoName : elements.coverName;
  label.textContent = input.files[0] ? `${input.files[0].name} · ${formatBytes(input.files[0].size)}` : label.dataset.default;
}

async function persistFile(kind, file) {
  await removePersistedFile(kind);

  elements.formMessage.textContent = `正在读取${kind === "video" ? "视频" : "封面"}：${file.name}`;
  const dataUrl = await readFileAsDataUrl(file);
  const base64 = dataUrl.split(",")[1] || "";
  const chunks = splitBase64IntoChunks(base64);
  const descriptor = {
    id: `${kind}-${Date.now()}`,
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified,
    chunks: chunks.length,
  };

  const keys = chunks.map((_, index) => chunkKey(kind, index));
  const payload = {
    [metaKey(kind)]: descriptor,
    [indexKey(kind)]: keys,
  };

  chunks.forEach((chunk, index) => {
    payload[keys[index]] = chunk;
  });

  await chrome.storage.local.set(payload);
  return descriptor;
}

async function removePersistedFile(kind) {
  const existing = await chrome.storage.local.get(indexKey(kind));
  const keys = existing[indexKey(kind)] || [];
  if (keys.length) {
    await chrome.storage.local.remove(keys);
  }
  await chrome.storage.local.remove([indexKey(kind), metaKey(kind)]);
}

function metaKey(kind) {
  return `${FILE_PREFIX}.${kind}.meta`;
}

function indexKey(kind) {
  return `${FILE_PREFIX}.${kind}.index`;
}

function chunkKey(kind, index) {
  return `${FILE_PREFIX}.${kind}.chunk.${index}`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error || new Error("读取文件失败")));
    reader.readAsDataURL(file);
  });
}

async function saveDraft() {
  await chrome.storage.local.set({
    [DRAFT_KEY]: {
      title: elements.title.value,
      description: elements.description.value,
      tags: elements.tags.value,
      platforms: getSelectedPlatforms(),
    },
  });
}

async function restoreDraft() {
  const result = await chrome.storage.local.get(DRAFT_KEY);
  const draft = result[DRAFT_KEY];
  if (!draft) {
    return;
  }

  elements.title.value = draft.title || "";
  elements.description.value = draft.description || "";
  elements.tags.value = draft.tags || "";

  for (const checkbox of document.querySelectorAll('input[name="platform"]')) {
    checkbox.checked = draft.platforms?.[checkbox.value] ?? true;
  }
}

async function refreshState() {
  const state = await sendMessage({ type: "GET_STATE" });
  renderStatuses(state.task, state.status || {});
}

function renderStatuses(task, status) {
  const rows = PLATFORM_ORDER.map((id) => {
    const config = PLATFORM_CONFIGS[id];
    const item = status[id] || { status: task?.platforms?.[id] ? "pending" : "idle", message: "等待任务" };
    const row = document.createElement("div");
    row.className = `status-row ${item.active ? "active" : ""}`;
    row.innerHTML = `
      <button class="refresh-button" type="button" title="重新同步 ${config.name}" data-retry="${id}">↻</button>
      <img src="${config.icon}" alt="" />
      <div class="status-main">
        <strong>${config.name}</strong>
        <span>${item.message || statusLabel(item.status)}</span>
      </div>
      <span class="status-badge ${item.status || "idle"}">${statusLabel(item.status)}</span>
    `;
    row.querySelector("[data-retry]").addEventListener("click", () => retryPlatform(id));
    return row;
  });

  elements.statusList.replaceChildren(...rows);
}

async function retryPlatform(platformId) {
  try {
    await sendMessage({ type: "RETRY_PLATFORM", platformId });
    await refreshState();
  } catch (error) {
    elements.formMessage.textContent = error.message || "重试失败";
  }
}

function setBusy(isBusy, message = "") {
  elements.start.disabled = isBusy;
  elements.start.textContent = isBusy ? "准备中..." : "开始同步";
  if (message) {
    elements.formMessage.textContent = message;
  }
}

function statusLabel(status = "idle") {
  return (
    {
      idle: "空闲",
      pending: "等待",
      opening: "打开中",
      uploading: "上传中",
      filling: "填充中",
      ready: "待确认",
      failed: "失败",
      warning: "需处理",
    }[status] || status
  );
}

function formatBytes(bytes) {
  if (!bytes) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (response?.ok === false) {
        reject(new Error(response.error || "操作失败"));
        return;
      }
      resolve(response);
    });
  });
}

elements.videoName.dataset.default = elements.videoName.textContent;
elements.coverName.dataset.default = elements.coverName.textContent;
