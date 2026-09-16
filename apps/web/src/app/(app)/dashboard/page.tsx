'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';

interface DashboardData {
  user: { displayName: string; email: string } | null;
  network: {
    conversations: number;
    people: number;
    relationships: number;
    topics: number;
    opportunities: number;
    contentGaps: number;
  };
  platformCount: number;
}

interface PriorityAction {
  title: string;
  reason: string;
  evidence: string;
  action: string;
  href: string;
}

const EMPTY_STATE_ACTIONS: PriorityAction[] = [
  {
    title: 'Connect a social platform',
    reason: 'No live social connection is available yet',
    evidence: 'A connector must authenticate successfully before it is marked connected',
    action: 'Connect',
    href: '/platforms',
  },
  {
    title: 'Configure AI providers',
    reason: 'AI-backed intelligence requires a configured provider',
    evidence: 'Provider setup is not currently exposed by the user portal',
    action: 'Configure',
    href: '/ai-providers',
  },
];

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData>({
    user: null,
    network: { conversations: 0, people: 0, relationships: 0, topics: 0, opportunities: 0, contentGaps: 0 },
    platformCount: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<{ user: { displayName: string; email: string } }>('/auth/me').catch(() => ({ data: { user: null } })),
      api.get<{ platforms: Array<{ connected: boolean }> }>('/platforms').catch(() => ({ data: { platforms: [] } })),
    ]).then(([meRes, platformsRes]) => {
      const user = meRes.data?.user ?? null;
      const platforms = platformsRes.data?.platforms ?? [];
      const connectedCount = platforms.filter((p) => p.connected).length;
      setData({
        user,
        network: { conversations: 0, people: 0, relationships: 0, topics: 0, opportunities: 0, contentGaps: 0 },
        platformCount: connectedCount,
      });
    }).finally(() => setLoading(false));
  }, []);

  const summaryCards = [
    { label: 'Conversations Worth Joining', value: data.network.conversations, hint: 'No connected intelligence endpoint yet' },
    { label: 'People Worth Knowing', value: data.network.people, hint: 'No connected discovery endpoint yet' },
    { label: 'Relationships', value: data.network.relationships, hint: 'No connected relationship endpoint yet' },
    { label: 'Emerging Topics', value: data.network.topics, hint: 'No connected trend endpoint yet' },
    { label: 'Opportunities', value: data.network.opportunities, hint: 'No connected opportunity endpoint yet' },
    { label: 'Content Gaps', value: data.network.contentGaps, hint: 'No connected content-intelligence endpoint yet' },
  ];

  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>{loading ? 'Dashboard' : `Welcome${data.user ? `, ${data.user.displayName}` : ''}`}</h1>
        <p className="muted">Your Network Today</p>
      </div>

      <div className="summary-grid">
        {summaryCards.map((card) => (
          <div key={card.label} className="summary-card">
            <div className="summary-card-value">{card.value}</div>
            <div className="summary-card-label">{card.label}</div>
            <div className="summary-card-hint">{card.hint}</div>
          </div>
        ))}
      </div>

      <div className="section-heading">
        <h2>Setup Actions</h2>
        <p className="muted">Only actions supported by verified application state are shown here.</p>
      </div>

      <div className="action-list">
        {EMPTY_STATE_ACTIONS.map((action, i) => (
          <Link key={action.href} href={action.href} className="action-card">
            <div className="action-card-header">
              <span className="action-card-number">{i + 1}</span>
              <div>
                <div className="action-card-title">{action.title}</div>
                <div className="action-card-desc">{action.reason}</div>
              </div>
            </div>
            <div className="action-card-meta">
              <span className="muted">{action.evidence}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
