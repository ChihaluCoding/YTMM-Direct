const DEFAULT_SETTINGS = {
  url: "",
  filename: "",
  format: "m4a",
  useAria2: true,
  embedThumbnail: true,
  preferAv1: false,
  cutStartTime: "",
  cutEndTime: "",
  serialCode: ""
};

const BUSY_STATES = new Set(["connecting", "waiting", "downloading", "processing", "merging"]);

const elements = {
  form: document.getElementById("downloadForm"),
  infoButton: document.getElementById("infoButton"),
  infoPanel: document.getElementById("infoPanel"),
  url: document.getElementById("url"),
  filename: document.getElementById("filename"),
  format: document.getElementById("format"),
  useAria2: document.getElementById("useAria2"),
  embedThumbnail: document.getElementById("embedThumbnail"),
  preferAv1: document.getElementById("preferAv1"),
  cutStartTime: document.getElementById("cutStartTime"),
  cutEndTime: document.getElementById("cutEndTime"),
  serialCode: document.getElementById("serialCode"),
  serialAuthButton: document.getElementById("serialAuthButton"),
  serialAuthStatus: document.getElementById("serialAuthStatus"),
  submitButton: document.getElementById("submitButton"),
  cancelButton: document.getElementById("cancelButton"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  progressBar: document.getElementById("progressBar"),
  detailText: document.getElementById("detailText"),
  fileLink: document.getElementById("fileLink"),
  serverRefreshButton: document.getElementById("serverRefreshButton"),
  serverList: document.getElementById("serverList"),
  serverUpdatedAt: document.getElementById("serverUpdatedAt")
};

const DEFAULT_SUBMIT_BUTTON_TEXT = elements.submitButton.textContent;
const HEAVY_CONGESTION_COUNT = 150;
const RESTART_BLOCK_WINDOW_MS = 30 * 60 * 1000;
const RESTART_HOURS_JST = [4, 10, 16, 22];
const SERVER_STATUS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let serialAuthChecking = false;
let conversionBusy = false;
let cooldownTimerId = null;
let restartBlockTimerId = null;
let serverStatusTimerId = null;
let currentCooldownUntil = 0;
let serverStatusLoading = false;

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await fillCurrentTabUrl({ onlyWhenEmpty: true });
  await refreshState();
  refreshServerStatuses({ force: true });
  serverStatusTimerId = setInterval(() => {
    refreshServerStatuses({ force: true, showLoading: false });
  }, SERVER_STATUS_REFRESH_INTERVAL_MS);
  restartBlockTimerId = setInterval(() => updateCooldownButton(currentCooldownUntil), 1000);
  updateCooldownButton(currentCooldownUntil);
});

window.addEventListener("pagehide", () => {
  if (serverStatusTimerId) clearInterval(serverStatusTimerId);
  if (restartBlockTimerId) clearInterval(restartBlockTimerId);
  if (cooldownTimerId) clearTimeout(cooldownTimerId);
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const restartBlock = getRestartBlockInfo();
  if (restartBlock.blocked) {
    renderLocalError(restartBlock.message);
    updateCooldownButton(currentCooldownUntil);
    return;
  }

  const settings = readSettings();
  const validationError = validateSettings(settings);
  if (validationError) {
    renderLocalError(validationError);
    return;
  }

  await saveSettings(settings);

  chrome.runtime.sendMessage({ type: "START_CONVERSION", payload: toBackgroundPayload(settings) }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      renderLocalError(error.message);
      return;
    }
    if (!response?.ok) {
      renderLocalError(response?.error || "変換を開始できませんでした。");
      return;
    }
    if (response.state) renderState(response.state);
  });
});

elements.cancelButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CANCEL_CONVERSION" }, (response) => {
    if (response?.state) renderState(response.state);
  });
});

elements.infoButton.addEventListener("click", () => {
  const isOpen = elements.infoButton.getAttribute("aria-expanded") === "true";
  elements.infoButton.setAttribute("aria-expanded", String(!isOpen));
  elements.infoPanel.hidden = isOpen;
});

elements.serialAuthButton.addEventListener("click", () => {
  checkOfficialSerialAuth();
});

elements.serverRefreshButton.addEventListener("click", () => {
  refreshServerStatuses({ force: true });
});

