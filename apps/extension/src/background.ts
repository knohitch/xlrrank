const API_BASE = "http://localhost:4000";

chrome.runtime.onInstalled.addListener(() => {
  console.log("XLRrank extension installed");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "xlrrank:ping") {
    sendResponse({ ok: true, app: "XLRrank extension", version: "0.1.0" });
    return;
  }

  if (message?.type === "xlrrank:api-status") {
    fetch(`${API_BASE}/health/live`)
      .then((res) => res.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) =>
        sendResponse({ ok: false, error: (err as Error).message }),
      );
    return true;
  }

  if (message?.type === "xlrrank:set-auth") {
    chrome.storage.local.set({ auth: message.auth }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "xlrrank:get-auth") {
    chrome.storage.local.get("auth", (result) => {
      sendResponse({ ok: true, auth: result.auth ?? null });
    });
    return true;
  }

  if (message?.type === "xlrrank:clear-auth") {
    chrome.storage.local.remove("auth", () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "xlrrank:detect-profile") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab" });
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: "xlrrank:extract-profile" }, (response) => {
        sendResponse(response ?? { ok: false, error: "No response from content script" });
      });
    });
    return true;
  }

  if (message?.type === "xlrrank:detect-content") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab" });
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: "xlrrank:extract-content" }, (response) => {
        sendResponse(response ?? { ok: false, error: "No response from content script" });
      });
    });
    return true;
  }
});

export {};
