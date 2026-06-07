(() => {
  window.ShortVideoPublisherAdapters ||= {};

  window.ShortVideoPublisherAdapters.youtube = async function publishToYoutube(task, bridge, utils) {
    const warnings = [];

    if (!isEditorReady(utils)) {
      await bridge.updateStatus({ status: "uploading", message: "YouTube：正在读取并上传视频", active: true });
      const video = await bridge.getFile("video");
      await utils.uploadFile(video, {
        kind: "video",
        clickTexts: ["选择文件", "上传视频"],
        hintTexts: ["将要上传的视频文件拖放到此处", "选择文件", "上传视频"],
        timeout: 30000,
      });
    } else {
      await bridge.updateStatus({ status: "uploading", message: "YouTube：检测到编辑页，跳过视频重复上传", active: true });
    }

    await bridge.updateStatus({ status: "uploading", message: "YouTube：等待编辑表单出现", active: true });
    await utils.waitFor(() => isEditorReady(utils), {
      timeout: 300000,
      interval: 1000,
      message: "等待YouTube编辑表单超时",
    });

    const titleText = task.youtubeTitle || buildTitleField(task, utils);
    if (Array.from(titleText).length > 100) {
      warnings.push("YouTube标题栏上限100字符，超出部分可能需要手动调整");
    }

    await bridge.updateStatus({ status: "filling", message: "YouTube：正在把标题、正文和标签写入标题栏", active: true });
    await setTitleField(titleText, utils);

    return {
      message: warnings.length ? "YouTube标题栏已填充，内容可能需要手动调整" : "已填充YouTube标题栏，等待人工确认发布",
      warnings,
    };
  };

  async function setTitleField(value, utils) {
    const text = String(value || "").trim();
    if (!text) {
      return;
    }

    const field = await utils.setTextNearLabel(["标题", "Title"], text, {
      timeout: 30000,
      fieldSelector: "#textbox, textarea, input, [contenteditable], [role='textbox']",
    });

    // YouTube's custom textbox can re-render after focus; extra events keep Polymer state in sync.
    const host = field.getRootNode?.()?.host;
    for (const target of [field, host].filter(Boolean)) {
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function isEditorReady(utils) {
    const text = document.body?.innerText || "";
    return (
      (text.includes("详细信息") &&
        (text.includes("标题") || text.includes("Title")) &&
        (text.includes("说明") || text.includes("Description") || text.includes("缩略图"))) ||
      (utils.hasVisibleText(["详细信息", "Details"], { maxLength: 30 }) &&
        utils.hasVisibleText(["标题", "Title"], { maxLength: 30 }))
    );
  }

  function buildTitleField(task, utils) {
    const descriptionWithTags = utils.descriptionWithTags(task.description, task.tags).trim();
    return [String(task.title || "").trim(), descriptionWithTags].filter(Boolean).join("\n");
  }
})();