for (const element of settingsElements()) {
  element.addEventListener("change", () => saveSettings(readSettings()));
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "STATE_UPDATE") {
    renderState(message.state);
  }
});

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  elements.url.value = stored.url || "";
  elements.filename.value = stored.filename || "";
  elements.format.value = stored.format || "m4a";
  elements.useAria2.checked = stored.useAria2 !== false;
  elements.embedThumbnail.checked = stored.embedThumbnail !== false;
  elements.preferAv1.checked = stored.preferAv1 === true;
  elements.cutStartTime.value = stored.cutStartTime || "";
  elements.cutEndTime.value = stored.cutEndTime || "";
  elements.serialCode.value = stored.serialCode || "";
}

function readSettings() {
  return {
    url: elements.url.value.trim(),
    filename: elements.filename.value.trim(),
    format: elements.format.value,
    useAria2: elements.useAria2.checked,
    embedThumbnail: elements.embedThumbnail.checked,
    preferAv1: elements.preferAv1.checked,
    cutStartTime: elements.cutStartTime.value.trim(),
    cutEndTime: elements.cutEndTime.value.trim(),
    serialCode: elements.serialCode.value.trim()
  };
}

async function saveSettings(settings) {
  await chrome.storage.local.set(settings);
}

function toBackgroundPayload(settings) {
  return {
    url: settings.url,
    filename: settings.filename || null,
    format: settings.format,
    use_aria2: settings.useAria2,
    embed_thumbnail: settings.embedThumbnail,
    prefer_av1: settings.preferAv1,
    cut_start_time: settings.cutStartTime || null,
    cut_end_time: settings.cutEndTime || null,
    serialCode: settings.serialCode
  };
}

function validateSettings(settings) {
  try {
    const parsedUrl = new URL(settings.url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return "http または https のURLを指定してください。";
    }
  } catch {
    return "URLの形式が正しくありません。";
  }

  const timePattern = /^([0-9]{2,}):([0-9]{2}):([0-9]{2})$/;
  if (settings.cutStartTime && !timePattern.test(settings.cutStartTime)) {
    return "開始時間は HH:MM:SS 形式で入力してください。";
  }
  if (settings.cutEndTime && !timePattern.test(settings.cutEndTime)) {
    return "終了時間は HH:MM:SS 形式で入力してください。";
  }

  return null;
}

async function fillCurrentTabUrl({ onlyWhenEmpty }) {
  if (onlyWhenEmpty && elements.url.value.trim()) return;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tabs?.[0]?.url || "";
  if (/^https?:\/\//i.test(url)) {
    elements.url.value = url;
    await saveSettings(readSettings());
  }
}

async function refreshState() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
    if (chrome.runtime.lastError) {
      renderLocalError(chrome.runtime.lastError.message);
      return;
    }
    if (response?.state) renderState(response.state);
  });
}

async function checkOfficialSerialAuth() {
  serialAuthChecking = true;
  elements.serialAuthButton.disabled = true;
  setSerialAuthStatus("シリアルコードをチェック中", "busy");

  chrome.runtime.sendMessage({ type: "IMPORT_OFFICIAL_SERIAL_CODE" }, (response) => {
    const error = chrome.runtime.lastError;

    (async () => {
      if (error) {
        setSerialAuthStatus(error.message || "認証チェックに失敗しました。", "error");
        return;
      }

      if (!response?.ok || !response.serialCode) {
        setSerialAuthStatus(response?.error || "本家サイトに保存済みのシリアルコードが見つかりませんでした。", "error");
        return;
      }

      elements.serialCode.value = response.serialCode;
      await saveSettings(readSettings());
      setSerialAuthStatus("本家サイトの認証を読み込みました。", "success");
    })().catch((saveError) => {
      setSerialAuthStatus(saveError?.message || "認証情報の保存に失敗しました。", "error");
    }).finally(() => {
      serialAuthChecking = false;
      elements.serialAuthButton.disabled = conversionBusy || serialAuthChecking;
    });
  });
}

function setSerialAuthStatus(message, status) {
  elements.serialAuthStatus.textContent = message;
  elements.serialAuthStatus.className = "serial-auth-status";
  if (status) elements.serialAuthStatus.classList.add(`is-${status}`);
}

async function refreshServerStatuses({ force = false, showLoading = true } = {}) {
  if (serverStatusLoading) return;

  serverStatusLoading = true;
  elements.serverRefreshButton.disabled = true;
  if (showLoading) renderServerLoading();

  chrome.runtime.sendMessage({ type: "GET_SERVER_STATUSES", force }, (response) => {
    const error = chrome.runtime.lastError;
    serverStatusLoading = false;
    elements.serverRefreshButton.disabled = conversionBusy;

    if (error || !response?.ok) {
      renderServerError(error?.message || response?.error || "サーバー混雑状況を取得できませんでした。");
      return;
    }

    renderServerStatuses(response.servers || [], response.checkedAt, response.cached);
  });
}

