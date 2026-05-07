const SERVERS = [
  { name: "S1", type: "normal", url: "https://ytmm-api-s1.shamimomo.net/v1" },
  { name: "S2", type: "normal", url: "https://ytmm-api-s2.shamimomo.net/v1" },
  { name: "S3", type: "normal", url: "https://ytmm-api-s3.shamimomo.net/v1" },
  { name: "SP1", type: "premium", url: "https://ytmm-api-sp1.shamimomo.net/v1" },
  { name: "SP2", type: "premium", url: "https://ytmm-api-sp2.shamimomo.net/v1" }
];

const OFFICIAL_APP_URL = "https://receive.shamimomo.net/YouTubeMP3modoki/";
const OFFICIAL_TAB_MATCH = "https://receive.shamimomo.net/YouTubeMP3modoki/*";
const OFFICIAL_SETTINGS_KEY = "youtube-mp3-modoki-settings";
const SERVER_STATUS_CACHE_MS = 30000;
const CONGESTION_COOLDOWN_THRESHOLD = 150;
const CONGESTION_COOLDOWN_MS = 5000;
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const NOTIFICATION_ICON_URL = chrome.runtime.getURL("notification-icon.svg");
const RESTART_BLOCK_WINDOW_MS = 30 * 60 * 1000;
const RESTART_HOURS_JST = [4, 10, 16, 22];

const BUSY_STATES = new Set(["connecting", "waiting", "downloading", "processing", "merging"]);
const FORMAT_EXTENSIONS = {
  m4a: "m4a",
  mp3: "mp3",
  opus: "opus",
  wav: "wav",
  mp4: "mp4",
  "mp4-1080p": "mp4",
  "mp4-720p": "mp4",
  "mp4-540p": "mp4",
  "mp4-480p": "mp4",
  "mp4-360p": "mp4",
  webm: "webm",
  etc: "mp4"
};

let activeController = null;
let activeJobId = null;
let state = createIdleState();
let serverStatusCache = null;
let cooldownUntil = 0;
let creatingOffscreenDocument = null;
const trackedDownloads = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "GET_STATE") {
    sendResponse({ ok: true, state: publicState() });
    return false;
  }

  if (message.type === "START_CONVERSION") {
    if (BUSY_STATES.has(state.status)) {
      sendResponse({ ok: false, error: "すでに変換中です。" });
      return false;
    }

    const cooldownRemainingMs = cooldownUntil - Date.now();
    if (cooldownRemainingMs > 0) {
      sendResponse({
        ok: false,
        error: `混雑対策のため、あと ${Math.ceil(cooldownRemainingMs / 1000)} 秒待ってから再実行してください。`
      });
      return false;
    }

    const restartBlock = getRestartBlockInfo();
    if (restartBlock.blocked) {
      sendResponse({
        ok: false,
        error: restartBlock.message
      });
      return false;
    }

    const request = normalizeRequest(message.payload || {});
    const validationError = validateRequest(request);
    if (validationError) {
      sendResponse({ ok: false, error: validationError });
      return false;
    }

    notifyUser("変換を開始します", "サーバーへ接続しています。");
    startConversion(request);
    sendResponse({ ok: true, state: publicState() });
    return false;
  }

  if (message.type === "CANCEL_CONVERSION") {
    cancelConversion();
    sendResponse({ ok: true, state: publicState() });
    return false;
  }

  if (message.type === "GET_SERVER_STATUSES") {
    getServerStatusSnapshot(undefined, { force: Boolean(message.force) })
      .then((snapshot) => sendResponse({ ok: true, ...snapshot }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || "サーバー混雑状況を取得できませんでした。"
        });
      });
    return true;
  }

  if (message.type === "OFFSCREEN_CONVERSION_EVENT") {
    handleOffscreenConversionEvent(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || "進捗の処理に失敗しました。" });
      });
    return true;
  }

  if (message.type === "OFFSCREEN_CONVERSION_ERROR") {
    handleOffscreenConversionError(message);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "OFFSCREEN_CONVERSION_DONE") {
    handleOffscreenConversionDone(message);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "OFFSCREEN_KEEPALIVE") {
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "IMPORT_OFFICIAL_SERIAL_CODE") {
    importOfficialSerialCode()
      .then((serialState) => sendResponse(serialState))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || "本家サイトの認証チェックに失敗しました。"
        });
      });
    return true;
  }

  return false;
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta?.id || !delta.state?.current) return;

  const tracked = trackedDownloads.get(delta.id);
  if (!tracked) return;

  if (delta.state.current === "complete") {
    notifyUser("ダウンロードが完了しました", tracked.title || "ファイルの保存が完了しました。");
    trackedDownloads.delete(delta.id);
  }

  if (delta.state.current === "interrupted") {
    trackedDownloads.delete(delta.id);
  }
});

