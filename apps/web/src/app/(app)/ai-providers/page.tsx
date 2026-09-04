export default function AiProvidersPage() {
  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>AI Providers</h1>
        <p className="muted">Configure AI models for intelligence analysis and content generation.</p>
      </div>
      <div className="empty-state">
        <h2>No AI providers configured</h2>
        <p>
          Add your API keys for supported AI providers to enable advanced
          analysis, content generation, and intelligence features.
        </p>
        <button className="btn btn-primary" disabled>Add provider (coming soon)</button>
      </div>
    </div>
  );
}
