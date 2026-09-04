'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface AdminStats {
  totalUsers: number;
  activeUsers: number;
  totalPlatforms: number;
  systemHealth: string;
}

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await api.get<AdminStats>('/admin/stats');
        if (res.ok) setStats(res.data);
      } catch {
        // Stats unavailable
      }
    }
    load();
  }, []);

  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Admin Dashboard</h1>
        <p className="muted">System overview and management.</p>
      </div>

      <div className="summary-grid">
        <div className="summary-card">
          <div className="summary-card-value">{stats?.totalUsers ?? '—'}</div>
          <div className="summary-card-label">Total Users</div>
        </div>
        <div className="summary-card">
          <div className="summary-card-value">{stats?.activeUsers ?? '—'}</div>
          <div className="summary-card-label">Active Users</div>
        </div>
        <div className="summary-card">
          <div className="summary-card-value">{stats?.totalPlatforms ?? '—'}</div>
          <div className="summary-card-label">Connected Platforms</div>
        </div>
        <div className="summary-card">
          <div className="summary-card-value">
            <span className="badge badge-green">{stats?.systemHealth ?? 'Unknown'}</span>
          </div>
          <div className="summary-card-label">System Health</div>
        </div>
      </div>
    </div>
  );
}
