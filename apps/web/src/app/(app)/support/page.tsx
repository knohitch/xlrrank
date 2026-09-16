"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { api } from "@/lib/api";

const STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_FOR_USER", "ESCALATED", "RESOLVED", "CLOSED"];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];

interface MeResponse {
  user: {
    userId?: string;
    id?: string;
    roles: string[];
  };
}

interface Ticket {
  id: string;
  userId?: string;
  assignedToUserId: string | null;
  category: string | null;
  priority: string;
  status: string;
  subject: string;
  createdAt: string;
  updatedAt: string;
}

interface Message {
  id: string;
  senderUserId: string | null;
  body: string;
  isInternal: boolean;
  createdAt: string;
}

function getMessage(data: unknown, fallback: string) {
  return typeof data === "object" && data !== null && "message" in data
    ? String((data as { message: string }).message)
    : fallback;
}

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<{ ticket: Ticket; messages: Message[] } | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [assignedToUserId, setAssignedToUserId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const isStaff = useMemo(
    () => roles.some((role) => role === "SUPPORT" || role === "ADMIN" || role === "SUPER_ADMIN"),
    [roles],
  );

  const loadTickets = useCallback(async () => {
    setLoading(true);
    setError("");
    const path =
      isStaff && statusFilter
        ? `/support/tickets?status=${encodeURIComponent(statusFilter)}`
        : "/support/tickets";
    const res = await api.get<{ tickets: Ticket[] }>(path);
    if (res.ok && Array.isArray(res.data?.tickets)) {
      setTickets(res.data.tickets);
    } else {
      setError(getMessage(res.data, "Unable to load tickets."));
    }
    setLoading(false);
  }, [isStaff, statusFilter]);

  const loadTicket = useCallback(async (id: string) => {
    if (!id) return;
    const res = await api.get<{ ticket: Ticket; messages: Message[] }>(`/support/tickets/${id}`);
    if (res.ok && res.data?.ticket) {
      setSelected(res.data);
      setAssignedToUserId(res.data.ticket.assignedToUserId || "");
    } else {
      setError(getMessage(res.data, "Unable to open ticket."));
    }
  }, []);

  useEffect(() => {
    async function loadMe() {
      const res = await api.get<MeResponse>("/auth/me");
      if (res.ok && res.data?.user?.roles) setRoles(res.data.user.roles);
    }
    loadMe().catch(() => setError("Unable to load support permissions."));
  }, []);

  useEffect(() => {
    loadTickets().catch(() => {
      setError("Unable to load tickets.");
      setLoading(false);
    });
  }, [loadTickets]);

  useEffect(() => {
    if (selectedId) loadTicket(selectedId).catch(() => setError("Unable to open ticket."));
  }, [selectedId, loadTicket]);

  async function createTicket(e: FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    const res = await api.post<{ ticket: Ticket }>("/support/tickets", {
      subject,
      body,
      category: category.trim() ? category.trim() : undefined,
      priority,
    });
    if (res.ok && res.data?.ticket) {
      setSubject("");
      setBody("");
      setCategory("");
      setPriority("MEDIUM");
      setMessage("Ticket created.");
      await loadTickets();
      setSelectedId(res.data.ticket.id);
    } else {
      setError(getMessage(res.data, "Unable to create ticket."));
    }
  }

  async function sendReply(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setError("");
    const res = await api.post<{ ticket: Ticket; messages: Message[] }>(
      `/support/tickets/${selected.ticket.id}/messages`,
      { body: reply, isInternal: internal },
    );
    if (res.ok && res.data?.ticket) {
      setReply("");
      setInternal(false);
      setSelected(res.data);
      await loadTickets();
    } else {
      setError(getMessage(res.data, "Unable to add message."));
    }
  }

  async function updateTicket(update: Partial<Ticket>) {
    if (!selected) return;
    const res = await api.patch<{ ticket: Ticket; messages: Message[] }>(
      `/support/tickets/${selected.ticket.id}`,
      update,
    );
    if (res.ok && res.data?.ticket) {
      setSelected(res.data);
      await loadTickets();
    } else {
      setError(getMessage(res.data, "Unable to update ticket."));
    }
  }

  return (
    <div className="shell-page">
      <div className="page-heading">
        <h1>Support</h1>
        <p className="muted">Create tickets, review conversations, and manage support work.</p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {message && <div className="alert alert-success">{message}</div>}

      <div className="support-workspace">
        <section className="support-panel">
          <h2>Create ticket</h2>
          <form className="stacked-form" onSubmit={createTicket}>
            <label className="form-label">
              Subject
              <input
                className="form-input"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={60}
                required
              />
            </label>
            <label className="form-label">
              Category
              <input
                className="form-input"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                maxLength={80}
              />
            </label>
            <label className="form-label">
              Priority
              <select
                className="form-input"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                {PRIORITIES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-label">
              Message
              <textarea
                className="form-input"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                minLength={10}
                maxLength={5000}
                rows={5}
                required
              />
            </label>
            <button className="btn btn-primary" type="submit">
              Create ticket
            </button>
          </form>
        </section>

        <section className="support-panel">
          <div className="panel-heading-row">
            <h2>{isStaff ? "All tickets" : "My tickets"}</h2>
            {isStaff && (
              <select
                className="form-input compact-input"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                aria-label="Filter tickets by status"
              >
                <option value="">All statuses</option>
                {STATUSES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            )}
          </div>
          {loading ? (
            <p className="muted">Loading tickets...</p>
          ) : tickets.length === 0 ? (
            <p className="muted">No tickets found.</p>
          ) : (
            <div className="ticket-list">
              {tickets.map((ticket) => (
                <button
                  type="button"
                  className={`ticket-row ${selectedId === ticket.id ? "ticket-row-active" : ""}`}
                  key={ticket.id}
                  onClick={() => setSelectedId(ticket.id)}
                >
                  <span>{ticket.subject}</span>
                  <span className="badge badge-muted">{ticket.status}</span>
                  <span className="badge badge-accent">{ticket.priority}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="support-panel support-panel-wide">
          <h2>Ticket detail</h2>
          {!selected ? (
            <p className="muted">Select a ticket to view the conversation.</p>
          ) : (
            <>
              <div className="ticket-meta">
                <strong>{selected.ticket.subject}</strong>
                <span className="badge badge-muted">{selected.ticket.status}</span>
                <span className="badge badge-accent">{selected.ticket.priority}</span>
              </div>

              {isStaff && (
                <div className="ticket-controls">
                  <label className="form-label">
                    Status
                    <select
                      className="form-input"
                      value={selected.ticket.status}
                      onChange={(e) => updateTicket({ status: e.target.value })}
                    >
                      {STATUSES.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="form-label">
                    Priority
                    <select
                      className="form-input"
                      value={selected.ticket.priority}
                      onChange={(e) => updateTicket({ priority: e.target.value })}
                    >
                      {PRIORITIES.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="form-label">
                    Assigned user ID
                    <input
                      className="form-input"
                      value={assignedToUserId}
                      onChange={(e) => setAssignedToUserId(e.target.value)}
                    />
                  </label>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() =>
                      updateTicket({
                        assignedToUserId: assignedToUserId.trim() || null,
                      })
                    }
                  >
                    Assign
                  </button>
                </div>
              )}

              <div className="message-list">
                {selected.messages.map((item) => (
                  <div className="message-row" key={item.id}>
                    <div className="message-row-meta">
                      <span>{new Date(item.createdAt).toLocaleString()}</span>
                      {item.isInternal && <span className="badge badge-red">Internal</span>}
                    </div>
                    <p>{item.body}</p>
                  </div>
                ))}
              </div>

              <form className="stacked-form" onSubmit={sendReply}>
                <label className="form-label">
                  Reply
                  <textarea
                    className="form-input"
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    minLength={1}
                    maxLength={5000}
                    rows={4}
                    required
                  />
                </label>
                {isStaff && (
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={internal}
                      onChange={(e) => setInternal(e.target.checked)}
                    />
                    Internal note
                  </label>
                )}
                <button className="btn btn-primary" type="submit">
                  Send reply
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
