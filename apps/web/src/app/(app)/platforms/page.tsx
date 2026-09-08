"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface PlatformInfo {
  id: string;
  slug: string;
  displayName: string;
  enabled: boolean;
  connected: boolean;
  demo?: boolean;
  status: string;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  capabilities: Record<string, string>;
  connection: {
    id: string;
    status: string;
    verifiedHandle: string | null;
    displayName: string | null;
    nextSyncAt: string | null;
    diagnostics: {
      rateLimitRemaining: number | null;
      rateLimitResetAt: string | null;
      retryAfterSeconds: number | null;
    };
  } | null;
}

export default function PlatformsPage() {
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncJobs, setSyncJobs] = useState<Record<string, string>>({});

  useEffect(() => {
    api
      .get<{ platforms: PlatformInfo[] }>("/platforms")
      .then((res) => {
        if (!res.ok) {
          setError("Unable to load platform configuration.");
          return;
        }
        setPlatforms(res.data.platforms ?? []);
      })
      .catch(() => setError("Unable to reach the API."))
      .finally(() => setLoading(false));
  }, []);

  async function requestSync(platform: PlatformInfo) {
    if (!platform.connection) return;
    setSyncJobs((current) => ({ ...current, [platform.id]: "Queued" }));
    const res = await api.post<{ jobId: string; status: string; jobStatus: string }>(
      `/platforms/connections/${platform.connection.id}/sync`,
      {},
    );
    if (!res.ok) {
      setSyncJobs((current) => ({ ...current, [platform.id]: "Failed" }));
      return;
    }
    setSyncJobs((current) => ({ ...current, [platform.id]: res.data.jobStatus }));
    const jobId = res.data.jobId;
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const status = await api.get<{ job: { status: string } }>(`/platforms/sync-jobs/${jobId}`);
      if (!status.ok) break;
      setSyncJobs((current) => ({ ...current, [platform.id]: status.data.job.status }));
      if (["COMPLETED", "FAILED", "DEAD_LETTERED", "CANCELLED"].includes(status.data.job.status)) {
        break;
      }
    }
  }

  async function startOAuth(platform: PlatformInfo) {
    setError("");
    const res = await api.post<{ authorizationUrl: string }>(
      `/platforms/${platform.slug}/oauth/start`,
      {
        scopeType: "PERSONAL",
        redirectTo: "/platforms",
      },
    );
    if (!res.ok || !res.data.authorizationUrl) {
      setError("Unable to start OAuth authorization for this platform.");
      return;
    }
    window.location.assign(res.data.authorizationUrl);
  }

  function capabilitySummary(platform: PlatformInfo): string {
    const enabled = Object.entries(platform.capabilities)
      .filter(([, state]) => state === "AVAILABLE")
      .map(([name]) => friendlyCapability(name));
    if (enabled.length > 0) return enabled.join(" · ");
    return Object.entries(platform.capabilities)
      .map(([name, state]) => `${friendlyCapability(name)}: ${state}`)
      .join(" · ");
  }

  function connectionLabel(platform: PlatformInfo): string {
    if (!platform.connection) return "";
    const handle = platform.connection.verifiedHandle
      ? `@${platform.connection.verifiedHandle}`
      : "Verified account";
    return platform.connection.displayName
      ? `${platform.connection.displayName} (${handle})`
      : handle;
  }

  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Social Platforms</h1>
        <p className="muted">
          A platform is marked connected only after its adapter verifies live authentication.
        </p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="empty-state">
          <p className="muted">Loading platforms...</p>
        </div>
      ) : platforms.length === 0 ? (
        <div className="empty-state">
          <h2>No platforms available</h2>
          <p>Platform configuration will appear here once the system is initialized.</p>
        </div>
      ) : (
        <div className="card-grid">
          {platforms.map((p) => (
            <div key={p.id} className="card">
              <div className="card-header">
                <h3>{p.displayName}</h3>
                <span className={`badge ${p.connected ? "badge-success" : "badge-warning"}`}>
                  {p.demo ? "DEMO" : p.connected ? p.status : p.status}
                </span>
              </div>
              <p className="muted">
                {capabilitySummary(p) || "No connector capabilities declared"}
              </p>
              {p.connection && <p className="muted">{connectionLabel(p)}</p>}
              {p.lastSyncAt && (
                <p className="muted">Last sync: {new Date(p.lastSyncAt).toLocaleString()}</p>
              )}
              {(p.connection?.nextSyncAt ?? p.nextSyncAt) && (
                <p className="muted">
                  Next sync: {new Date(p.connection?.nextSyncAt ?? p.nextSyncAt!).toLocaleString()}
                </p>
              )}
              {p.connection?.diagnostics.rateLimitResetAt && (
                <p className="muted">
                  Rate limit resets:{" "}
                  {new Date(p.connection.diagnostics.rateLimitResetAt).toLocaleString()}
                </p>
              )}
              {syncJobs[p.id] && <p className="muted">Sync state: {syncJobs[p.id]}</p>}
              <div className="card-actions">
                {p.slug === "x" && !p.connected && (
                  <button className="btn btn-primary btn-sm" onClick={() => startOAuth(p)}>
                    {p.status === "REAUTH_REQUIRED" ? "Reconnect X" : "Connect X"}
                  </button>
                )}
                {p.connected && (
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={!p.connection}
                    onClick={() => requestSync(p)}
                  >
                    Sync
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function friendlyCapability(name: string): string {
  const labels: Record<string, string> = {
    profiles: "Profiles",
    content: "Posts",
    comments: "Replies",
    search: "Recent search",
    metrics: "Metrics",
    followers: "Followers",
    following: "Following",
  };
  return labels[name] ?? name;
}
