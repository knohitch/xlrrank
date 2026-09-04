'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface UserProfile {
  id: string;
  email: string;
  displayName: string;
}

export default function SettingsPage() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    async function load() {
      const res = await api.get<UserProfile>('/auth/me');
      if (res.ok && res.data) {
        setUser(res.data);
        setDisplayName(res.data.displayName || '');
      }
    }
    load();
  }, []);

  async function handleSave() {
    setSaving(true);
    setMessage('');
    try {
      const res = await api.patch('/auth/me', { displayName });
      if (res.ok) {
        setMessage('Settings saved.');
      } else {
        setMessage('Failed to save settings.');
      }
    } catch {
      setMessage('Network error.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Settings</h1>
        <p className="muted">Manage your account and preferences.</p>
      </div>

      <div className="settings-section">
        <h2>Profile</h2>
        {message && <div className="alert alert-info">{message}</div>}
        <div className="form-group">
          <label className="form-label">
            Email
            <input
              type="email"
              className="form-input"
              value={user?.email || ''}
              disabled
            />
          </label>
        </div>
        <div className="form-group">
          <label className="form-label">
            Display Name
            <input
              type="text"
              className="form-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
        </div>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
