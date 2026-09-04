import Link from 'next/link';

export default function RadarPage() {
  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Radar</h1>
        <p className="muted">Commercial intent, content gaps, and relationship opportunities surfaced when fresh.</p>
      </div>
      <div className="empty-state">
        <h2>Your radar is clear</h2>
        <p>
          As your network data grows, XLRrank will surface time-sensitive
          opportunities and signals that deserve your attention right now.
        </p>
        <Link href="/platforms" className="btn btn-primary">Connect a platform</Link>
      </div>
    </div>
  );
}
