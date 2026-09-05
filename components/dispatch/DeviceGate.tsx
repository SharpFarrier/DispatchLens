'use client'
import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { RefreshCw, LogOut } from 'lucide-react'

const DEVICE_KEY = 'dl_device_id'
type Status = 'checking' | 'approved' | 'pending' | 'denied' | 'revoked' | 'error'

// Random, unguessable per-browser device token. The SHORT code shown to the admin is only a
// lookup label — it is NOT this token and grants nothing on its own.
function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) {
      id = (crypto.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2)))
      localStorage.setItem(DEVICE_KEY, id)
    }
    return id
  } catch {
    // localStorage blocked (incognito/hardened) — fall back to a volatile id (will read as pending).
    return 'volatile-' + Math.random().toString(36).slice(2)
  }
}

function shortCode(deviceId: string): string {
  // Deterministic 8-char code from the device id, formatted XXXX-XXXX (lookup label only).
  let h = 0
  for (let i = 0; i < deviceId.length; i++) { h = (h * 31 + deviceId.charCodeAt(i)) >>> 0 }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous chars
  let s = ''
  let n = h
  for (let i = 0; i < 8; i++) { s += alphabet[n % alphabet.length]; n = Math.floor(n / alphabet.length) + (i + 1) * 7 }
  return s.slice(0, 4) + '-' + s.slice(4, 8)
}

export default function DeviceGate({ userEmail, isOwner, children }: { userEmail: string; isOwner: boolean; children: React.ReactNode }) {
  const supabase = createClient()
  const [status, setStatus] = useState<Status>('checking')
  const [deviceId] = useState(getDeviceId)
  const code = shortCode(deviceId)
  const [retrying, setRetrying] = useState(false)

  const check = useCallback(async () => {
    // Owner bypasses the gate entirely — any device.
    if (isOwner) { setStatus('approved'); return }
    try {
      const { data, error } = await supabase.from('approved_devices').select('status').eq('device_id', deviceId).maybeSingle()
      if (error) { setStatus('error'); return }
      if (!data) {
        // First time on this device — register a pending request.
        const ua = typeof navigator !== 'undefined' ? navigator.userAgent : null
        await supabase.from('approved_devices').insert({ device_id: deviceId, code, status: 'pending', requested_by: userEmail, user_agent: ua, requested_at: new Date().toISOString() })
        setStatus('pending')
        return
      }
      const st = data.status as Status
      if (st === 'approved') {
        // Touch last_seen (best-effort, non-blocking).
        void supabase.from('approved_devices').update({ last_seen_at: new Date().toISOString() }).eq('device_id', deviceId)
        setStatus('approved')
      } else {
        setStatus(st === 'denied' ? 'denied' : st === 'revoked' ? 'revoked' : 'pending')
      }
    } catch {
      setStatus('error')
    }
  }, [supabase, deviceId, code, userEmail, isOwner])

  useEffect(() => { void check() }, [check])

  const retry = async () => { setRetrying(true); await check(); setRetrying(false) }
  const signOut = async () => { await supabase.auth.signOut(); if (typeof window !== 'undefined') window.location.reload() }

  if (status === 'approved') return <>{children}</>

  if (status === 'checking') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', color: 'var(--text3)', fontSize: 14 }}>
        Checking device…
      </div>
    )
  }

  const denied = status === 'denied' || status === 'revoked'
  const title = status === 'revoked' ? 'This device has been revoked' : status === 'denied' ? 'This device was denied' : status === 'error' ? 'Could not verify this device' : "This device isn't approved"
  const body = status === 'error'
    ? 'There was a problem checking this device. Retry, or contact an admin.'
    : denied
      ? 'An admin has removed access for this device. Contact an admin if this is a mistake.'
      : 'DispatchLens can only be used on approved company devices. Ask an admin to approve this device using the code below.'

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: 24 }}>
      <div style={{ width: 'min(440px,96vw)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 28, textAlign: 'center' as const }}>
        <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'var(--critical-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <LogOut size={24} style={{ color: 'var(--critical)' }} />
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6, color: 'var(--text)' }}>{title}</div>
        <div style={{ fontSize: 14, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 20 }}>{body}</div>

        {!denied && status !== 'error' && (
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 6 }}>Device code</div>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'DM Mono', letterSpacing: '0.08em', color: 'var(--text)' }}>{code}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>Read this to an admin to get this device approved.</div>
          </div>
        )}

        <button onClick={retry} disabled={retrying}
          style={{ width: '100%', padding: '10px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: retrying ? 'default' : 'pointer', marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <RefreshCw size={15} /> {retrying ? 'Checking…' : "I've been approved — retry"}
        </button>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>
          Signed in as {userEmail} · <button onClick={signOut} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' }}>Sign out</button>
        </div>
      </div>
    </div>
  )
}
