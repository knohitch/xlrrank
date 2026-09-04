import Link from 'next/link';

export default function NetworkPage() {
  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Network</h1>
        <p className="muted">Visualize and analyze your network graph structure.</p>
      </div>
      <div className="empty-state">
        <h2>Your network is empty</h2>
        <p>
          Once you connect platforms, XLRrank will map your network connections
          and reveal clusters, bridges, and influence patterns.
        </p>
        <Link href="/platforms" className="btn btn-primary">Connect a platform</Link>
      </div>
    </div>
  );
}
