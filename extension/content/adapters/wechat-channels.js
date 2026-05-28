(() => {
  window.ShortVideoPublisherAdapters ||= {};

  window.ShortVideoPublisherAdapters.wechatChannels = async function publishToWechatChannels(task, bridge, utils) {
    const warnings = [];
    const coverDialogTexts = ["编辑封面", "编辑个人主页卡片"];
    const isCoverDialogOpen = () => utils.hasVisibleText(coverDialogTexts, { dialogOnly: true, maxLength: 80 });
    const isEditorReady = () =>
      isCoverDialogOpen() ||
      utils.findFieldByPlaceholder(["添加描述", "视频描述", "概括视频主要内容"]) ||
      document.body?.innerText?.includes("视频描述");

    if (!isEditorReady()) {
      await bridge.updateStatus({ status: "uploading", message: "视频号：正在读取并上传视频", active: true });
      const video = await bridge.getFile("video");
      await utils.uploadFile(video, {
        kind: "video",
        clickTexts: ["上传", "点击上传", "选择视频"],
        hintTexts: ["上传时长", "20GB", "分辨率720P", "码率10Mbps", "MP4/H.264"],
        timeout: 30000,
      });
    }

    await bridge.updateStatus({ status: "uploading", message: "视频号：等待编辑表单出现", active: true });
    await utils.waitFor(
      isEditorReady,
      {
        timeout: 300000,
        interval: 1000,
        message: "等待视频号编辑表单超时",
      },
    );

    if (!isCoverDialogOpen()) {
      await bridge.updateStatus({ status: "filling", message: "视频号：正在填充描述和短标题", active: true });
      await utils.setTextNearLabel(["视频描述"], utils.descriptionWithTags(task.description, task.tags), {
        timeout: 30000,
        fieldSelector: "textarea, [contenteditable], [role='textbox'], .input-editor",
      });

      if (task.title) {
        await utils.setTextNearLabel(["短标题"], task.title, {
          timeout: 30000,
          fieldSelector: "input, textarea, [contenteditable], [role='textbox']",
        });
      }
    }

    if (task.cover) {
      await bridge.updateStatus({ status: "filling", message: "视频号：正在设置个人主页卡片封面", active: true });
      try {
        const cover = await bridge.getFile("cover");

        if (!isCoverDialogOpen()) {
          await utils.waitForVisibleSelector(".vertical-cover-wrap img", { timeout: 60000 });
          await utils.sleep(5000);
          await utils.clickBySelector(".vertical-cover-wrap", { timeout: 30000 });
          await utils.waitForVisibleText(coverDialogTexts, {
            dialogOnly: true,
            maxLength: 80,
            timeout: 30000,
          });
        }

        const previewSelector = [
          ".profile-preview-container img.preview-image",
          ".profile-preview-container img.preview-image-center",
          ".cover-preview-container img.preview-image",
          ".cover-preview-container img.preview-image-center",
          ".share-card-preview-container img.preview-image",
        ].join(", ");
        const previousPreview = utils.getVisibleSelectorSignature(previewSelector, {
          dialogOnly: true,
          attribute: "src",
        });
        const hadPreview = Boolean(previousPreview);
        const uploadStarted = Date.now();

        await utils.uploadFile(cover, {
          kind: "image",
          clickTexts: ["上传封面"],
          hintTexts: ["上传封面", "裁剪封面图"],
          timeout: 30000,
          dialogOnly: true,
        });

        await utils.waitFor(
          () => {
            const currentPreview = utils.getVisibleSelectorSignature(previewSelector, {
              dialogOnly: true,
              attribute: "src",
            });
            if (!currentPreview) {
              return false;
            }
            if (!hadPreview || currentPreview !== previousPreview) {
              return true;
            }
            return Date.now() - uploadStarted > 3500;
          },
          {
            timeout: 60000,
            interval: 800,
            message: "视频号封面上传后未出现个人主页卡片预览",
          },
        );

        if (utils.hasVisibleText(["裁剪封面图"], { dialogOnly: true, maxLength: 24 })) {
          await utils.clickDialogButtonByText(["确定"], { timeout: 30000 });
          await utils.sleep(800);
        }

        await utils.clickDialogButtonByText(["确认"], { timeout: 30000 });
        await utils.waitForNoDialogText(coverDialogTexts, { timeout: 60000 });
      } catch (error) {
        warnings.push(`视频号个人主页卡片封面设置失败：${error.message || String(error)}`);
      }
    }

    return {
      message: warnings.length ? "文案已填充，封面需手动确认" : "已填充，等待人工确认发布",
      warnings,
    };
  };
})();
