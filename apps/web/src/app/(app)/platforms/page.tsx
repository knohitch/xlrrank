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
  capabilities: Record<string, string>;
}

export default function PlatformsPage() {
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Social Platforms</h1>
        <p className="muted">A platform is marked connected only after its adapter verifies live authentication.</p>
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
                <span
                  className={`badge ${p.connected ? "badge-success" : "badge-warning"}`}
                >
                  {p.demo ? "DEMO" : p.connected ? p.status : p.status}
                </span>
              </div>
              <p className="muted">
                {Object.entries(p.capabilities).map(([name, state]) => `${name}: ${state}`).join(" · ") || "No connector capabilities declared"}
              </p>
              {p.lastSyncAt && (
                <p className="muted">
                  Last sync: {new Date(p.lastSyncAt).toLocaleString()}
                </p>
              )}
              <div className="card-actions">
                <button className="btn btn-secondary btn-sm" disabled>
                  {p.connected ? "Disconnect unavailable in current UI" : "Live connection unavailable in current UI"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
