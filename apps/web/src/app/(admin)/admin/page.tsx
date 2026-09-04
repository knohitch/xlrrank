'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface AdminStats {
  totalUsers: number;
  activeUsers: number;
  generatedAt: string;
}

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const res = await api.get<AdminStats>('/admin/dashboard');
        if (res.ok) setStats(res.data);
        else setError('Admin dashboard data is unavailable.');
      } catch {
        setError('Admin dashboard data is unavailable.');
      }
    }
    load();
  }, []);

  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Admin Dashboard</h1>
        <p className="muted">System overview backed by the admin API.</p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="summary-grid">
        <div className="summary-card">
          <div className="summary-card-value">{stats?.totalUsers ?? '—'}</div>
          <div className="summary-card-label">Total Users</div>
        </div>
        <div className="summary-card">
          <div className="summary-card-value">{stats?.activeUsers ?? '—'}</div>
          <div className="summary-card-label">Active Users</div>
        </div>
      </div>

      <div className="section-heading">
        <h2>Operational coverage</h2>
        <p className="muted">
          Provider health, model registry, jobs, feature flags, billing and system-health management are not exposed by the current admin API and are not represented as live status here.
        </p>
      </div>
    </div>
  );
}
