"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface PlatformInfo {
  id: string;
  slug: string;
  displayName: string;
  enabled: boolean;
  connected: boolean;
  status: string;
  lastSyncAt: string | null;
  capabilities: Record<string, string>;
}

export default function PlatformsPage() {
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ platforms: PlatformInfo[] }>("/api/platforms")
      .then((res) => setPlatforms(res.data.platforms))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Social Platforms</h1>
        <p className="muted">Connect supported platforms to begin synchronization.</p>
      </div>

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
                <span
                  className={`badge ${p.connected ? "badge-success" : "badge-warning"}`}
                >
                  {p.connected ? p.status : "Disconnected"}
                </span>
              </div>
              <p className="muted">
                {Object.keys(p.capabilities).length} capabilities available
              </p>
              {p.lastSyncAt && (
                <p className="muted">
                  Last sync: {new Date(p.lastSyncAt).toLocaleString()}
                </p>
              )}
              <div className="card-actions">
                {p.connected ? (
                  <button className="btn btn-secondary btn-sm" disabled>
                    Disconnect
                  </button>
                ) : (
                  <button className="btn btn-primary btn-sm" disabled>
                    Connect
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
