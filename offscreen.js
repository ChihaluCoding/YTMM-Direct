let activeController = null;
let activeJobId = null;
let keepaliveTimerId = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "OFFSCREEN_START_CONVERSION") {
    if (activeJobId) {
      sendResponse({ ok: false, error: "すでに変換中です。" });
      return false;
    }

    startConversionStream(message).catch((error) => {
      notifyError(message.jobId, error);
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "OFFSCREEN_CANCEL_CONVERSION") {
    if (!message.jobId || message.jobId === activeJobId) {
      activeController?.abort();
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function startConversionStream({ jobId, server, request, body }) {
  activeJobId = jobId;
  activeController = new AbortController();
  startKeepalive();

  try {
    const response = await fetch(`${server.url}/download`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${request.serialCode || ""}`
      },
      body: JSON.stringify(body),
      signal: activeController.signal
    });

    if (!response.ok) {
      throw await responseToError(response);
    }

    await readServerSentEvents(response, async (event) => {
      await sendRuntimeMessage({
        type: "OFFSCREEN_CONVERSION_EVENT",
        jobId,
        server,
        event: event.event,
        data: event.data
      });
    });

    await sendRuntimeMessage({ type: "OFFSCREEN_CONVERSION_DONE", jobId });
  } catch (error) {
    if (activeController?.signal.aborted) {
      await notifyError(jobId, { message: "変換をキャンセルしました。", canceled: true });
      return;
    }
    await notifyError(jobId, error);
  } finally {
    if (activeJobId === jobId) {
      activeJobId = null;
      activeController = null;
      stopKeepalive();
    }
  }
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
  error.detail = detail;
  return error;
}

async function notifyError(jobId, error) {
  await sendRuntimeMessage({
    type: "OFFSCREEN_CONVERSION_ERROR",
    jobId,
    error: {
      message: error?.message || "変換に失敗しました。",
      detail: error?.detail || null,
      canceled: error?.canceled === true
    }
  }).catch(() => {});
}

function startKeepalive() {
  stopKeepalive();
  keepaliveTimerId = setInterval(() => {
    sendRuntimeMessage({ type: "OFFSCREEN_KEEPALIVE" }).catch(() => {});
  }, 20000);
}

function stopKeepalive() {
  if (!keepaliveTimerId) return;
  clearInterval(keepaliveTimerId);
  keepaliveTimerId = null;
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
