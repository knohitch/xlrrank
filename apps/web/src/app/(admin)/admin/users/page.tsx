'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';

interface User {
  id: string;
  email: string;
  displayName: string;
  role: string;
  emailVerified: boolean;
  createdAt: string;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<User[]>('/admin/users');
      if (res.ok && Array.isArray(res.data)) {
        setUsers(res.data);
      }
    } catch {
      // Failed to load
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>User Management</h1>
        <p className="muted">View and manage registered users.</p>
      </div>

      {loading ? (
        <div className="empty-state"><p>Loading users…</p></div>
      ) : users.length === 0 ? (
        <div className="empty-state">
          <h2>No users found</h2>
          <p>Users will appear here once they register.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Display Name</th>
                <th>Role</th>
                <th>Verified</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.displayName || '—'}</td>
                  <td>
                    <span className={`badge ${u.role === 'admin' ? 'badge-accent' : 'badge-muted'}`}>
                      {u.role}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${u.emailVerified ? 'badge-green' : 'badge-red'}`}>
                      {u.emailVerified ? 'Yes' : 'No'}
                    </span>
                  </td>
                  <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
