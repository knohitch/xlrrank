export default function SupportPage() {
  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Support</h1>
        <p className="muted">Get help with XLRrank.</p>
      </div>
      <div className="support-grid">
        <div className="support-card">
          <h3>Documentation</h3>
          <p className="muted">Browse guides and tutorials to get the most out of XLRrank.</p>
          <span className="badge badge-muted">Coming soon</span>
        </div>
        <div className="support-card">
          <h3>Contact Support</h3>
          <p className="muted">Reach out to our team for personalized assistance.</p>
          <span className="badge badge-muted">Coming soon</span>
        </div>
        <div className="support-card">
          <h3>Feature Requests</h3>
          <p className="muted">Suggest new features and vote on existing requests.</p>
          <span className="badge badge-muted">Coming soon</span>
        </div>
        <div className="support-card">
          <h3>Status</h3>
          <p className="muted">Check the current system status and uptime.</p>
          <span className="badge badge-green">All systems operational</span>
        </div>
      </div>
    </div>
  );
}