function createIdleState() {
  return {
    status: "idle",
    statusMessage: "待機中",
    request: null,
    server: null,
    servers: [],
    serversCheckedAt: null,
    serverStatusCached: false,
    waitInfo: null,
    metadata: null,
    progress: null,
    downloadProgress: null,
    result: null,
    error: null,
    logs: [],
    downloadId: null,
    updatedAt: Date.now()
  };
}

function publicState() {
  return JSON.parse(JSON.stringify({ ...state, cooldownUntil, restartBlock: getRestartBlockInfo() }));
}

function setState(patch) {
  state = { ...state, ...patch, updatedAt: Date.now() };
  updateActionBadge();
  broadcastState();
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: publicState() }, () => {
    void chrome.runtime.lastError;
  });
}

function updateActionBadge() {
  const badge = {
    idle: "",
    connecting: "...",
    waiting: "WAIT",
    downloading: "DL",
    processing: "RUN",
    merging: "RUN",
    success: "OK",
    canceled: "",
    error: "ERR"
  }[state.status] || "";

  const color = state.status === "error"
    ? "#d93025"
    : state.status === "success"
      ? "#137333"
      : state.status === "canceled"
        ? "#9aa8b9"
        : "#0b57d0";
  chrome.action.setBadgeText({ text: badge });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title: `YouTubeMP3modoki Direct: ${state.statusMessage || state.status}` });
}

function notifyUser(title, message) {
  if (!chrome.notifications?.create) return;

  chrome.notifications.create({
    type: "basic",
    iconUrl: NOTIFICATION_ICON_URL,
    title,
    message
  }, () => {
    void chrome.runtime.lastError;
  });
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

function normalizeRequest(input) {
  return {
    url: String(input.url || "").trim(),
    filename: String(input.filename || "").trim() || null,
    format: normalizeFormat(input.format || "m4a"),
    use_aria2: input.use_aria2 !== false,
    embed_thumbnail: input.embed_thumbnail !== false,
    prefer_av1: input.prefer_av1 === true,
    cut_start_time: String(input.cut_start_time || "").trim() || null,
    cut_end_time: String(input.cut_end_time || "").trim() || null,
    serialCode: String(input.serialCode || "").trim()
  };
}

function normalizeFormat(format) {
  const mapped = {
    "mp4(1080p)": "mp4-1080p",
    "mp4(720p)": "mp4-720p",
    "mp4(540p)": "mp4-540p",
    "mp4(480p)": "mp4-480p",
    "mp4(360p)": "mp4-360p"
  }[format] || format;

  return FORMAT_EXTENSIONS[mapped] ? mapped : "m4a";
}

function validateRequest(request) {
  let parsedUrl;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return "URLの形式が正しくありません。";
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return "http または https のURLを指定してください。";
  }

  const timePattern = /^([0-9]{2,}):([0-9]{2}):([0-9]{2})$/;
  if (request.cut_start_time && !timePattern.test(request.cut_start_time)) {
    return "開始時間は HH:MM:SS 形式で入力してください。";
  }
  if (request.cut_end_time && !timePattern.test(request.cut_end_time)) {
    return "終了時間は HH:MM:SS 形式で入力してください。";
  }

  return null;
}

function apiRequestBody(request) {
  return {
    url: request.url,
    filename: request.filename,
    format: request.format,
    use_aria2: request.use_aria2,
    embed_thumbnail: request.embed_thumbnail,
    prefer_av1: request.prefer_av1,
    cut_start_time: request.cut_start_time,
    cut_end_time: request.cut_end_time
  };
}

async function startConversion(request) {
  const jobId = crypto.randomUUID();
  activeJobId = jobId;
  activeController = new AbortController();

  state = {
    ...createIdleState(),
    status: "connecting",
    statusMessage: "サーバー状態を取得しています...",
    request
  };
  setState({});

  try {
    const server = await selectServer(request, activeController.signal);
    ensureCurrentJob(jobId);

    setState({
      server,
      status: "connecting",
      statusMessage: `${server.name} に接続しています...`
    });

    activeController = null;
    await startOffscreenConversion(server, request, jobId);
  } catch (error) {
    if (activeController?.signal.aborted) {
      setState({
        status: "canceled",
        statusMessage: "変換をキャンセルしました。",
        error: null
      });
    } else if (error?.name !== "StaleJobError") {
      setState({
        status: "error",
        statusMessage: error?.message || "変換に失敗しました。",
        error: {
          message: error?.message || "変換に失敗しました。",
          detail: error?.detail || null,
          stack_trace: null
        }
      });
    }
    finishActiveJob(jobId);
  }
}

