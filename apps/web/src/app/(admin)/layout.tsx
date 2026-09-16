'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';

interface MeResponse {
  user: {
    userId: string;
    email: string;
    roles: string[];
    status: string;
  };
}

const ADMIN_NAV = [
  { label: 'Admin Dashboard', href: '/admin', icon: '⊞' },
  { label: 'Users', href: '/admin/users', icon: '⊙' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<MeResponse['user'] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function checkAuth() {
      try {
        const res = await api.get<MeResponse>('/auth/me');
        if (cancelled) return;
        if (res.ok && res.data?.user) {
          const roles = res.data.user.roles ?? [];
          if (!roles.some((role) => role === 'ADMIN' || role === 'SUPER_ADMIN')) {
            router.replace('/dashboard');
            return;
          }
          setUser(res.data.user);
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
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Link href="/admin">
            XLR<span className="brand-accent">rank</span> <span className="badge badge-muted">Admin</span>
          </Link>
        </div>
        <nav className="sidebar-nav">
          {ADMIN_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`sidebar-link ${pathname === item.href ? 'sidebar-link--active' : ''}`}
            >
              <span className="sidebar-link-icon">{item.icon}</span>
              <span className="sidebar-link-label">{item.label}</span>
            </Link>
          ))}
          <div className="sidebar-divider" />
          <Link href="/dashboard" className="sidebar-link">
            <span className="sidebar-link-icon">←</span>
            <span className="sidebar-link-label">Back to App</span>
          </Link>
        </nav>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="topbar-left">
            <span className="topbar-title">Admin Panel</span>
          </div>
          <div className="topbar-right">
            <span className="topbar-user">{user.email}</span>
          </div>
        </header>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
