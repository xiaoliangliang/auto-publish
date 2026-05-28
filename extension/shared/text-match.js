export function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function chooseBestTextMatch(items, labels, options = {}) {
  const maxLength = options.maxLength ?? 80;
  const normalizedLabels = labels.map(normalizeText).filter(Boolean);
  let best = null;

  for (const item of items) {
    const text = normalizeText(
      [
        item.text,
        item.placeholder,
        item.dataPlaceholder,
        item.ariaLabel,
      ]
        .filter(Boolean)
        .join(" "),
    );
    if (!text || text.length > maxLength) {
      continue;
    }

    const label = normalizedLabels.find((candidate) => text === candidate || text.includes(candidate));
    if (!label) {
      continue;
    }

    const score = (text === label ? 100 : 10) - text.length;
    if (!best || score > best.score) {
      best = { ...item, text, score };
    }
  }

  return best;
}

export function chooseUploadZoneTextMatch(items) {
  return chooseBestTextMatch(items, ["上传时长", "20GB", "分辨率720P", "码率10Mbps", "MP4/H.264"], {
    maxLength: 160,
  });
}

export function chooseWechatPersonalCoverMatch(items) {
  return chooseBestTextMatch(items, ["个人主页卡片", "主页卡片", "3:4"], {
    maxLength: 80,
  });
}

export function chooseWechatCoverDialogMatch(items) {
  return chooseBestTextMatch(items, ["编辑封面", "编辑个人主页卡片"], {
    maxLength: 120,
  });
}

export function createStableSourceSignature(value) {
  const source = String(value || "");
  return `${source.length}:${source.slice(0, 80)}:${source.slice(-80)}`;
}
