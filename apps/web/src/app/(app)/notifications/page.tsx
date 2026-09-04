export default function NotificationsPage() {
  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Notifications</h1>
        <p className="muted">Alerts, radar signals, and system notifications.</p>
      </div>
      <div className="empty-state">
        <h2>No notifications</h2>
        <p>
          You&apos;re all caught up. Radar alerts, relationship updates, and
          system notifications will appear here.
        </p>
      </div>
    </div>
  );
}
