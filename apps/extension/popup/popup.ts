const statusBadge = document.getElementById("status-badge");
const content = document.getElementById("content");
const profileSection = document.getElementById("profile-section");
const actionsSection = document.getElementById("actions-section");

function setStatus(text: string, kind: "muted" | "ok" | "err") {
  if (!statusBadge) return;
  statusBadge.textContent = text;
  statusBadge.className = `badge badge-${kind}`;
}

function showProfilePanel(profile: { platform: string; handle: string; displayName: string; bio?: string }) {
  if (!profileSection) return;
  profileSection.innerHTML = `
    <div class="profile-panel">
      <div class="profile-header">
        <strong>${profile.displayName}</strong>
        <span class="muted">@${profile.handle} on ${profile.platform}</span>
      </div>
      ${profile.bio ? `<p class="profile-bio">${profile.bio}</p>` : ''}
      <div class="profile-stats">
        <span class="badge badge-muted">Intelligence: Loading...</span>
      </div>
    </div>
  `;
  profileSection.style.display = "block";
}

function showActions() {
  if (!actionsSection) return;
  actionsSection.innerHTML = `
    <div class="actions-grid">
      <button class="action-btn" id="btn-save" disabled>Save</button>
      <button class="action-btn" id="btn-analyze" disabled>Analyze</button>
      <button class="action-btn" id="btn-open-web">Open in XLRrank</button>
    </div>
  `;
  actionsSection.style.display = "block";

  const openBtn = document.getElementById("btn-open-web");
  if (openBtn) {
    openBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: "http://localhost:3000/dashboard" });
    });
  }
}

async function main() {
  try {
    const pingResponse = await chrome.runtime.sendMessage({ type: "xlrrank:ping" });
    void pingResponse;

    const apiResponse = await chrome.runtime.sendMessage({ type: "xlrrank:api-status" });

    if (apiResponse?.ok) {
      setStatus("API online", "ok");
      if (content) {
        content.innerHTML = `
          <p class="muted">Browsing a supported social site? XLRrank will show intelligence here.</p>
        `;
      }

      const profileResponse = await chrome.runtime.sendMessage({ type: "xlrrank:detect-profile" });
      if (profileResponse?.ok && profileResponse.profile) {
        showProfilePanel(profileResponse.profile);
        showActions();
      }
    } else {
      setStatus("API offline", "err");
      if (content) {
        content.innerHTML = `
          <p class="muted">Start the XLRrank API server to enable extension features.</p>
          <p class="muted" style="margin-top:8px">Run: <code>pnpm dev</code> in the xlrrank directory.</p>
        `;
      }
    }
  } catch {
    setStatus("error", "err");
    if (content) {
      content.innerHTML = `
        <p class="muted">Unable to reach the XLRrank extension service.</p>
      `;
    }
  }
}

main();
