(() => {
  window.ShortVideoPublisherAdapters ||= {};

  window.ShortVideoPublisherAdapters.douyin = async function publishToDouyin(task, bridge, utils) {
    const warnings = [];
    const titlePlaceholders = ["填写作品标题", "作品标题"];

    if (!isEditorReady(utils, titlePlaceholders)) {
      await bridge.updateStatus({ status: "uploading", message: "抖音：正在读取并上传视频", active: true });
      const video = await bridge.getFile("video");
      await utils.uploadFile(video, {
        kind: "video",
        clickTexts: ["上传视频", "点击上传", "点击上传 或直接将视频文件拖入此区域"],
        timeout: 30000,
      });

      await bridge.updateStatus({ status: "uploading", message: "抖音：等待上传完成并进入编辑页", active: true });
    } else {
      await bridge.updateStatus({ status: "uploading", message: "抖音：检测到编辑页，跳过视频重复上传", active: true });
    }
    await utils.waitForField(titlePlaceholders, 300000);

    await bridge.updateStatus({ status: "filling", message: "抖音：正在填充标题和描述", active: true });
    if (task.title) {
      await utils.setTextByPlaceholder(titlePlaceholders, task.title, 30000);
    }
    await utils.setTextByPlaceholder(["添加作品简介", "作品简介", "输入简介"], utils.descriptionWithTags(task.description, task.tags), 30000);

    if (task.cover) {
      try {
        await bridge.updateStatus({ status: "filling", message: "抖音：正在尝试设置竖版封面", active: true });
        const cover = await bridge.getFile("cover");
        const beforeSignature = getVerticalCoverSignature(utils);

        await openVerticalCoverDialog(utils);
        await utils.waitFor(() => findDouyinCoverUploadInput(), {
          timeout: 30000,
          interval: 500,
          message: "未找到抖音竖封面上传入口",
        });

        await utils.uploadFile(cover, {
          kind: "image",
          inputSelector: ".dy-creator-content-modal .container-XzaV9h.upload-ZOJTUA input[type='file'].semi-upload-hidden-input, .dy-creator-content-modal .upload-ZOJTUA input[type='file'].semi-upload-hidden-input",
          rootSelector: ".dy-creator-content-modal",
          clickTexts: ["上传封面"],
          hintTexts: ["上传封面", "点击上传文件或拖拽文件到这里"],
          timeout: 30000,
        });

        await utils.waitFor(() => hasUploadedCoverPreview(), {
          timeout: 60000,
          interval: 500,
          message: "抖音竖封面上传后未出现预览",
        });

        await bridge.updateStatus({ status: "filling", message: "抖音：竖封面已上传，正在写入页面", active: true });
        const finishButton = await utils.waitFor(() => findCoverDialogButton("完成"), {
          timeout: 60000,
          interval: 500,
          message: "抖音竖封面上传后完成按钮不可用",
        });
        clickElement(finishButton);

        await utils.waitFor(() => isVerticalCoverApplied(utils, beforeSignature), {
          timeout: 90000,
          interval: 1000,
          message: "抖音竖封面未写入页面",
        });

        if (isActiveCoverDialogOpen()) {
          closeDouyinCoverDialog();
          await utils.sleep(800);
        }
      } catch (error) {
        warnings.push(`竖封面需手动设置：${error.message}`);
      }
    }

    return {
      message: warnings.length ? "文案已填充，封面可能需要手动确认" : "已填充，等待人工确认发布",
      warnings,
    };
  };

  function isEditorReady(utils, titlePlaceholders) {
    return Boolean(utils.findFieldByPlaceholder(titlePlaceholders) || document.body?.innerText?.includes("设置封面"));
  }

  async function openVerticalCoverDialog(utils) {
    const card = await utils.waitFor(() => findVerticalCoverCard(utils), {
      timeout: 30000,
      interval: 500,
      message: "未找到抖音竖封面入口",
    });

    clickElement(card.querySelector("[class*='cover-'], [class*='filter']") || card);
    await utils.waitFor(() => isActiveCoverDialogOpen(), {
      timeout: 30000,
      interval: 500,
      message: "抖音竖封面弹窗未打开",
    });
  }

  function findVerticalCoverCard(utils) {
    return [...document.querySelectorAll(".coverControl-CjlzqC, [class*='coverControl']")].find((element) => {
      const text = utils.normalizeText(element.textContent);
      return text.includes("竖封面3:4") || text.includes("竖封面 3:4");
    });
  }

  function getVerticalCoverSignature(utils) {
    const card = findVerticalCoverCard(utils);
    const background = card?.querySelector("[style*='background-image']")?.getAttribute("style") || "";
    return `${utils.normalizeText(card?.textContent)}|${background}`;
  }

  function isVerticalCoverApplied(utils, beforeSignature) {
    const card = findVerticalCoverCard(utils);
    if (!card) {
      return false;
    }

    const text = utils.normalizeText(card.textContent);
    const actionText = utils.normalizeText(card.querySelector(".title-wA45Xd, [class*='title']")?.textContent);
    const signature = getVerticalCoverSignature(utils);
    return signature !== beforeSignature && (actionText.includes("编辑封面") || !text.includes("选择封面"));
  }

  function findDouyinCoverUploadInput() {
    return document.querySelector(
      ".dy-creator-content-modal .container-XzaV9h.upload-ZOJTUA input[type='file'].semi-upload-hidden-input, .dy-creator-content-modal .upload-ZOJTUA input[type='file'].semi-upload-hidden-input",
    );
  }

  function hasUploadedCoverPreview() {
    const uploadArea = document.querySelector(".dy-creator-content-modal .container-XzaV9h.upload-ZOJTUA, .dy-creator-content-modal .upload-ZOJTUA");
    if (!uploadArea) {
      return false;
    }

    return Boolean(uploadArea.querySelector(".bg-UvmtRj, [style*='data:image'], [style*='blob:'], img[src^='data:'], img[src^='blob:']"));
  }

  function findCoverDialogButton(text) {
    return [...document.querySelectorAll(".dy-creator-content-modal button, .dy-creator-content-modal [role='button']")].find((element) => {
      const normalized = String(element.textContent || "").replace(/\s+/g, " ").trim();
      const disabled =
        element.disabled ||
        element.getAttribute("aria-disabled") === "true" ||
        String(element.className || "").includes("disabled");
      return normalized === text && !disabled && isVisible(element);
    });
  }

  function isActiveCoverDialogOpen() {
    const contentNodes = [...document.querySelectorAll(".dy-creator-content-modal-content")].filter(isVisible);
    if (contentNodes.length) {
      return contentNodes.some((element) => !String(element.className || "").includes("animate-hide"));
    }

    return [...document.querySelectorAll(".dy-creator-content-modal, .dy-creator-content-modal-wrap")].some((element) => {
      return isVisible(element) && !String(element.className || "").includes("animate-hide");
    });
  }

  function closeDouyinCoverDialog() {
    const closeButton = [...document.querySelectorAll(".dy-creator-content-modal .close-ksT2V8, .dy-creator-content-modal [class*='close'], .dy-creator-content-modal [class*='Close']")]
      .find(isVisible);
    if (closeButton) {
      clickElement(closeButton);
    }
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

  function isVisible(element) {
    if (!element) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }
})();
