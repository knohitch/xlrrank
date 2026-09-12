const statusBadge = document.getElementById("status-badge");
const content = document.getElementById("content");
const profileSection = document.getElementById("profile-section");
const actionsSection = document.getElementById("actions-section");
const WEB_APP_URL = "https://app.xlrrank.com/dashboard";

function setStatus(text: string, kind: "muted" | "ok" | "err") {
  if (!statusBadge) return;
  statusBadge.textContent = text;
  statusBadge.className = `badge badge-${kind}`;
}

function showProfilePanel(profile: {
  platform: string;
  handle: string;
  displayName: string;
  bio?: string;
}) {
  if (!profileSection) return;
  const panel = document.createElement("div");
  panel.className = "profile-panel";
  const header = document.createElement("div");
  header.className = "profile-header";
  const displayName = document.createElement("strong");
  displayName.textContent = profile.displayName;
  const meta = document.createElement("span");
  meta.className = "muted";
  meta.textContent = `@${profile.handle} on ${profile.platform}`;
  header.append(displayName, meta);
  panel.append(header);
  if (profile.bio) {
    const bio = document.createElement("p");
    bio.className = "profile-bio";
    bio.textContent = profile.bio;
    panel.append(bio);
  }
  const stats = document.createElement("div");
  stats.className = "profile-stats";
  const badge = document.createElement("span");
  badge.className = "badge badge-muted";
  badge.textContent = "Intelligence: Loading...";
  stats.append(badge);
  panel.append(stats);
  profileSection.replaceChildren(panel);
  profileSection.style.display = "block";
}

function showActions() {
  if (!actionsSection) return;
  const grid = document.createElement("div");
  grid.className = "actions-grid";
  const saveButton = document.createElement("button");
  saveButton.className = "action-btn";
  saveButton.disabled = true;
  saveButton.textContent = "Save";
  const analyzeButton = document.createElement("button");
  analyzeButton.className = "action-btn";
  analyzeButton.disabled = true;
  analyzeButton.textContent = "Analyze";
  const openButton = document.createElement("button");
  openButton.className = "action-btn";
  openButton.textContent = "Open in XLRrank";
  openButton.addEventListener("click", () => {
    chrome.tabs.create({ url: WEB_APP_URL });
  });
  grid.append(saveButton, analyzeButton, openButton);
  actionsSection.replaceChildren(grid);
  actionsSection.style.display = "block";
}

function showMessage(text: string) {
  if (!content) return;
  const paragraph = document.createElement("p");
  paragraph.className = "muted";
  paragraph.textContent = text;
  content.replaceChildren(paragraph);
}

async function main() {
  try {
    const pingResponse = await chrome.runtime.sendMessage({ type: "xlrrank:ping" });
    void pingResponse;

    setStatus("Ready", "ok");
    showMessage("Browsing a supported social site? XLRrank will show intelligence here.");
    const profileResponse = await chrome.runtime.sendMessage({ type: "xlrrank:detect-profile" });
    if (profileResponse?.ok && profileResponse.profile) {
      showProfilePanel(profileResponse.profile);
      showActions();
    }
  } catch {
    setStatus("error", "err");
    showMessage("Unable to reach the XLRrank extension service.");
  }
}

main();
