import {
  isSupportedSocialUrl,
  isTrustedExtensionSender,
  parseExtensionMessage,
} from "./security.js";

chrome.runtime.onInstalled.addListener(() => {
  console.log("XLRrank extension installed");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedExtensionSender(sender, chrome.runtime.id)) {
    sendResponse({ ok: false, error: "Untrusted extension sender" });
    return;
  }

  const parsed = parseExtensionMessage(message);
  if (!parsed) {
    sendResponse({ ok: false, error: "Unsupported extension message" });
    return;
  }

  if (parsed.type === "xlrrank:ping") {
    sendResponse({ ok: true, app: "XLRrank extension", version: "0.1.0" });
    return;
  }

  if (parsed.type === "xlrrank:api-status" || parsed.type === "xlrrank:clear-auth") {
    sendResponse({ ok: false, error: "Extension API sessions are not enabled" });
    return;
  }

  if (parsed.type === "xlrrank:detect-profile") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab" });
        return;
      }
      if (!isSupportedSocialUrl(tab.url)) {
        sendResponse({ ok: false, error: "Unsupported tab URL" });
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: "xlrrank:extract-profile" }, (response) => {
        sendResponse(response ?? { ok: false, error: "No response from content script" });
      });
    });
    return true;
  }

  if (parsed.type === "xlrrank:detect-content") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab" });
        return;
      }
      if (!isSupportedSocialUrl(tab.url)) {
        sendResponse({ ok: false, error: "Unsupported tab URL" });
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