function cancelConversion() {
  const jobId = activeJobId;
  if (activeController) activeController.abort();
  if (jobId) {
    sendRuntimeMessage({ type: "OFFSCREEN_CANCEL_CONVERSION", jobId }).catch(() => {});
  }

  if (jobId || BUSY_STATES.has(state.status)) {
    setState({
      status: "canceled",
      statusMessage: "変換をキャンセルしました。",
      error: null
    });
    finishActiveJob(jobId);
  }
}

async function startOffscreenConversion(server, request, jobId) {
  await ensureOffscreenDocument();
  const response = await sendRuntimeMessage({
    type: "OFFSCREEN_START_CONVERSION",
    jobId,
    server,
    request,
    body: apiRequestBody(request)
  });

  if (!response?.ok) {
    throw new Error(response?.error || "変換処理を開始できませんでした。");
  }
}

async function handleOffscreenConversionEvent(message) {
  if (message.jobId !== activeJobId) return;
  try {
    await handleSseEvent({
      event: message.event,
      data: message.data
    }, message.server || state.server, state.request, message.jobId);
  } catch (error) {
    if (error?.name === "StaleJobError") return;

    setState({
      status: "error",
      statusMessage: error?.message || "変換に失敗しました。",
      error: {
        message: error?.message || "変換に失敗しました。",
        detail: error?.detail || null,
        stack_trace: null
      }
    });
    sendRuntimeMessage({ type: "OFFSCREEN_CANCEL_CONVERSION", jobId: message.jobId }).catch(() => {});
    finishActiveJob(message.jobId);
  }
}

function handleOffscreenConversionError(message) {
  if (message.jobId !== activeJobId) return;

  if (message.error?.canceled) {
    setState({
      status: "canceled",
      statusMessage: "変換をキャンセルしました。",
      error: null
    });
    finishActiveJob(message.jobId);
    return;
  }

  setState({
    status: "error",
    statusMessage: message.error?.message || "変換に失敗しました。",
    error: {
      message: message.error?.message || "変換に失敗しました。",
      detail: message.error?.detail || null,
      stack_trace: null
    }
  });
  finishActiveJob(message.jobId);
}

function handleOffscreenConversionDone(message) {
  if (message.jobId !== activeJobId) return;

  if (state.status !== "success") {
    setState({
      status: "error",
      statusMessage: "通信が予期せず終了しました。",
      error: { message: "通信が予期せず終了しました。" }
    });
  }
  finishActiveJob(message.jobId);
}

function finishActiveJob(jobId) {
  if (jobId && activeJobId !== jobId) return;
  activeController = null;
  activeJobId = null;
  applyCongestionCooldown();
}

function applyCongestionCooldown() {
  if (BUSY_STATES.has(state.status)) return;
  if (currentCongestionCount() < CONGESTION_COOLDOWN_THRESHOLD) return;

  const nextCooldownUntil = Date.now() + CONGESTION_COOLDOWN_MS;
  if (nextCooldownUntil <= cooldownUntil) return;

  cooldownUntil = nextCooldownUntil;
  setState({});
  setTimeout(() => {
    if (Date.now() >= cooldownUntil && !BUSY_STATES.has(state.status)) {
      setState({});
    }
  }, CONGESTION_COOLDOWN_MS + 150);
}

function currentCongestionCount() {
  const waitCount = Number(state.waitInfo?.total_waiting ?? 0) || 0;
  const selectedServer = state.server
    ? state.servers.find((server) => server.name === state.server.name) || state.server
    : null;
  const selectedServerLoad = selectedServer ? serverLoadCount(selectedServer) : 0;
  return Math.max(waitCount, selectedServerLoad);
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    throw new Error("このChromeではバックグラウンド継続処理に必要な offscreen API を利用できません。");
  }

  if (await hasOffscreenDocument()) return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["WORKERS"],
      justification: "Keep the conversion stream alive after the popup is closed."
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }

  await creatingOffscreenDocument;
}

