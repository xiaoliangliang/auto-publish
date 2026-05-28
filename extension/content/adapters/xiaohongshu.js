(() => {
  window.ShortVideoPublisherAdapters ||= {};

  window.ShortVideoPublisherAdapters.xiaohongshu = async function publishToXiaohongshu(task, bridge, utils) {
    const warnings = [];
    const coverModalSelector = ".cover-modal";
    const coverEditorInputSelector = `${coverModalSelector} input[type='file'][accept*='image']`;
    const coverOperatorSelector = ".cover-plugin-preview .cover > .default.column .operator";
    const isEditorReady = () =>
      utils.findFieldByPlaceholder(["填写标题", "标题会有更多赞", "请输入标题"]) ||
      document.body?.innerText?.includes("输入正文描述") ||
      document.body?.innerText?.includes("设置封面");
    const isVisible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const clickElement = (element) => {
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
    };
    const openCoverEditor = async () => {
      if (document.querySelector(coverEditorInputSelector)) {
        return;
      }

      const card = await utils.waitFor(
        () => document.querySelector(".cover-plugin-preview .cover > .default.column"),
        { timeout: 30000, interval: 500, message: "未找到小红书当前封面卡片" },
      );
      card.scrollIntoView({ block: "center" });
      await utils.sleep(300);

      const operator = await utils.waitFor(
        () => card.querySelector(".operator") || document.querySelector(coverOperatorSelector),
        { timeout: 90000, interval: 1000, message: "未找到小红书封面修改入口" },
      );

      clickElement(operator);
      await utils.waitFor(
        () => document.querySelector(coverEditorInputSelector),
        { timeout: 30000, interval: 500, message: "未找到小红书封面上传入口" },
      );
    };
    const waitForCoverModalPreview = async (previousPreviewSrc) => {
      await utils.waitFor(
        () => {
          const modal = document.querySelector(coverModalSelector);
          const preview = modal?.querySelector(".preview img.cover");
          const src = preview?.currentSrc || preview?.src || "";
          return isVisible(preview) && src && src !== previousPreviewSrc;
        },
        { timeout: 60000, interval: 500, message: "小红书封面上传后未出现预览" },
      );
    };
    const waitForCoverCardReady = async () => {
      await utils.waitFor(
        () => {
          const card = document.querySelector(".cover-plugin-preview .cover > .default.column");
          const loading = card?.querySelector(".loading");
          return card && (!loading || !isVisible(loading));
        },
        { timeout: 90000, interval: 1000, message: "小红书封面确认后仍在上传中" },
      );
    };

    if (!isEditorReady()) {
      await bridge.updateStatus({ status: "uploading", message: "小红书：正在读取并上传视频", active: true });
      const video = await bridge.getFile("video");
      await utils.uploadFile(video, {
        kind: "video",
        clickTexts: ["上传视频", "拖拽视频到此或点击上传"],
        timeout: 30000,
      });
    }

    await bridge.updateStatus({ status: "uploading", message: "小红书：等待编辑表单出现", active: true });
    await utils.waitForField(["填写标题", "标题会有更多赞", "请输入标题"], 300000);

    await bridge.updateStatus({ status: "filling", message: "小红书：正在填充标题和正文", active: true });
    if (task.title) {
      await utils.setTextByPlaceholder(["填写标题", "标题会有更多赞", "请输入标题"], task.title, 30000);
    }
    await utils.setTextByPlaceholderOrVisibleText(
      ["输入正文描述", "正文描述", "真诚有价值的分享予人温暖", "添加正文"],
      utils.descriptionWithTags(task.description, task.tags),
      30000,
    );

    if (task.cover) {
      try {
        await bridge.updateStatus({ status: "filling", message: "小红书：正在尝试设置封面", active: true });
        const cover = await bridge.getFile("cover");
        document.activeElement?.blur?.();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        await utils.sleep(500);
        await openCoverEditor();
        const previousPreview = document.querySelector(`${coverModalSelector} .preview img.cover`);
        const previousPreviewSrc = previousPreview?.currentSrc || previousPreview?.src || "";
        await utils.uploadFile(cover, {
          kind: "image",
          clickTexts: ["上传图片", "上传封面", "重新上传", "本地上传", "选择图片"],
          timeout: 30000,
          dialogOnly: true,
        });
        await waitForCoverModalPreview(previousPreviewSrc);
        await utils.clickDialogButtonByText(["确定"], { timeout: 60000 });
        await utils.waitForNoDialogText(["设置封面"], { timeout: 60000 });
        await waitForCoverCardReady();
      } catch (error) {
        warnings.push(`封面需手动设置：${error.message}`);
      }
    }

    return {
      message: warnings.length ? "文案已填充，封面可能需要手动确认" : "已填充，等待人工确认发布",
      warnings,
    };
  };
})();
