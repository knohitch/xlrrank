"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  emailVerified: boolean;
  roles: string[];
}

interface SessionItem {
  id: string;
  current: boolean;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
}

function getMessage(data: unknown, fallback: string) {
  return typeof data === "object" && data !== null && "message" in data
    ? String((data as { message: string }).message)
    : fallback;
}

export default function SettingsPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [profileMessage, setProfileMessage] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [deleteMessage, setDeleteMessage] = useState("");
  const [error, setError] = useState("");
  const [accountLoading, setAccountLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [deletePassword, setDeletePassword] = useState("");

  const loadAccount = useCallback(async () => {
    setAccountLoading(true);
    try {
      const [profileRes, sessionsRes] = await Promise.all([
        api.get<{ user: UserProfile }>("/users/me"),
        api.get<{ sessions: SessionItem[] }>("/auth/sessions"),
      ]);
      if (profileRes.ok && profileRes.data?.user) {
        setUser(profileRes.data.user);
        setDisplayName(profileRes.data.user.displayName || "");
        setAvatarUrl(profileRes.data.user.avatarUrl || "");
      }
      if (sessionsRes.ok && Array.isArray(sessionsRes.data?.sessions)) {
        setSessions(sessionsRes.data.sessions);
      }
    } finally {
      setAccountLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAccount().catch(() => setError("Unable to load account settings."));
  }, [loadAccount]);

  async function handleProfileSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setProfileMessage("");
    const body = {
      displayName,
      avatarUrl: avatarUrl.trim() ? avatarUrl.trim() : null,
    };
    try {
      const res = await api.patch<{ user: UserProfile }>("/users/me", body);
      if (res.ok && res.data?.user) {
        setUser(res.data.user);
        setDisplayName(res.data.user.displayName || "");
        setAvatarUrl(res.data.user.avatarUrl || "");
        setProfileMessage("Settings saved.");
      } else {
        setError(getMessage(res.data, "Failed to save settings."));
      }
    } catch {
      setError("Network error.");
    } finally {
      setSaving(false);
    }
  }

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setPasswordSaving(true);
    setError("");
    setPasswordMessage("");
    try {
      const res = await api.post("/auth/change-password", {
        currentPassword,
        newPassword,
      });
      if (res.ok) {
        setCurrentPassword("");
        setNewPassword("");
        setPasswordMessage("Password changed. Other sessions were revoked.");
        await loadAccount();
      } else {
        setError(getMessage(res.data, "Unable to change password."));
      }
    } catch {
      setError("Network error.");
    } finally {
      setPasswordSaving(false);
    }
  }

  async function revokeSession(id: string) {
    setError("");
    const res = await api.delete(`/auth/sessions/${id}`);
    if (res.ok) {
      setSessions((items) => items.filter((item) => item.id !== id));
    } else {
      setError(getMessage(res.data, "Unable to revoke session."));
    }
  }

  async function handleDeleteSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setDeleteMessage("");
    const res = await api.post("/auth/delete-account", { password: deletePassword });
    if (res.ok) {
      setDeleteMessage("Account deletion requested. You have been signed out.");
      router.replace("/signin");
    } else {
      setError(getMessage(res.data, "Unable to request account deletion."));
    }
  }

  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Settings</h1>
        <p className="muted">Manage your account, password, and sessions.</p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="settings-grid">
        <form className="settings-section" onSubmit={handleProfileSubmit}>
          <h2>Profile</h2>
          {profileMessage && <div className="alert alert-success">{profileMessage}</div>}
          <label className="form-label">
            Email
            <input type="email" className="form-input" value={user?.email || ""} disabled />
          </label>
          <label className="form-label">
            Display Name
            <input
              type="text"
              className="form-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={accountLoading}
              minLength={2}
              maxLength={100}
              required
            />
          </label>
          <label className="form-label">
            Avatar URL
            <input
              type="url"
              className="form-input"
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
              disabled={accountLoading}
              maxLength={500}
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={saving || accountLoading}>
            {saving ? "Saving..." : "Save changes"}
          </button>
        </form>

        <form className="settings-section" onSubmit={handlePasswordSubmit}>
          <h2>Password</h2>
          {passwordMessage && <div className="alert alert-success">{passwordMessage}</div>}
          <label className="form-label">
            Current password
            <input
              type="password"
              className="form-input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </label>
          <label className="form-label">
            New password
            <input
              type="password"
              className="form-input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={8}
              required
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={passwordSaving}>
            {passwordSaving ? "Changing..." : "Change password"}
          </button>
        </form>

        <section className="settings-section settings-section-wide">
          <h2>Sessions</h2>
          <div className="session-list">
            {sessions.map((session) => (
              <div className="session-row" key={session.id}>
                <div>
                  <strong>{session.current ? "Current session" : "Signed-in session"}</strong>
                  <span className="muted">
                    {(session.userAgent || "Unknown browser").slice(0, 120)}
                  </span>
                  <span className="muted">
                    Expires {new Date(session.expiresAt).toLocaleString()}
                  </span>
                </div>
                {!session.current && (
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={() => revokeSession(session.id)}
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <form className="settings-section" onSubmit={handleDeleteSubmit}>
          <h2>Delete account</h2>
          {deleteMessage && <div className="alert alert-info">{deleteMessage}</div>}
          <label className="form-label">
            Confirm password
            <input
              type="password"
              className="form-input"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              required
            />
          </label>
          <button className="btn btn-secondary" type="submit">
            Request deletion
          </button>
        </form>
      </div>
    </div>
  );
}
