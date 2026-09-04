import Link from "next/link";

export default function Home() {
  return (
    <div className="landing">
      <section className="hero">
        <h1>Know your network before you need it.</h1>
        <p className="tagline">
          XLRrank is a platform-agnostic social, audience, relationship, content,
          and network intelligence platform. Understand who matters, why they
          matter, and what deserves your attention today.
        </p>
        <div className="hero-actions">
          <Link href="/signup" className="btn btn-primary">
            Get Started
          </Link>
          <Link href="/signin" className="btn btn-secondary">
            Sign In
          </Link>
        </div>
      </section>

      <section className="status-row">
        <div className="status-card">
          <div className="status-indicator ok"></div>
          <div>
            <strong>Platform status</strong>
            <span className="muted">Foundation online</span>
          </div>
        </div>
      </section>

      <section className="feature-grid">
        <article className="feature-card">
          <h2>Discover</h2>
          <p>People worth knowing, scored deterministically with explainable evidence.</p>
        </article>
        <article className="feature-card">
          <h2>Radar</h2>
          <p>Commercial intent, content gaps, and relationship opportunities surfaced when fresh.</p>
        </article>
        <article className="feature-card">
          <h2>Relationships</h2>
          <p>Relationship memory with strength, momentum, and configurable pipelines.</p>
        </article>
        <article className="feature-card">
          <h2>Intelligence</h2>
          <p>Cross-platform Social DNA built from observed behavior, not invention.</p>
        </article>
      </section>
    </div>
  );
}
