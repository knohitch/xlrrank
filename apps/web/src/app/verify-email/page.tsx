'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';

  const [status, setStatus] = useState<'loading' | 'success' | 'error' | 'no-token'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('no-token');
      setMessage('No verification token provided.');
      return;
    }

    let cancelled = false;
    async function verify() {
      try {
        const res = await api.post('/auth/verify-email', { token });
        if (cancelled) return;
        if (res.ok) {
          setStatus('success');
          setMessage('Email verified! You can now sign in.');
        } else {
          const msg =
            typeof res.data === 'object' && res.data !== null && 'message' in res.data
              ? String((res.data as { message: string }).message)
              : 'Verification failed. The link may have expired.';
          setStatus('error');
          setMessage(msg);
        }
      } catch {
        if (!cancelled) {
          setStatus('error');
          setMessage('Network error. Please try again.');
        }
      }
    }

    verify();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Verify email</h1>
        {status === 'loading' && <p className="muted">Verifying your email…</p>}
        {status === 'success' && <div className="alert alert-success">{message}</div>}
        {(status === 'error' || status === 'no-token') && (
          <div className="alert alert-error">{message}</div>
        )}
        <p className="auth-footer">
          <Link href="/signin">Go to sign in</Link>
        </p>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="auth-page"><div className="auth-card"><p className="muted">Loading…</p></div></div>}>
      <VerifyEmailContent />
    </Suspense>
  );
}
