'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';

interface User {
  id: string;
  email: string;
  displayName: string;
  status: string;
  roles: string[];
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

interface UsersResponse {
  items: User[];
  total: number;
  page: number;
  pageSize: number;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<UsersResponse>('/admin/users?page=1&pageSize=100');
      if (res.ok && Array.isArray(res.data?.items)) {
        setUsers(res.data.items);
        setTotal(res.data.total ?? res.data.items.length);
      } else {
        setError('Unable to load users.');
      }
    } catch {
      setError('Unable to load users.');
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
        <p className="muted">{total} registered user{total === 1 ? '' : 's'}.</p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

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
                <th>Roles</th>
                <th>Status</th>
                <th>Verified</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.displayName || '—'}</td>
                  <td>{u.roles.join(', ') || '—'}</td>
                  <td><span className="badge badge-muted">{u.status}</span></td>
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