async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    return contexts.length > 0;
  }

  const matchedClients = await clients.matchAll();
  return matchedClients.some((client) => client.url === offscreenUrl);
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

async function importOfficialSerialCode() {
  let tab = null;
  let temporaryTab = false;

  try {
    const tabs = await queryTabs({ url: OFFICIAL_TAB_MATCH });
    tab = tabs.find((candidate) => candidate.id != null) || null;

    if (!tab) {
      tab = await createTab({ url: OFFICIAL_APP_URL, active: false });
      temporaryTab = true;
    }

    await waitForTabComplete(tab.id);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readOfficialSerialCodeFromPage,
      args: [OFFICIAL_SETTINGS_KEY]
    });

    const result = results?.[0]?.result || {};
    if (!result.serialCode) {
      return {
        ok: false,
        error: result.error || "本家サイトに保存済みのシリアルコードが見つかりませんでした。先に本家サイトでシリアルコードを保存してください。"
      };
    }

    return {
      ok: true,
      serialCode: result.serialCode,
      authRequired: result.authRequired === true,
      source: temporaryTab ? "temporary-tab" : "existing-tab"
    };
  } finally {
    if (temporaryTab && tab?.id != null) {
      await removeTab(tab.id).catch(() => {});
    }
  }
}

function readOfficialSerialCodeFromPage(settingsKey) {
  try {
    const rawSettings = localStorage.getItem(settingsKey);
    if (!rawSettings) {
      return { serialCode: "", error: "本家サイトの保存データが見つかりませんでした。" };
    }

    const settings = JSON.parse(rawSettings);
    const serialCode = typeof settings.serialCode === "string" ? settings.serialCode.trim() : "";
    if (!serialCode) {
      return { serialCode: "", error: "本家サイトにシリアルコードが保存されていません。" };
    }

    return {
      serialCode,
      authRequired: settings.authRequired === true
    };
  } catch (error) {
    return {
      serialCode: "",
      error: `本家サイトの保存データを読み取れませんでした: ${error?.message || error}`
    };
  }
}

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs || []);
    });
  });
}

function createTab(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}

function getTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}

