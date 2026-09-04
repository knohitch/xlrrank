import Link from 'next/link';

export default function DiscoverPage() {
  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Discover</h1>
        <p className="muted">People worth knowing — powered by deterministic, explainable scoring.</p>
      </div>
      <div className="empty-state">
        <h2>No people discovered yet</h2>
        <p>
          Connect a social platform and XLRrank will begin building Social DNA
          and surfacing relevant people based on your network signals.
        </p>
        <Link href="/platforms" className="btn btn-primary">Connect a platform</Link>
      </div>
    </div>
  );
}
