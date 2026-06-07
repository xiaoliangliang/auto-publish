(() => {
  window.ShortVideoPublisherAdapters ||= {};
  window.ShortVideoPublisherUtils = createUtils();

  if (window.__SHORT_VIDEO_PUBLISHER_RUNNER__) {
    return;
  }
  window.__SHORT_VIDEO_PUBLISHER_RUNNER__ = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "RUN_PUBLISHER_ADAPTER") {
      return false;
    }

    runAdapter(message.platformId, message.task)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });

  async function runAdapter(platformId, task) {
    const adapter = window.ShortVideoPublisherAdapters?.[platformId];
    if (!adapter) {
      throw new Error(`页面适配器未加载：${platformId}`);
    }

    const bridge = {
      getFile,
      updateStatus: (patch) =>
        sendRuntimeMessage({
          type: "CONTENT_STATUS",
          platformId,
          patch,
        }),
    };

    return adapter(task, bridge, window.ShortVideoPublisherUtils);
  }

  async function getFile(kind) {
    const metaResponse = await sendRuntimeMessage({ type: "GET_FILE_META", kind });
    const descriptor = metaResponse.descriptor;
    const parts = [];

    for (let index = 0; index < descriptor.chunks; index += 1) {
      const chunkResponse = await sendRuntimeMessage({ type: "GET_FILE_CHUNK", kind, index });
      parts.push(base64ToBytes(chunkResponse.chunk));
    }

    return new File(parts, descriptor.name, {
      type: descriptor.type,
      lastModified: descriptor.lastModified || Date.now(),
    });
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        if (response?.ok === false) {
          reject(new Error(response.error || "扩展通信失败"));
          return;
        }
        resolve(response || {});
      });
    });
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function createUtils() {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function waitFor(callback, { timeout = 300000, interval = 800, message = "等待页面元素超时" } = {}) {
      const started = Date.now();
      let lastValue = null;

      while (Date.now() - started < timeout) {
        lastValue = callback();
        if (lastValue) {
          return lastValue;
        }
        await sleep(interval);
      }

      throw new Error(message);
    }

    async function waitForField(placeholders, timeout = 300000) {
      return waitFor(() => findFieldByPlaceholder(placeholders), {
        timeout,
        message: `未找到输入框：${placeholders.join(" / ")}`,
      });
    }

    function findFieldByPlaceholder(placeholders) {
      const patterns = placeholders.map((item) => String(item).toLowerCase());
      const candidates = [
        ...deepQuerySelectorAll("input, textarea, [contenteditable], [role='textbox']"),
      ];

      return candidates.find((element) => {
        const values = [
          element.getAttribute("placeholder"),
          element.getAttribute("aria-label"),
          element.getAttribute("data-placeholder"),
          element.textContent,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return patterns.some((pattern) => values.includes(pattern));
      });
    }

    function setTextField(element, value) {
      if (!element) {
        throw new Error("输入框不存在");
      }

      element.scrollIntoView({ block: "center", behavior: "smooth" });
      element.focus();

      if (element.matches("input, textarea")) {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        descriptor?.set ? descriptor.set.call(element, value) : (element.value = value);
      } else {
        document.execCommand("selectAll", false, null);
        const inserted = document.execCommand("insertText", false, value);
        if (!inserted) {
          element.textContent = value;
        }
      }

      dispatchInputEvents(element);
    }

    function dispatchInputEvents(element) {
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: element.value || element.textContent || "" }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
    }

    async function setTextByPlaceholder(placeholders, value, timeout) {
      const field = await waitForField(placeholders, timeout);
      setTextField(field, value);
      return field;
    }

    async function setTextByPlaceholderOrVisibleText(placeholders, value, timeout = 30000) {
      const directField = await waitFor(() => findFieldByPlaceholder(placeholders) || findEditableNearVisibleText(placeholders), {
        timeout,
        interval: 600,
        message: `未找到输入框：${placeholders.join(" / ")}`,
      });

      setTextField(directField, value);
      return directField;
    }

    async function setTextNearLabel(labelTexts, value, { timeout = 30000, fieldSelector = "" } = {}) {
      const field = await waitFor(() => findEditableNearLabel(labelTexts, fieldSelector), {
        timeout,
        interval: 600,
        message: `未找到字段：${labelTexts.join(" / ")}`,
      });

      setTextField(field, value);
      return field;
    }

    function findFileInput(kind, root = document) {
      const expected = kind === "image" ? "image" : "video";
      const inputs = [...deepQuerySelectorAll("input[type='file']", root)];
      const scored = inputs
        .map((input) => {
          const accept = String(input.accept || "").toLowerCase();
          let score = 0;
          if (accept.includes(expected)) score += 5;
          if (!accept) score += 1;
          if (expected === "video" && accept.includes(".mp4")) score += 2;
          if (expected === "image" && /png|jpg|jpeg|webp/.test(accept)) score += 2;
          return { input, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);

      return scored[0]?.input || null;
    }

    async function uploadFile(
      file,
      {
        kind = "video",
        clickTexts = [],
        hintTexts = [],
        timeout = 30000,
        dialogOnly = false,
        inputSelector = "",
        rootSelector = "",
      } = {},
    ) {
      const resolveRoot = () => {
        if (rootSelector) {
          return deepQuerySelectorAll(rootSelector).find(isVisible) || deepQuerySelectorAll(rootSelector)[0] || null;
        }
        return dialogOnly ? findLikelyDialogRoot() : document;
      };
      const resolveInput = () => {
        const currentRoot = resolveRoot();
        if (inputSelector) {
          return findFileInputBySelector(inputSelector, currentRoot) || findFileInputBySelector(inputSelector, document);
        }
        return currentRoot ? findFileInput(kind, currentRoot) : null;
      };

      let root = resolveRoot();
      let input = resolveInput();
      if (!input) {
        clickFirstByText(clickTexts, { root });
        await sleep(300);
        root = resolveRoot();
        if (!resolveInput() && hintTexts.length) {
          clickUploadZoneByText(hintTexts, { root });
        }
        input = await waitFor(() => {
          return resolveInput();
        }, {
          timeout,
          interval: 500,
          message: kind === "video" ? "未找到视频上传控件" : "未找到封面上传控件",
        });
      }

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input;
    }

    function findFileInputBySelector(selector, root = document) {
      if (!selector || !root) {
        return null;
      }
      return deepQuerySelectorAll(selector, root).find((element) => element.matches?.("input[type='file']")) || null;
    }

    async function clickBySelector(selector, { timeout = 30000 } = {}) {
      const element = await waitFor(
        () => deepQuerySelectorAll(selector).find(isVisible),
        {
          timeout,
          interval: 500,
          message: `未找到可点击元素：${selector}`,
        },
      );

      element.scrollIntoView({ block: "center", behavior: "smooth" });
      trustedLikeClick(element);
      return element;
    }

    async function waitForVisibleSelector(selector, { timeout = 30000 } = {}) {
      return waitFor(() => deepQuerySelectorAll(selector).find(isVisible), {
        timeout,
        interval: 500,
        message: `未找到页面元素：${selector}`,
      });
    }

    function clickFirstByText(texts, { root = document } = {}) {
      const patterns = texts.map((text) => String(text).trim()).filter(Boolean);
      if (patterns.length === 0) {
        return false;
      }

      const elements = [...deepQuerySelectorAll("button, [role='button'], a, label, div, span", root || document)];
      const match = elements.find((element) => {
        const text = normalizeText(element.textContent);
        return text && text.length <= 80 && patterns.some((pattern) => text.includes(pattern));
      });

      if (!match) {
        return false;
      }

      const clickable = match.closest("button, [role='button'], a, label") || match;
      clickable.scrollIntoView({ block: "center", behavior: "smooth" });
      trustedLikeClick(clickable);
      return true;
    }

    function findEditableNearVisibleText(texts) {
      const placeholder = findBestTextElement(texts, { maxLength: 64, includeEditableText: true });
      if (!placeholder) {
        return null;
      }

      placeholder.scrollIntoView({ block: "center", behavior: "smooth" });
      placeholder.click();

      return resolveEditableTarget(placeholder) || resolveEditableTarget(document.activeElement);
    }

    function findEditableNearLabel(labelTexts, fieldSelector = "") {
      const label = findBestTextElement(labelTexts, { maxLength: 16 });
      if (!label) {
        return null;
      }

      const selectors = fieldSelector || "input, textarea, [contenteditable], [role='textbox'], .ql-editor, .ProseMirror";
      const labelRect = label.getBoundingClientRect();
      const candidates = deepQuerySelectorAll(selectors)
        .filter(isVisible)
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width >= 80 && rect.height >= 20)
        .map(({ element, rect }) => {
          const sameRow = Math.abs(centerY(rect) - centerY(labelRect)) < Math.max(80, rect.height);
          const below = rect.top >= labelRect.top - 12;
          const rightSide = rect.left >= labelRect.left || rect.right > labelRect.right;
          const distance = Math.abs(rect.left - labelRect.right) + Math.abs(centerY(rect) - centerY(labelRect));
          const score = (sameRow ? 200 : 0) + (below ? 80 : 0) + (rightSide ? 80 : 0) - distance / 8 + Math.min(rect.width, 600) / 20;
          return { element, score };
        })
        .sort((a, b) => b.score - a.score);

      if (candidates[0]?.score > 0) {
        return candidates[0].element;
      }

      const clickableArea = findFormControlContainer(label);
      if (clickableArea) {
        trustedLikeClick(clickableArea);
        return resolveEditableTarget(document.activeElement);
      }

      return null;
    }

    function findFormControlContainer(label) {
      const labelRect = label.getBoundingClientRect();
      const candidates = deepQuerySelectorAll("div, section, article")
        .filter(isVisible)
        .map((element) => ({ element, rect: element.getBoundingClientRect(), text: normalizeText(element.textContent) }))
        .filter(({ rect, text }) => rect.left > labelRect.left && rect.top >= labelRect.top - 20 && rect.width >= 160 && rect.height >= 40 && text.length < 140)
        .sort((a, b) => {
          const aDistance = Math.abs(a.rect.left - labelRect.right) + Math.abs(centerY(a.rect) - centerY(labelRect));
          const bDistance = Math.abs(b.rect.left - labelRect.right) + Math.abs(centerY(b.rect) - centerY(labelRect));
          return aDistance - bDistance;
        });

      return candidates[0]?.element || null;
    }

    function clickUploadZoneByText(texts, { root = document } = {}) {
      const hint = findBestTextElement(texts, { maxLength: 180, root: root || document });
      if (!hint) {
        return false;
      }

      const zone = findLargestClickableAncestor(hint);
      zone.scrollIntoView({ block: "center", behavior: "smooth" });
      trustedLikeClick(zone);
      return true;
    }

    async function clickDialogButtonByText(texts, { timeout = 30000 } = {}) {
      const button = await waitFor(() => findBestTextElement(texts, { dialogOnly: true, maxLength: 18 }), {
        timeout,
        interval: 500,
        message: `未找到弹窗按钮：${texts.join(" / ")}`,
      });

      if (button.disabled || button.getAttribute("aria-disabled") === "true") {
        await waitFor(() => !button.disabled && button.getAttribute("aria-disabled") !== "true", {
          timeout,
          interval: 300,
          message: `弹窗按钮不可用：${texts.join(" / ")}`,
        });
      }

      button.scrollIntoView({ block: "center", behavior: "smooth" });
      trustedLikeClick(button);
      return button;
    }

    async function waitForVisibleText(texts, { timeout = 30000, dialogOnly = false, maxLength = 80 } = {}) {
      return waitFor(() => findBestTextElement(texts, { dialogOnly, maxLength }), {
        timeout,
        interval: 500,
        message: `未找到页面文字：${texts.join(" / ")}`,
      });
    }

    function hasVisibleText(texts, { dialogOnly = false, maxLength = 80 } = {}) {
      return Boolean(findBestTextElement(texts, { dialogOnly, maxLength }));
    }

    async function waitForNoDialogText(texts, { timeout = 30000 } = {}) {
      await waitFor(() => !findBestTextElement(texts, { dialogOnly: true, maxLength: 80 }), {
        timeout,
        interval: 500,
        message: `弹窗未关闭：${texts.join(" / ")}`,
      });
    }

    function findBestTextElement(texts, { dialogOnly = false, maxLength = 80, root = null } = {}) {
      const labels = texts.map(normalizeText).filter(Boolean);
      const searchRoot = root || (dialogOnly ? findLikelyDialogRoot() : document);
      if (!searchRoot) {
        return null;
      }

      const elements = [
        ...deepQuerySelectorAll(
          "button, [role='button'], a, label, div, span, p, [role='textbox'], [contenteditable]",
          searchRoot,
        ),
      ].filter(isVisible);
      let best = null;

      for (const element of elements) {
        const text = normalizeText(
          [
            element.textContent,
            element.getAttribute("placeholder"),
            element.getAttribute("data-placeholder"),
            element.getAttribute("aria-label"),
          ]
            .filter(Boolean)
            .join(" "),
        );
        if (!text || text.length > maxLength) {
          continue;
        }

        const label = labels.find((item) => text === item || text.includes(item));
        if (!label) {
          continue;
        }

        const target = element.closest("button, [role='button'], a, label") || element;
        if (!isVisible(target)) {
          continue;
        }

        const score = (text === label ? 100 : 10) - text.length;
        if (!best || score > best.score) {
          best = { element: target, score };
        }
      }

      return best?.element || null;
    }

    function getVisibleSelectorSignature(selector, { dialogOnly = false, attribute = "src" } = {}) {
      const root = dialogOnly ? findLikelyDialogRoot() : document;
      if (!root) {
        return "";
      }

      return deepQuerySelectorAll(selector, root)
        .filter(isVisible)
        .map((element) => {
          const value = element.getAttribute(attribute) || element[attribute] || element.value || normalizeText(element.textContent);
          const rect = element.getBoundingClientRect();
          return `${element.tagName}:${Math.round(rect.width)}x${Math.round(rect.height)}:${createStableSourceSignature(value)}`;
        })
        .filter(Boolean)
        .join("|");
    }

    function createStableSourceSignature(value) {
      const source = String(value || "");
      return `${source.length}:${source.slice(0, 80)}:${source.slice(-80)}`;
    }

    function findLargestClickableAncestor(element) {
      let current = element;
      let best = element;
      let bestScore = 0;

      for (let depth = 0; current && current !== document.body && depth < 8; depth += 1) {
        const rect = current.getBoundingClientRect();
        const text = normalizeText(current.textContent);
        const style = getComputedStyle(current);
        const score =
          Math.min(rect.width, 360) +
          Math.min(rect.height, 520) +
          (style.cursor === "pointer" ? 120 : 0) +
          (String(style.borderStyle).includes("dashed") ? 80 : 0) -
          Math.max(text.length - 180, 0);

        if (rect.width >= 120 && rect.height >= 120 && score > bestScore) {
          best = current;
          bestScore = score;
        }
        current = current.parentElement;
      }

      return best.closest("label, button, [role='button']") || best;
    }

    function resolveEditableTarget(element) {
      if (!element || element === document || element === document.body) {
        return null;
      }

      const direct = element.closest?.("input, textarea, [contenteditable], [role='textbox'], .ql-editor, .ProseMirror");
      if (direct && isVisible(direct)) {
        return direct;
      }

      let current = element.parentElement;
      for (let depth = 0; current && depth < 8; depth += 1) {
        const editable = deepQuerySelectorAll(
          "input, textarea, [contenteditable], [role='textbox'], .ql-editor, .ProseMirror",
          current,
        )[0];
        if (editable && isVisible(editable)) {
          return editable;
        }
        current = current.parentElement;
      }

      return null;
    }

    function findLikelyDialogRoot() {
      const specificCandidates = [
        ...deepQuerySelectorAll(
          "[role='dialog'], .d-modal, .cover-modal, .creator-modal-style, .weui-desktop-dialog__wrp, .weui-desktop-dialog, .finder-common-dialog, .semi-modal, .semi-modal-content, .modal, .ant-modal, .arco-modal",
        ),
      ]
        .filter(isVisible)
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 260 && rect.height > 180);

      if (specificCandidates.length) {
        specificCandidates.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
        return specificCandidates[0].element;
      }

      const genericCandidates = [...deepQuerySelectorAll("body > div")]
        .filter(isVisible)
        .map((element) => ({
          element,
          rect: element.getBoundingClientRect(),
          style: getComputedStyle(element),
        }))
        .filter(
          ({ rect, style }) =>
            rect.width > 260 &&
            rect.height > 180 &&
            rect.width < window.innerWidth * 0.98 &&
            rect.height < window.innerHeight * 0.98 &&
            ["fixed", "absolute", "sticky"].includes(style.position),
        );

      genericCandidates.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
      return genericCandidates[0]?.element || null;
    }

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function centerY(rect) {
      return rect.top + rect.height / 2;
    }

    function probePlatform(platformId) {
      const reasons = [];
      let score = 0;

      const videoInput = findFileInput("video");
      if (videoInput) {
        score += 100;
        reasons.push("video-input");
      }

      if (platformId === "wechatChannels") {
        const uploadZone = findBestTextElement(["上传时长", "20GB", "分辨率720P", "码率10Mbps", "MP4/H.264"], {
          maxLength: 180,
        });
        if (uploadZone) {
          score += 60;
          reasons.push("wechat-upload-zone");
        }
      }

      if (platformId === "bilibili") {
        if (location.host.includes("bilibili.com")) {
          score += 40;
          reasons.push("bilibili-host");
        }

        const editorText = findBestTextElement(["基本设置", "封面", "标题", "标签"], {
          maxLength: 120,
        });
        if (editorText) {
          score += 60;
          reasons.push("bilibili-editor-form");
        }

        const uploadText = findBestTextElement(["视频投稿", "上传视频", "点击上传或将视频拖拽到此区域"], {
          maxLength: 120,
        });
        if (uploadText) {
          score += 30;
          reasons.push("bilibili-upload-zone");
        }
      }

      if (platformId === "youtube") {
        if (location.host.includes("studio.youtube.com")) {
          score += 40;
          reasons.push("youtube-studio-host");
        }

        const editorText = findBestTextElement(["详细信息", "标题", "说明", "缩略图"], {
          maxLength: 120,
        });
        if (editorText) {
          score += 60;
          reasons.push("youtube-editor-form");
        }

        const uploadText = findBestTextElement(["上传视频", "选择文件", "将要上传的视频文件拖放到此处"], {
          maxLength: 120,
        });
        if (uploadText) {
          score += 30;
          reasons.push("youtube-upload-dialog");
        }
      }

      if (findBestTextElement(["视频描述", "短标题"], { maxLength: 20 })) {
        score += 20;
        reasons.push("editor-form");
      }

      return {
        score,
        reasons,
        url: location.href,
        title: document.title,
      };
    }

    function deepQuerySelectorAll(selector, root = document) {
      const results = [];
      const seen = new Set();

      function collect(scope) {
        if (!scope || seen.has(scope)) {
          return;
        }
        seen.add(scope);

        try {
          if (scope.querySelectorAll) {
            results.push(...scope.querySelectorAll(selector));
          }
        } catch (error) {
          return;
        }

        const elements = scope.querySelectorAll ? scope.querySelectorAll("*") : [];
        for (const element of elements) {
          if (element.shadowRoot) {
            collect(element.shadowRoot);
          }
        }
      }

      collect(root);
      return results;
    }

    function trustedLikeClick(element) {
      const rect = element.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      const options = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
      };

      element.dispatchEvent(new PointerEvent("pointerdown", options));
      element.dispatchEvent(new MouseEvent("mousedown", options));
      element.dispatchEvent(new PointerEvent("pointerup", options));
      element.dispatchEvent(new MouseEvent("mouseup", options));
      element.dispatchEvent(new MouseEvent("click", options));
      element.click();
    }

    function descriptionWithTags(description, tags) {
      const tagLine = (tags || []).map((tag) => `#${String(tag).replace(/^#+/, "")}`).join(" ");
      const body = String(description || "").trimEnd();
      return tagLine ? `${body ? `${body}\n` : ""}${tagLine}` : body;
    }

    function normalizeText(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    return {
      sleep,
      waitFor,
      waitForField,
      findFieldByPlaceholder,
      setTextField,
      setTextByPlaceholder,
      setTextByPlaceholderOrVisibleText,
      setTextNearLabel,
      uploadFile,
      clickBySelector,
      waitForVisibleSelector,
      clickFirstByText,
      clickUploadZoneByText,
      clickDialogButtonByText,
      waitForVisibleText,
      hasVisibleText,
      waitForNoDialogText,
      getVisibleSelectorSignature,
      probePlatform,
      descriptionWithTags,
      normalizeText,
    };
  }
})();
