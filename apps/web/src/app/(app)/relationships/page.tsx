import Link from 'next/link';

export default function RelationshipsPage() {
  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Relationships</h1>
        <p className="muted">Relationship memory with strength, momentum, and configurable pipelines.</p>
      </div>
      <div className="empty-state">
        <h2>No relationships yet</h2>
        <p>
          As XLRrank tracks your network interactions, relationships will appear
          here with strength and momentum signals.
        </p>
        <Link href="/platforms" className="btn btn-primary">Connect a platform</Link>
      </div>
    </div>
  );
}