function renderState(state) {
  const status = state?.status || "idle";
  const busy = BUSY_STATES.has(status);
  conversionBusy = busy;

  elements.submitButton.disabled = busy;
  elements.submitButton.textContent = DEFAULT_SUBMIT_BUTTON_TEXT;
  elements.cancelButton.hidden = !busy;
  elements.serialAuthButton.disabled = busy || serialAuthChecking;
  elements.serverRefreshButton.disabled = busy || serverStatusLoading;
  for (const element of settingsElements()) {
    element.disabled = busy;
  }

  elements.statusDot.className = "status-dot";
  if (busy) elements.statusDot.classList.add("is-busy");
  if (status === "success") elements.statusDot.classList.add("is-success");
  if (status === "canceled") elements.statusDot.classList.add("is-canceled");
  if (status === "error") elements.statusDot.classList.add("is-error");

  elements.statusText.textContent = statusLabel(status);
  elements.detailText.textContent = detailMessage(state);

  renderProgress(state);
  renderFileLink(state);
  renderServerStatuses(state?.servers || [], state?.serversCheckedAt, state?.serverStatusCached);
  renderCooldown(state?.cooldownUntil);
}

function renderProgress(state) {
  const progress = state?.downloadProgress?.percentage;
  const isBusy = BUSY_STATES.has(state?.status);

  elements.progressBar.className = "progress-bar";
  if (typeof progress === "number") {
    elements.progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    return;
  }

  if (state?.status === "success") {
    elements.progressBar.style.width = "100%";
    return;
  }

  if (isBusy) {
    elements.progressBar.style.width = "38%";
    elements.progressBar.classList.add("is-indeterminate");
    return;
  }

  elements.progressBar.style.width = "0%";
}

function renderFileLink(state) {
  const fileUrl = state?.result?.fileUrl;
  if (!fileUrl) {
    elements.fileLink.hidden = true;
    elements.fileLink.href = "#";
    return;
  }

  elements.fileLink.hidden = false;
  elements.fileLink.href = fileUrl;
}

function renderCooldown(cooldownUntil) {
  currentCooldownUntil = Number(cooldownUntil || 0);
  if (cooldownTimerId) {
    clearInterval(cooldownTimerId);
    cooldownTimerId = null;
  }

  updateCooldownButton(currentCooldownUntil);
  if (cooldownRemainingMs(currentCooldownUntil) > 0) {
    cooldownTimerId = setInterval(() => updateCooldownButton(currentCooldownUntil), 250);
  }
}

function updateCooldownButton(cooldownUntil) {
  if (conversionBusy) {
    elements.submitButton.disabled = true;
    elements.submitButton.textContent = DEFAULT_SUBMIT_BUTTON_TEXT;
    elements.submitButton.removeAttribute("title");
    return;
  }

  const restartBlock = getRestartBlockInfo();
  if (restartBlock.blocked) {
    elements.submitButton.disabled = true;
    elements.submitButton.textContent = `${restartBlock.restartTime}まで停止`;
    elements.submitButton.title = restartBlock.message;
    return;
  }

  const remainingMs = cooldownRemainingMs(cooldownUntil);
  if (remainingMs <= 0) {
    if (cooldownTimerId) {
      clearInterval(cooldownTimerId);
      cooldownTimerId = null;
    }
    elements.submitButton.disabled = false;
    elements.submitButton.textContent = DEFAULT_SUBMIT_BUTTON_TEXT;
    elements.submitButton.removeAttribute("title");
    return;
  }

  elements.submitButton.disabled = true;
  elements.submitButton.textContent = `再実行まで ${Math.ceil(remainingMs / 1000)}秒`;
  elements.submitButton.title = "混雑対策のクールダウン中です。";
}

function cooldownRemainingMs(cooldownUntil) {
  return Math.max(0, Number(cooldownUntil || 0) - Date.now());
}

function getRestartBlockInfo(now = new Date()) {
  const currentJstMs = jstWallClockMs(now);

  for (const hour of RESTART_HOURS_JST) {
    const restartJstMs = restartWallClockMs(now, hour);
    const blockStartJstMs = restartJstMs - RESTART_BLOCK_WINDOW_MS;

    if (currentJstMs >= blockStartJstMs && currentJstMs < restartJstMs) {
      const restartTime = `${String(hour).padStart(2, "0")}:00`;
      return {
        blocked: true,
        restartTime,
        remainingMs: restartJstMs - currentJstMs,
        message: `サーバー再起動前のため、${restartTime} まで変換を開始できません。`
      };
    }
  }

  return {
    blocked: false,
    restartTime: null,
    remainingMs: 0,
    message: ""
  };
}

