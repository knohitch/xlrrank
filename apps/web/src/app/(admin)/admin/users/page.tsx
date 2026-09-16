"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";

const STATUSES = ["ACTIVE", "PENDING_VERIFICATION", "SUSPENDED", "DISABLED", "DELETION_PENDING"];
const ROLE_ORDER = ["USER", "SUPPORT", "ADMIN", "SUPER_ADMIN"];

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

interface RolesResponse {
  roles: { name: string; description: string | null }[];
}

interface MeResponse {
  user: {
    roles: string[];
  };
}

function getMessage(data: unknown, fallback: string) {
  return typeof data === "object" && data !== null && "message" in data
    ? String((data as { message: string }).message)
    : fallback;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<string[]>(ROLE_ORDER);
  const [myRoles, setMyRoles] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const canManageRoles = useMemo(() => myRoles.includes("SUPER_ADMIN"), [myRoles]);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });
    if (search.trim()) params.set("search", search.trim());
    if (status) params.set("status", status);
    try {
      const res = await api.get<UsersResponse>(`/admin/users?${params.toString()}`);
      if (res.ok && Array.isArray(res.data?.items)) {
        setUsers(res.data.items);
        setTotal(res.data.total ?? res.data.items.length);
      } else {
        setError(getMessage(res.data, "Unable to load users."));
      }
    } catch {
      setError("Unable to load users.");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search, status]);

  useEffect(() => {
    async function loadMetadata() {
      const [rolesRes, meRes] = await Promise.all([
        api.get<RolesResponse>("/admin/roles"),
        api.get<MeResponse>("/auth/me"),
      ]);
      if (rolesRes.ok && Array.isArray(rolesRes.data?.roles)) {
        const names = rolesRes.data.roles.map((item) => item.name);
        setRoles(ROLE_ORDER.filter((role) => names.includes(role)));
      }
      if (meRes.ok && Array.isArray(meRes.data?.user?.roles)) {
        setMyRoles(meRes.data.user.roles);
      }
    }
    loadMetadata().catch(() => setError("Unable to load admin metadata."));
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  function submitFilters() {
    setPage(1);
    loadUsers();
  }

  async function updateStatus(user: User, nextStatus: string) {
    setError("");
    setMessage("");
    const res = await api.patch(`/admin/users/${user.id}/status`, { status: nextStatus });
    if (res.ok) {
      setMessage(`Status updated for ${user.email}.`);
      await loadUsers();
    } else {
      setError(getMessage(res.data, "Unable to update status."));
    }
  }

  async function updateRoles(user: User, nextRoles: string[]) {
    setError("");
    setMessage("");
    const res = await api.put<{ roles: string[] }>(`/admin/users/${user.id}/roles`, {
      roles: nextRoles,
    });
    if (res.ok) {
      setMessage(`Roles updated for ${user.email}.`);
      await loadUsers();
    } else {
      setError(getMessage(res.data, "Unable to update roles."));
    }
  }

  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>User Management</h1>
        <p className="muted">
          {total} registered user{total === 1 ? "" : "s"}.
        </p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {message && <div className="alert alert-success">{message}</div>}

      <div className="admin-toolbar">
        <label className="form-label">
          Search
          <input
            className="form-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Email or display name"
          />
        </label>
        <label className="form-label">
          Status
          <select className="form-input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="form-label">
          Page size
          <select
            className="form-input"
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
          >
            {[10, 20, 50, 100].map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary toolbar-button" type="button" onClick={submitFilters}>
          Apply
        </button>
      </div>

      {loading ? (
        <div className="empty-state">
          <p>Loading users...</p>
        </div>
      ) : users.length === 0 ? (
        <div className="empty-state">
          <h2>No users found</h2>
          <p>Adjust filters or wait for new registrations.</p>
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
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.displayName || "-"}</td>
                  <td>
                    {canManageRoles ? (
                      <div className="role-checks">
                        {roles.map((role) => (
                          <label key={role} className="checkbox-row compact-checkbox">
                            <input
                              type="checkbox"
                              checked={u.roles.includes(role)}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? [...u.roles, role]
                                  : u.roles.filter((item) => item !== role);
                                updateRoles(
                                  u,
                                  ROLE_ORDER.filter((item) => next.includes(item)),
                                );
                              }}
                            />
                            {role}
                          </label>
                        ))}
                      </div>
                    ) : (
                      u.roles.join(", ") || "-"
                    )}
                  </td>
                  <td>
                    <select
                      className="form-input compact-input"
                      value={u.status}
                      onChange={(e) => updateStatus(u, e.target.value)}
                      aria-label={`Status for ${u.email}`}
                    >
                      {STATUSES.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <span className={`badge ${u.emailVerified ? "badge-green" : "badge-red"}`}>
                      {u.emailVerified ? "Yes" : "No"}
                    </span>
                  </td>
                  <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                  <td>
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      onClick={() => loadUsers()}
                    >
                      Refresh
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="pagination-row">
        <button
          className="btn btn-secondary btn-sm"
          type="button"
          disabled={page <= 1}
          onClick={() => setPage((value) => Math.max(1, value - 1))}
        >
          Previous
        </button>
        <span className="muted">
          Page {page} of {totalPages}
        </span>
        <button
          className="btn btn-secondary btn-sm"
          type="button"
          disabled={page >= totalPages}
          onClick={() => setPage((value) => value + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
