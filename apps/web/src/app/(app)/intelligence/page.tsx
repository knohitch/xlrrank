import Link from 'next/link';

export default function IntelligencePage() {
  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Intelligence</h1>
        <p className="muted">Cross-platform Social DNA built from observed behavior, not invention.</p>
      </div>
      <div className="empty-state">
        <h2>No intelligence data yet</h2>
        <p>
          Connect platforms and XLRrank will build deterministic Social DNA
          profiles from real behavior patterns — no fabrication, ever.
        </p>
        <Link href="/platforms" className="btn btn-primary">Connect a platform</Link>
      </div>
    </div>
  );
}