function jstWallClockMs(date) {
  const parts = jstDateParts(date);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function restartWallClockMs(date, hour) {
  const parts = jstDateParts(date);
  return Date.UTC(parts.year, parts.month - 1, parts.day, hour, 0, 0);
}

function jstDateParts(date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function renderServerLoading() {
  elements.serverList.replaceChildren(textBlock("server-empty", "取得中..."));
  elements.serverUpdatedAt.textContent = "";
}

function renderServerError(message) {
  elements.serverList.replaceChildren(textBlock("server-empty", message));
  elements.serverUpdatedAt.textContent = "";
}

function renderServerStatuses(servers, checkedAt, cached) {
  if (!servers.length) {
    elements.serverList.replaceChildren(textBlock("server-empty", "まだ取得していません。"));
    elements.serverUpdatedAt.textContent = "";
    return;
  }

  const rows = servers.map((server) => {
    const active = Number(server.active_tasks) || 0;
    const pending = Number(server.pending_tasks) || 0;
    const maxConcurrent = Number(server.max_concurrent_tasks) || 0;
    const load = active + pending;
    const usagePercentage = server.status === "ok"
      ? serverUsagePercentage(active, pending, maxConcurrent)
      : 0;
    const row = document.createElement("div");
    row.className = "server-row";
    if (server.type === "premium") row.classList.add("is-premium");
    if (server.status !== "ok") {
      row.classList.add("is-error");
    } else if (load >= HEAVY_CONGESTION_COUNT) {
      row.classList.add("is-heavy");
    } else if (pending > 0 || usagePercentage >= 80) {
      row.classList.add("is-busy");
    }

    const name = document.createElement("span");
    name.className = "server-name";
    name.textContent = `${server.name || "-"}${server.type === "premium" ? " P" : ""}`;
    name.title = server.type === "premium" ? "プレミアムサーバー" : "通常サーバー";

    const meter = document.createElement("div");
    meter.className = "server-meter";
    const fill = document.createElement("div");
    fill.className = "server-meter-fill";
    fill.style.width = `${usagePercentage}%`;
    meter.append(fill);

    const loadText = document.createElement("span");
    loadText.className = "server-load";
    loadText.textContent = server.status === "ok"
      ? `待ち ${pending} / 実行 ${active}${maxConcurrent ? `/${maxConcurrent}` : ""}${server.latency ? ` / ${server.latency}ms` : ""}`
      : "取得失敗";

    row.append(name, meter, loadText);
    return row;
  });

  elements.serverList.replaceChildren(...rows);
  elements.serverUpdatedAt.textContent = checkedAt
    ? `${formatTime(checkedAt)} 更新`
    : "";
}

function serverUsagePercentage(active, pending, maxConcurrent) {
  if (pending > 0) return 100;
  if (maxConcurrent > 0) {
    return Math.max(4, Math.min(100, Math.round((active / maxConcurrent) * 100)));
  }
  return Math.min(100, Math.round(((active + pending) / HEAVY_CONGESTION_COUNT) * 100));
}

function textBlock(className, text) {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = text;
  return element;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function renderLocalError(message) {
  renderState({
    status: "error",
    statusMessage: message,
    error: { message }
  });
}

function statusLabel(status) {
  return {
    idle: "待機中",
    connecting: "接続中",
    waiting: "順番待ち",
    downloading: "ダウンロード中",
    processing: "変換中",
    merging: "結合中",
    success: "完了",
    canceled: "キャンセルしました",
    error: "エラー"
  }[status] || status;
}

function detailMessage(state) {
  if (!state) return "";
  if (state.status === "error") {
    return [state.error?.message, state.error?.detail].filter(Boolean).join("\n") || state.statusMessage || "";
  }
  if (state.status === "success") {
    const title = state.metadata?.title ? `\n${state.metadata.title}` : "";
    return `${state.statusMessage || "変換が完了しました。"}${title}`;
  }
  if (state.status === "canceled") {
    return state.statusMessage || "変換をキャンセルしました。";
  }
  return state.statusMessage || "";
}

function settingsElements() {
  return [
    elements.url,
    elements.filename,
    elements.format,
    elements.useAria2,
    elements.embedThumbnail,
    elements.preferAv1,
    elements.cutStartTime,
    elements.cutEndTime,
    elements.serialCode
  ];
}
