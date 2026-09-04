'use client';

import { Suspense } from 'react';
import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [noToken, setNoToken] = useState(false);

  useEffect(() => {
    if (!token) setNoToken(true);
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const res = await api.post('/auth/reset-password', { token, password });
      if (res.ok) {
        setSuccess('Password reset! You can now sign in with your new password.');
        setPassword('');
        setConfirm('');
      } else {
        const msg =
          typeof res.data === 'object' && res.data !== null && 'message' in res.data
            ? String((res.data as { message: string }).message)
            : 'Reset failed. The link may have expired.';
        setError(msg);
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (noToken) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Reset password</h1>
          <div className="alert alert-error">
            No reset token provided. Please use the link from your email.
          </div>
          <p className="auth-footer">
            <Link href="/forgot-password">Request a new link</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Reset password</h1>
        <p className="muted">Enter your new password below.</p>
        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}
        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            New Password
            <input
              type="password"
              name="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </label>
          <label>
            Confirm Password
            <input
              type="password"
              name="confirm"
              placeholder="••••••••"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? 'Resetting…' : 'Reset password'}
          </button>
        </form>
        {success && (
          <p className="auth-footer">
            <Link href="/signin">Go to sign in</Link>
          </p>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="auth-page"><div className="auth-card"><p className="muted">Loading…</p></div></div>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
