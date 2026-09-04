'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';

interface MeResponse {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

const NAV_ITEMS = [
  { label: 'Dashboard', href: '/dashboard', icon: '⊞' },
  { label: 'Discover', href: '/discover', icon: '◎' },
  { label: 'Radar', href: '/radar', icon: '◉' },
  { label: 'Relationships', href: '/relationships', icon: '↔' },
  { label: 'Intelligence', href: '/intelligence', icon: '◈' },
  { label: 'Content', href: '/content', icon: '▦' },
  { label: 'Network', href: '/network', icon: '⬡' },
  { label: 'Search', href: '/search', icon: '⌕' },
  { label: 'Saved', href: '/saved', icon: '★' },
  { label: 'Platforms', href: '/platforms', icon: '⊕' },
  { label: 'AI Providers', href: '/ai-providers', icon: '⚡' },
  { label: 'Reports', href: '/reports', icon: '▤' },
  { label: 'Notifications', href: '/notifications', icon: '⊘' },
  { label: 'Settings', href: '/settings', icon: '⚙' },
  { label: 'Support', href: '/support', icon: '?' },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function checkAuth() {
      try {
        const res = await api.get<MeResponse>('/auth/me');
        if (cancelled) return;
        if (res.ok && res.data) {
          setUser(res.data);
        } else {
          router.replace('/signin');
        }
      } catch {
        if (!cancelled) router.replace('/signin');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    checkAuth();
    return () => { cancelled = true; };
  }, [router]);

  const handleSignOut = useCallback(async () => {
    try {
      await api.post('/auth/signout');
    } finally {
      router.replace('/signin');
    }
  }, [router]);

  if (loading) {
    return (
      <div className="app-loading">
        <div className="app-loading-spinner" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarCollapsed ? 'sidebar--collapsed' : ''}`}>
        <div className="sidebar-brand">
          <Link href="/dashboard">
            XLR<span className="brand-accent">rank</span>
          </Link>
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            aria-label="Toggle sidebar"
          >
            {sidebarCollapsed ? '»' : '«'}
          </button>
        </div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`sidebar-link ${pathname === item.href ? 'sidebar-link--active' : ''}`}
              title={item.label}
            >
              <span className="sidebar-link-icon">{item.icon}</span>
              {!sidebarCollapsed && <span className="sidebar-link-label">{item.label}</span>}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="topbar-left" />
          <div className="topbar-right">
            <span className="topbar-user">{user.displayName || user.email}</span>
            <button className="btn btn-secondary btn-sm" onClick={handleSignOut}>
              Sign out
            </button>
          </div>
        </header>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
