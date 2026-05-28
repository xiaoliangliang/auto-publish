import { PLATFORM_CONFIGS, PLATFORM_ORDER } from "./shared/payload.js";

const statusList = document.querySelector("#statusList");
const openOptionsButton = document.querySelector("#openOptionsButton");

openOptionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
refreshState();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && (changes["publisher.status"] || changes["publisher.currentTask"])) {
    refreshState();
  }
});

async function refreshState() {
  const state = await sendMessage({ type: "GET_STATE" });
  renderStatuses(state.task, state.status || {});
}

function renderStatuses(task, status) {
  statusList.replaceChildren(
    ...PLATFORM_ORDER.map((id) => {
      const config = PLATFORM_CONFIGS[id];
      const item = status[id] || { status: task?.platforms?.[id] ? "pending" : "idle", message: "等待任务" };
      const row = document.createElement("div");
      row.className = `status-row ${item.active ? "active" : ""}`;
      row.innerHTML = `
        <button class="refresh" type="button" title="重新同步 ${config.name}" data-retry="${id}">↻</button>
        <img src="${config.icon}" alt="" />
        <div class="main">
          <strong>${config.name}</strong>
          <span>${item.message || statusLabel(item.status)}</span>
        </div>
        <span class="badge ${item.status || "idle"}">${statusLabel(item.status)}</span>
      `;
      row.querySelector("[data-retry]").addEventListener("click", () => retryPlatform(id));
      return row;
    }),
  );
}

async function retryPlatform(platformId) {
  await sendMessage({ type: "RETRY_PLATFORM", platformId });
  await refreshState();
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
