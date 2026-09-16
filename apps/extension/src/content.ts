import {
  boundedText,
  detectPlatformFromUrl,
  MAX_BIO_TEXT_LENGTH,
  MAX_CONTENT_TEXT_LENGTH,
  MAX_PROFILE_TEXT_LENGTH,
  parseExtensionMessage,
} from "./security.js";

interface ProfileData {
  platform: string;
  handle: string;
  displayName: string;
  bio?: string;
  followerCount?: string;
  followingCount?: string;
  url: string;
}

interface ContentData {
  platform: string;
  authorHandle?: string;
  body: string;
  url: string;
  contentType: string;
}

const SELECTORS: Record<string, { profile: string[]; content: string[] }> = {
  "x.com": {
    profile: ['[data-testid="UserName"]', '[data-testid="UserDescription"]'],
    content: ['[data-testid="tweetText"]'],
  },
  "twitter.com": {
    profile: ['[data-testid="UserName"]', '[data-testid="UserDescription"]'],
    content: ['[data-testid="tweetText"]'],
  },
  "www.linkedin.com": {
    profile: [".text-heading-xlarge", ".pv-about-section"],
    content: [".feed-shared-update-v2__description"],
  },
  "www.instagram.com": {
    profile: ["header section", "._aa_c"],
    content: ["._aa_c"],
  },
  "www.reddit.com": {
    profile: ["shreddit-profile-banner", '[data-testid="profile-sidebar"]'],
    content: ['[data-testid="comment"]', ".md"],
  },
};

function detectPlatform(): string | null {
  return detectPlatformFromUrl(window.location.href);
}

function extractProfile(platform: string): ProfileData | null {
  const url = window.location.href;
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const handle = boundedText(pathParts[0], MAX_PROFILE_TEXT_LENGTH);

  if (!handle) return null;

  const nameEl = document.querySelector(SELECTORS[platform]?.profile[0] ?? "");
  const displayName = boundedText(nameEl?.textContent, MAX_PROFILE_TEXT_LENGTH) || handle;

  const bioEl = document.querySelector(SELECTORS[platform]?.profile[1] ?? "");
  const bio = boundedText(bioEl?.textContent, MAX_BIO_TEXT_LENGTH);

  return {
    platform,
    handle: handle.replace(/^@/, ""),
    displayName,
    ...(bio ? { bio } : {}),
    url,
  };
}

function extractContent(platform: string): ContentData | null {
  const contentEls = document.querySelectorAll(SELECTORS[platform]?.content[0] ?? "");
  if (contentEls.length === 0) return null;

  const firstContent = contentEls[0];
  const body = boundedText(firstContent?.textContent, MAX_CONTENT_TEXT_LENGTH);
  if (!body) return null;

  return {
    platform,
    body,
    url: window.location.href,
    contentType: "post",
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const parsed = parseExtensionMessage(message);
  if (!parsed) {
    sendResponse({ ok: false, error: "Unsupported extension message" });
    return;
  }

  if (parsed.type === "xlrrank:extract-profile") {
    const platform = detectPlatform();
    if (!platform) {
      sendResponse({ ok: false, error: "Not a supported social platform" });
      return;
    }
    const profile = extractProfile(platform);
    sendResponse({ ok: true, profile });
  }

  if (parsed.type === "xlrrank:extract-content") {
    const platform = detectPlatform();
    if (!platform) {
      sendResponse({ ok: false, error: "Not a supported social platform" });
      return;
    }
    const content = extractContent(platform);
    sendResponse({ ok: true, content });
  }
});
