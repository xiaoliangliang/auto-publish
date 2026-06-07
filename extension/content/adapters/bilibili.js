(() => {
  window.ShortVideoPublisherAdapters ||= {};

  window.ShortVideoPublisherAdapters.bilibili = async function publishToBilibili(task, bridge, utils) {
    const warnings = [];

    if (!isEditorReady(utils)) {
      await bridge.updateStatus({ status: "uploading", message: "B站：正在准备上传视频", active: true });
      const dismissedDraft = utils.clickFirstByText(["不用了"]);
      if (dismissedDraft) {
        await utils.sleep(600);
      }

      const video = await bridge.getFile("video");
      await bridge.updateStatus({ status: "uploading", message: "B站：正在读取并上传视频", active: true });
      await utils.uploadFile(video, {
        kind: "video",
        clickTexts: ["上传视频", "点击上传", "选择视频"],
        hintTexts: ["点击上传或将视频拖拽到此区域", "点击上传或拖拽视频到此区域", "上传视频"],
        timeout: 30000,
      });
    } else {
      await bridge.updateStatus({ status: "uploading", message: "B站：检测到编辑页，跳过视频重复上传", active: true });
    }

    await bridge.updateStatus({ status: "uploading", message: "B站：等待编辑表单出现", active: true });
    await utils.waitFor(() => isEditorReady(utils), {
      timeout: 300000,
      interval: 1000,
      message: "等待B站编辑表单超时",
    });

    await bridge.updateStatus({ status: "filling", message: "B站：正在填充标题和标签", active: true });
    if (task.title) {
      await setTitle(task.title, utils);
    }

    if (task.tags?.length) {
      await setTags(task.tags, utils);
    }

    if (task.cover) {
      try {
        await bridge.updateStatus({ status: "filling", message: "B站：正在尝试设置封面", active: true });
        const cover = await bridge.getFile("cover");
        await setCover(cover, utils);
      } catch (error) {
        warnings.push(`B站封面需手动设置：${error.message || String(error)}`);
      }
    }

    return {
      message: warnings.length ? "标题和标签已填充，封面可能需要手动确认" : "已填充，等待人工确认发布",
      warnings,
    };
  };

  async function setTitle(title, utils) {
    const directTitle = document.querySelector("input[placeholder='请输入稿件标题']");
    if (directTitle) {
      utils.setTextField(directTitle, title);
      return;
    }

    try {
      await utils.setTextNearLabel(["标题"], title, {
        timeout: 30000,
        fieldSelector: "input, textarea, [contenteditable], [role='textbox']",
      });
      return;
    } catch (error) {
      await utils.setTextByPlaceholder(["请输入稿件标题", "填写标题", "标题"], title, 30000);
    }
  }

  async function setTags(rawTags, utils) {
    const tags = normalizeTags(rawTags).slice(0, 10);
    if (!tags.length) {
      return;
    }

    const initialInput = await utils.waitFor(() => findTagInput(utils), {
      timeout: 30000,
      interval: 500,
      message: "未找到B站标签输入框",
    });
    const root = findFormRowByLabel(["标签"]) || initialInput.parentElement || document;

    await clearExistingTags(root, utils);

    for (const tag of tags) {
      const input = await utils.waitFor(() => findTagInput(utils), {
        timeout: 5000,
        interval: 300,
        message: "B站标签输入框已失效",
      });
      input.scrollIntoView({ block: "center", behavior: "smooth" });
      input.focus();
      utils.setTextField(input, tag);
      input.focus();
      pressEnter(input);

      await utils.waitFor(() => hasTag(root, tag), {
        timeout: 5000,
        interval: 300,
        message: `B站标签未创建：${tag}`,
      });
    }
  }

  async function setCover(cover, utils) {
    await openCoverEditor(utils);
    const beforeSignature = getCoverSignature(utils);
    const coverInputSelector = ".cover-editor input[type='file'][accept*='image'], .bcc-dialog input[type='file'][accept*='image']";

    try {
      await utils.uploadFile(cover, {
        kind: "image",
        inputSelector: coverInputSelector,
        rootSelector: ".cover-editor, .bcc-dialog",
        clickTexts: ["上传封面", "上传图片", "本地上传", "选择图片", "重新上传"],
        hintTexts: ["上传封面", "选择图片", "封面设置"],
        timeout: 30000,
        dialogOnly: true,
      });
    } catch (dialogError) {
      await utils.uploadFile(cover, {
        kind: "image",
        inputSelector: coverInputSelector,
        rootSelector: ".cover-editor, .bcc-dialog",
        clickTexts: ["上传封面", "上传图片", "本地上传", "选择图片", "重新上传"],
        hintTexts: ["上传封面", "选择图片", "封面设置"],
        timeout: 30000,
      });
    }

    await utils.waitFor(() => isCoverChanged(utils, beforeSignature), {
      timeout: 60000,
      interval: 800,
      message: "B站封面上传后未检测到预览变化",
    });

    await clickOptionalDialogButton(utils, ["完成", "确定", "确认", "保存"]);
  }

  async function openCoverEditor(utils) {
    if (findVisibleImageFileInput()) {
      return;
    }

    const coverRow = await utils.waitFor(() => findFormRowByLabel(["封面"]), {
      timeout: 30000,
      interval: 500,
      message: "未找到B站封面区域",
    });
    const trigger =
      findTextElement(["封面设置", "设置封面", "更换封面", "编辑封面"], {
        root: coverRow,
        maxLength: 24,
      }) || findLargestClickableCoverElement(coverRow);

    clickElement(trigger);
    await utils.waitFor(() => findCoverEditorImageInput() || findLikelyDialogRoot(), {
      timeout: 30000,
      interval: 500,
      message: "B站封面弹窗未打开",
    });
  }

  async function clearExistingTags(root, utils) {
    for (let index = 0; index < 10; index += 1) {
      const close = findTagCloseButton(root);
      if (!close) {
        return;
      }
      clickElement(close);
      await utils.sleep(250);
    }
  }

  function isEditorReady(utils) {
    const text = document.body?.innerText || "";
    return Boolean(
      findTagInput(utils) ||
        (text.includes("基本设置") && text.includes("封面") && text.includes("标题") && text.includes("标签")),
    );
  }

  function findTagInput(utils) {
    return (
      document.querySelector("#tag-container input[placeholder='按回车键Enter创建标签']") ||
      utils.findFieldByPlaceholder(["按回车键Enter创建标签", "Enter创建标签", "创建标签"]) ||
      findEditableInRow(["标签"], "input, [contenteditable], [role='textbox']")
    );
  }

  function findEditableInRow(labels, selector) {
    const row = findFormRowByLabel(labels);
    if (!row) {
      return null;
    }

    return [...row.querySelectorAll(selector)].find((element) => isVisible(element) && element.getBoundingClientRect().width >= 80) || null;
  }

  function findFormRowByLabel(labels) {
    const label = findLabelElement(labels);
    if (!label) {
      return null;
    }

    let current = label.parentElement;
    let best = null;
    for (let depth = 0; current && current !== document.body && depth < 8; depth += 1) {
      const text = normalizeText(current.textContent);
      const rect = current.getBoundingClientRect();
      const hasControl = Boolean(current.querySelector("input, textarea, [contenteditable], [role='textbox'], img, canvas, [style*='background-image']"));
      if (hasControl && rect.width >= 240 && rect.height >= 30 && text.length <= 500) {
        best = current;
        if (current.querySelector("input, textarea, [contenteditable], [role='textbox']")) {
          break;
        }
      }
      current = current.parentElement;
    }

    return best;
  }

  function findLabelElement(labels) {
    const normalizedLabels = labels.map((item) => normalizeLabel(item)).filter(Boolean);
    const candidates = [...document.querySelectorAll("label, span, div, p")]
      .filter(isVisible)
      .map((element) => ({ element, text: normalizeText(element.textContent), rect: element.getBoundingClientRect() }))
      .filter(({ text, rect }) => text && text.length <= 24 && rect.width > 0 && rect.height > 0);

    return (
      candidates.find(({ text }) => normalizedLabels.includes(normalizeLabel(text)))?.element ||
      candidates.find(({ text }) => normalizedLabels.some((label) => normalizeLabel(text).includes(label)))?.element ||
      null
    );
  }

  function findTextElement(texts, { root = document, maxLength = 80 } = {}) {
    const patterns = texts.map(normalizeText).filter(Boolean);
    const elements = [...root.querySelectorAll("button, [role='button'], a, label, div, span")]
      .filter(isVisible)
      .map((element) => ({ element, text: normalizeText(element.textContent) }))
      .filter(({ text }) => text && text.length <= maxLength);

    return elements.find(({ text }) => patterns.some((pattern) => text === pattern || text.includes(pattern)))?.element || null;
  }

  function findLargestClickableCoverElement(root) {
    const candidates = [...root.querySelectorAll("button, [role='button'], label, div, img, canvas")]
      .filter(isVisible)
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: normalizeText(element.textContent) }))
      .filter(({ rect, text }) => rect.width >= 80 && rect.height >= 60 && text.length <= 120)
      .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);

    return candidates[0]?.element || root;
  }

  function findTagCloseButton(root) {
    const candidates = [...root.querySelectorAll("button, [role='button'], i, svg, span")]
      .filter(isVisible)
      .map((element) => ({
        element,
        text: normalizeText(element.textContent),
        attrs: normalizeText(
          [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("class"),
            element.parentElement?.getAttribute("class"),
          ]
            .filter(Boolean)
            .join(" "),
        ).toLowerCase(),
      }));

    const close = candidates.find(({ text, attrs }) => {
      return text === "×" || text === "x" || /(^|[-_\s])(close|delete|remove|clear|del)([-_\s]|$)|关闭|删除|移除/u.test(attrs);
    });
    if (close) {
      return close.element.closest("button, [role='button']") || close.element;
    }

    const chip = [...root.querySelectorAll("span, div")]
      .filter(isVisible)
      .find((element) => {
        const text = normalizeText(element.textContent);
        return text.length <= 24 && /[×xX]$/u.test(text);
      });

    return chip?.lastElementChild || chip || null;
  }

  function hasTag(root, tag) {
    const normalizedTag = normalizeText(tag);
    return [...root.querySelectorAll("span, div")]
      .filter(isVisible)
      .some((element) => {
        const text = normalizeText(element.textContent).replace(/[×xX]$/u, "").trim();
        return text === normalizedTag;
      });
  }

  function findVisibleImageFileInput() {
    return [...document.querySelectorAll("input[type='file']")].find((input) => {
      const accept = String(input.accept || "").toLowerCase();
      return (accept.includes("image") || /png|jpe?g|webp/u.test(accept)) && isVisibleEnoughForFileInput(input);
    });
  }

  function findCoverEditorImageInput() {
    return document.querySelector(".cover-editor input[type='file'][accept*='image'], .bcc-dialog input[type='file'][accept*='image']");
  }

  function getCoverSignature(utils) {
    const row = findFormRowByLabel(["封面"]);
    const dialogRoot = findLikelyDialogRoot();
    const rowSignature = row ? createMediaSignature(row) : "";
    const dialogSignature = dialogRoot ? createMediaSignature(dialogRoot) : "";
    return `${rowSignature}|${dialogSignature}|${utils.getVisibleSelectorSignature("img, [style*='background-image']", { attribute: "src" })}`;
  }

  function isCoverChanged(utils, beforeSignature) {
    const current = getCoverSignature(utils);
    return Boolean(current && current !== beforeSignature);
  }

  function createMediaSignature(root) {
    return [...root.querySelectorAll("img, canvas, [style*='background-image']")]
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const value = element.currentSrc || element.src || element.getAttribute("style") || "";
        return `${element.tagName}:${Math.round(rect.width)}x${Math.round(rect.height)}:${value.length}:${value.slice(0, 60)}:${value.slice(-40)}`;
      })
      .join("|");
  }

  async function clickOptionalDialogButton(utils, texts) {
    for (const text of texts) {
      try {
        await utils.clickDialogButtonByText([text], { timeout: 3000 });
        await utils.sleep(800);
        return true;
      } catch (error) {
        // Try the next likely button label.
      }
    }
    return false;
  }

  function findLikelyDialogRoot() {
    const candidates = [
      ...document.querySelectorAll("[role='dialog'], .bcc-dialog, .bcc-modal, .bili-modal, .modal, .dialog, body > div"),
    ]
      .filter(isVisible)
      .map((element) => ({ element, rect: element.getBoundingClientRect(), style: getComputedStyle(element) }))
      .filter(({ rect, style }) => {
        return rect.width > 260 && rect.height > 180 && ["fixed", "absolute", "sticky"].includes(style.position);
      })
      .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);

    return candidates[0]?.element || null;
  }

  function pressEnter(element) {
    const options = {
      bubbles: true,
      cancelable: true,
      view: window,
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
    };
    element.dispatchEvent(new KeyboardEvent("keydown", options));
    element.dispatchEvent(new KeyboardEvent("keypress", options));
    element.dispatchEvent(new KeyboardEvent("keyup", options));
  }

  function clickElement(element) {
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    const rect = element.getBoundingClientRect();
    const options = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };

    element.dispatchEvent(new PointerEvent("pointerdown", options));
    element.dispatchEvent(new MouseEvent("mousedown", options));
    element.dispatchEvent(new PointerEvent("pointerup", options));
    element.dispatchEvent(new MouseEvent("mouseup", options));
    element.dispatchEvent(new MouseEvent("click", options));
    element.click();
  }

  function normalizeTags(tags) {
    const seen = new Set();
    const result = [];
    for (const tag of tags || []) {
      const normalized = String(tag || "")
        .trim()
        .replace(/^#+/u, "")
        .replace(/[，,。.!！?？:：;；]+$/u, "")
        .trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      result.push(normalized);
    }
    return result;
  }

  function normalizeLabel(value) {
    return normalizeText(value).replace(/^[*＊]\s*/u, "").replace(/\s+/g, "");
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function isVisibleEnoughForFileInput(input) {
    if (!input) {
      return false;
    }
    const rect = input.getBoundingClientRect();
    const style = getComputedStyle(input);
    return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 0 && rect.height >= 0;
  }
})();
