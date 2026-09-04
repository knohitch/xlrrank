export default function ReportsPage() {
  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Reports</h1>
        <p className="muted">Generated intelligence reports and analytics.</p>
      </div>
      <div className="empty-state">
        <h2>No reports generated</h2>
        <p>
          Reports will be generated as your network data grows. Get insights
          on relationship health, content performance, and network growth.
        </p>
      </div>
    </div>
  );
}
