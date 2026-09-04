import Link from 'next/link';

export default function ContentPage() {
  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Content</h1>
        <p className="muted">Content analysis, performance tracking, and generation tools.</p>
      </div>
      <div className="empty-state">
        <h2>No content analyzed yet</h2>
        <p>
          Connect your platforms to analyze content performance, identify gaps,
          and get AI-assisted content suggestions.
        </p>
        <Link href="/platforms" className="btn btn-primary">Connect a platform</Link>
      </div>
    </div>
  );
}
