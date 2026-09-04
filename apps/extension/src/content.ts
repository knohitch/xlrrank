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
    profile: ['.text-heading-xlarge', '.pv-about-section'],
    content: ['.feed-shared-update-v2__description'],
  },
  "www.instagram.com": {
    profile: ['header section', '._aa_c'],
    content: ['._aa_c'],
  },
  "www.reddit.com": {
    profile: ['shreddit-profile-banner', '[data-testid="profile-sidebar"]'],
    content: ['[data-testid="comment"]', '.md'],
  },
};

function detectPlatform(): string | null {
  const host = window.location.hostname;
  for (const [platform] of Object.entries(SELECTORS)) {
    if (host.includes(platform) || host === platform) return platform;
  }
  return null;
}

function extractProfile(platform: string): ProfileData | null {
  const url = window.location.href;
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const handle = pathParts[0] ?? "";

  if (!handle) return null;

  const nameEl = document.querySelector(SELECTORS[platform]?.profile[0] ?? "");
  const displayName = nameEl?.textContent?.trim() ?? handle;

  const bioEl = document.querySelector(SELECTORS[platform]?.profile[1] ?? "");
  const bio = bioEl?.textContent?.trim();

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
  const body = firstContent?.textContent?.trim() ?? "";
  if (!body) return null;

  return {
    platform,
    body: body.slice(0, 2000),
    url: window.location.href,
    contentType: "post",
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "xlrrank:extract-profile") {
    const platform = detectPlatform();
    if (!platform) {
      sendResponse({ ok: false, error: "Not a supported social platform" });
      return;
    }
    const profile = extractProfile(platform);
    sendResponse({ ok: true, profile });
  }

  if (message?.type === "xlrrank:extract-content") {
    const platform = detectPlatform();
    if (!platform) {
      sendResponse({ ok: false, error: "Not a supported social platform" });
      return;
    }
    const content = extractContent(platform);
    sendResponse({ ok: true, content });
  }
});