async function waitForTabComplete(tabId, timeoutMs = 12000) {
  const currentTab = await getTab(tabId).catch(() => null);
  if (currentTab?.status === "complete") return;

  await new Promise((resolve) => {
    const timeoutId = setTimeout(finish, timeoutMs);

    function finish() {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function removeTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.remove(tabId, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

async function selectServer(request, signal) {
  const serverStatus = await getServerStatusSnapshot(signal);
  const { servers } = serverStatus;

  setState({
    servers,
    serversCheckedAt: serverStatus.checkedAt,
    serverStatusCached: serverStatus.cached
  });

  const available = servers.filter((server) => server.status === "ok");
  if (available.length === 0) {
    throw new Error("利用可能なサーバーがありません。しばらくしてから再試行してください。");
  }

  if (request.serialCode) {
    const premium = available.filter((server) => server.type === "premium");
    const lowerUrl = request.url.toLowerCase();
    const preferredOrder = lowerUrl.includes("youtube") || lowerUrl.includes("youtu.be")
      ? ["SP1", "SP2"]
      : ["SP2", "SP1"];

    for (const name of preferredOrder) {
      const server = pickLowestLoad(premium.filter((candidate) => candidate.name === name));
      if (server) return server;
    }

    const fallbackPremium = pickLowestLoad(premium);
    if (fallbackPremium) return fallbackPremium;
  }

  const normal = pickLowestLoad(available.filter((server) => server.type === "normal"));
  if (!normal) {
    throw new Error("通常サーバーが利用できません。");
  }
  return normal;
}

async function getServerStatuses(signal) {
  const serverStatus = await getServerStatusSnapshot(signal);
  return serverStatus.servers;
}

async function getServerStatusSnapshot(signal, { force = false } = {}) {
  if (!force && serverStatusCache && Date.now() - serverStatusCache.checkedAt < SERVER_STATUS_CACHE_MS) {
    return {
      ...serverStatusCache,
      cached: true
    };
  }

  const settled = await Promise.allSettled(SERVERS.map((server) => fetchServerStatus(server, signal)));
  const servers = settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    return {
      ...SERVERS[index],
      status: "error",
      active_tasks: 0,
      pending_tasks: 0,
      max_concurrent_tasks: 0,
      latency: null
    };
  });

  serverStatusCache = {
    checkedAt: Date.now(),
    servers
  };

  return {
    ...serverStatusCache,
    cached: false
  };
}

async function fetchServerStatus(server, signal) {
  const startedAt = performance.now();
  const response = await fetchWithTimeout(`${server.url}/health`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
    timeoutMs: 3000
  });

  if (!response.ok) {
    throw new Error(`${server.name}: ${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  return {
    ...server,
    ...body,
    latency: Math.round(performance.now() - startedAt),
    checkedAt: Date.now()
  };
}

function pickLowestLoad(servers) {
  if (!servers.length) return null;

  const sorted = [...servers].sort((left, right) => {
    const leftLoad = (left.active_tasks || 0) + (left.pending_tasks || 0);
    const rightLoad = (right.active_tasks || 0) + (right.pending_tasks || 0);
    if (leftLoad !== rightLoad) return leftLoad - rightLoad;
    return (left.latency ?? Number.MAX_SAFE_INTEGER) - (right.latency ?? Number.MAX_SAFE_INTEGER);
  });

  return sorted[0];
}

function serverLoadCount(server) {
  return (Number(server.active_tasks) || 0) + (Number(server.pending_tasks) || 0);
}

async function streamConversion(server, request, jobId, signal) {
  const response = await fetch(`${server.url}/download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${request.serialCode || ""}`
    },
    body: JSON.stringify(apiRequestBody(request)),
    signal
  });

  ensureCurrentJob(jobId);

  if (!response.ok) {
    throw await responseToError(response);
  }

  setState({
    status: "waiting",
    statusMessage: "変換タスクの開始を待っています..."
  });

  await readServerSentEvents(response, (event) => handleSseEvent(event, server, request, jobId));
}

async function readServerSentEvents(response, onEvent) {
  if (!response.body) {
    throw new Error("サーバーからストリームを取得できませんでした。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseEvent(rawEvent);
      if (event) await onEvent(event);
    }
  }

  buffer += decoder.decode();
  buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (buffer) {
    const event = parseSseEvent(buffer);
    if (event) await onEvent(event);
  }
}

function parseSseEvent(rawEvent) {
  const lines = rawEvent.split("\n");
  let eventName = "message";
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    let value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") eventName = value;
    if (field === "data") dataLines.push(value);
  }

  if (!dataLines.length) return null;

  return {
    event: eventName,
    data: dataLines.join("\n")
  };
}

async function handleSseEvent({ event, data }, server, request, jobId) {
  ensureCurrentJob(jobId);

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new Error(`受信データのJSON解析に失敗しました: ${error.message}`);
  }

  if (event === "wait") {
    setState({
      status: "waiting",
      statusMessage: waitMessage(parsed),
      waitInfo: parsed
    });
    return;
  }

  if (event === "metadata") {
    setState({
      metadata: parsed,
      statusMessage: parsed.title ? `メタデータ取得: ${parsed.title}` : "メタデータを取得しました。"
    });
    return;
  }

  if (event === "progress") {
    setState({
      status: parsed.status || state.status,
      statusMessage: parsed.message || progressStatusMessage(parsed),
      progress: parsed
    });
    return;
  }

  if (event === "download_progress") {
    setState({
      status: "downloading",
      statusMessage: downloadProgressMessage(parsed),
      downloadProgress: parsed
    });
    return;
  }

  if (event === "log") {
    const logs = [...state.logs, parsed].slice(-80);
    setState({ logs });
    return;
  }

  if (event === "result") {
    if (!parsed.download_task_id) {
      throw new Error("変換結果に download_task_id が含まれていません。");
    }

    const notificationTitle = notificationMediaTitle(request, state.metadata);
    notifyUser("変換が完了しました", notificationTitle);

    const fileUrl = `${server.url}/file/${parsed.download_task_id}`;
    setState({
      status: "success",
      statusMessage: "変換が完了しました。ダウンロードを開始しています...",
      result: { ...parsed, fileUrl }
    });

    const downloadId = await startChromeDownload(fileUrl, request, state.metadata, parsed);
    if (downloadId) {
      trackedDownloads.set(downloadId, { title: notificationTitle });
      notifyUser("ダウンロード中です", notificationTitle);
    }
    setState({
      downloadId,
      statusMessage: downloadId
        ? "変換が完了し、Chromeのダウンロードに追加しました。"
        : "変換は完了しましたが、ダウンロード開始を確認できませんでした。"
    });
    return;
  }

  if (event === "error") {
    throw conversionErrorFromServer(parsed);
  }
}

function conversionErrorFromServer(parsed) {
  const message = parsed?.message || "サーバーエラーが発生しました。";
  const detail = parsed?.detail || null;
  const normalized = normalizeServerError(message, detail);
  const error = new Error(normalized.message);
  error.detail = normalized.detail;
  return error;
}

function normalizeServerError(message, detail) {
  const fullText = `${message || ""}\n${detail || ""}`;

  if (/Unable to connect to proxy|NameResolutionError|Failed to resolve|youtubemp3modoki-warp/i.test(fullText)) {
    return {
      message: "サーバー側のYouTube接続経路で一時的なエラーが発生しました。",
      detail: "しばらく時間を置いてから再試行してください。"
    };
  }

  return {
    message: message || "サーバーエラーが発生しました。",
    detail: detail || null
  };
}

function waitMessage(waitInfo) {
  if (typeof waitInfo?.remaining_waiting === "number" && typeof waitInfo?.total_waiting === "number") {
    if (waitInfo.remaining_waiting === 0) {
      return "順番待ち中: 前に 0 人 / サーバーの実行枠待ち";
    }
    return `順番待ち中: 全体 ${waitInfo.total_waiting} 人 / 前に ${waitInfo.remaining_waiting} 人`;
  }
  return "変換タスクの順番を待っています...";
}

function progressStatusMessage(progress) {
  return progress?.message || "変換処理中です...";
}

function downloadProgressMessage(progress) {
  if (!progress) return "動画をダウンロードしています...";

  const percentage = typeof progress.percentage === "number"
    ? `${progress.percentage.toFixed(1)}%`
    : "";
  const downloaded = progress.downloaded_bytes ? formatBytes(progress.downloaded_bytes) : "";
  const total = progress.total_bytes ? formatBytes(progress.total_bytes) : "";
  const speed = progress.speed ? `${formatBytes(progress.speed)}/s` : "";
  const eta = progress.eta ? `残り ${formatSeconds(progress.eta)}` : "";

  const details = [percentage, downloaded && total ? `${downloaded} / ${total}` : downloaded, speed, eta]
    .filter(Boolean)
    .join(" - ");

  return details ? `ダウンロード中 ${details}` : "動画をダウンロードしています...";
}

function notificationMediaTitle(request, metadata) {
  const title = metadata?.title || request?.filename || "";
  return title ? String(title).slice(0, 120) : "変換したファイルを処理しています。";
}

async function startChromeDownload(fileUrl, request, metadata, result) {
  const options = {
    url: fileUrl,
    saveAs: false,
    conflictAction: "uniquify"
  };

  const filename = suggestedDownloadFilename(request, metadata, result);
  if (filename) options.filename = filename;

  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(downloadId || null);
    });
  });
}

function suggestedDownloadFilename(request, metadata, result) {
  if (!request.filename) return null;

  const extension = result?.extension || result?.ext || FORMAT_EXTENSIONS[request.format] || "mp4";
  let filename = sanitizeFilename(request.filename);
  if (!filename) filename = sanitizeFilename(metadata?.title || "download");

  if (!new RegExp(`\\.${escapeRegExp(extension)}$`, "i").test(filename)) {
    filename = `${filename}.${extension}`;
  }

  return filename.slice(0, 180);
}

function sanitizeFilename(filename) {
  return String(filename)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)}${units[unitIndex]}`;
}

function formatSeconds(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const rest = Math.floor(value % 60);
  return minutes ? `${minutes}分${String(rest).padStart(2, "0")}秒` : `${rest}秒`;
}

async function responseToError(response) {
  let detail = response.statusText;
  try {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await response.json();
      detail = body.detail || body.message || JSON.stringify(body);
    } else {
      detail = await response.text();
    }
  } catch {
    // Keep the status text fallback.
  }

  const error = new Error(response.status === 401
    ? "シリアルコードが無効です。"
    : `サーバー接続エラー (${response.status})`);
  const normalized = normalizeServerError(error.message, detail);
  error.message = normalized.message;
  error.detail = normalized.detail;
  return error;
}

async function fetchWithTimeout(url, options) {
  const { timeoutMs = 3000, signal, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const abortFromParent = () => controller.abort();
  signal?.addEventListener("abort", abortFromParent, { once: true });

  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

function ensureCurrentJob(jobId) {
  if (activeJobId !== jobId) {
    const error = new Error("古い変換ジョブを停止しました。");
    error.name = "StaleJobError";
    throw error;
  }
}
