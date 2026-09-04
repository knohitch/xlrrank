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
  confidence: number;
  evidence: string;
  action: string;
  href: string;
}

const EMPTY_STATE_ACTIONS: PriorityAction[] = [
  {
    title: 'Connect a social platform',
    reason: 'No platforms connected yet',
    confidence: 100,
    evidence: '0 platforms detected',
    action: 'Connect',
    href: '/platforms',
  },
  {
    title: 'Configure AI providers',
    reason: 'Intelligence engines need AI models',
    confidence: 100,
    evidence: 'No AI providers configured',
    action: 'Configure',
    href: '/ai-providers',
  },
  {
    title: 'Explore Discover',
    reason: 'Find people worth knowing with explainable scoring',
    confidence: 80,
    evidence: 'Discovery engine ready',
    action: 'Discover',
    href: '/discover',
  },
  {
    title: 'Check your Radar',
    reason: 'Surface commercial intent and content gaps',
    confidence: 75,
    evidence: 'Opportunity detectors active',
    action: 'View Radar',
    href: '/radar',
  },
  {
    title: 'Review Relationships',
    reason: 'Track relationship strength and momentum',
    confidence: 70,
    evidence: 'Relationship engine ready',
    action: 'View Relationships',
    href: '/relationships',
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
      api.get<{ user: { displayName: string; email: string } }>('/api/auth/me').catch(() => ({ data: { user: null } })),
      api.get<{ platforms: Array<{ connected: boolean }> }>('/api/platforms').catch(() => ({ data: { platforms: [] } })),
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
    { label: 'Conversations Worth Joining', value: data.network.conversations, hint: data.platformCount > 0 ? 'Will populate as data syncs' : 'Connect platforms first' },
    { label: 'People Worth Knowing', value: data.network.people, hint: data.platformCount > 0 ? 'Discovery engine active' : 'Connect platforms to discover' },
    { label: 'Relationships', value: data.network.relationships, hint: data.platformCount > 0 ? 'Tracking relationship health' : 'No interactions yet' },
    { label: 'Emerging Topics', value: data.network.topics, hint: data.platformCount > 0 ? 'Trend detection active' : 'Topics will appear with data' },
    { label: 'Opportunities', value: data.network.opportunities, hint: data.platformCount > 0 ? 'Radar scanning' : 'Connect to activate radar' },
    { label: 'Content Gaps', value: data.network.contentGaps, hint: data.platformCount > 0 ? 'Content analysis ready' : 'Analyze content to find gaps' },
  ];

  const actions = EMPTY_STATE_ACTIONS;

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
        <h2>Priority Actions</h2>
        <p className="muted">Recommended actions ranked by relevance and confidence.</p>
      </div>

      <div className="action-list">
        {actions.map((action, i) => (
          <Link key={action.href} href={action.href} className="action-card">
            <div className="action-card-header">
              <span className="action-card-number">{i + 1}</span>
              <div>
                <div className="action-card-title">{action.title}</div>
                <div className="action-card-desc">{action.reason}</div>
              </div>
            </div>
            <div className="action-card-meta">
              <span className="badge badge-success">{action.confidence}% confidence</span>
              <span className="muted">{action.evidence}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
