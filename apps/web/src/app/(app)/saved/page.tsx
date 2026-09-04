export default function SavedPage() {
  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Saved</h1>
        <p className="muted">Your bookmarked people, searches, and reports.</p>
      </div>
      <div className="empty-state">
        <h2>Nothing saved yet</h2>
        <p>
          Bookmark people, searches, and reports to quickly access them later.
          Your saved items will appear here.
        </p>
      </div>
    </div>
  );
}
