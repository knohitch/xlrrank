'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';

export default function SearchPage() {
  const [query, setQuery] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // Search functionality to be implemented with API
  }

  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Search</h1>
        <p className="muted">Find people, content, and insights across your network.</p>
      </div>
      <form className="search-bar" onSubmit={handleSubmit}>
        <input
          type="text"
          className="search-input"
          placeholder="Search people, content, platforms…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn btn-primary" type="submit">Search</button>
      </form>
      <div className="empty-state">
        <h2>Start searching</h2>
        <p>
          Search across your connected platforms for people, content, and
          network intelligence insights.
        </p>
      </div>
    </div>
  );
}
