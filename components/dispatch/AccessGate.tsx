'use client'
import { createClient } from '@/lib/supabase/client'
import { User } from '@supabase/supabase-js'
import { Clock, XCircle, LogOut } from 'lucide-react'

interface Props {
  status: string
  email: string
  user: User
}

export default function AccessGate({ status, email, user }: Props) {
  const supabase = createClient()

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  const isPending = status === 'pending'

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg)',
      display: 'flex', flexDirection: 'column' as const,
      alignItems: 'center', justifyContent: 'center',
    }}>
      {/* Subtle grid */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 0,
        backgroundImage: 'linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)',
        backgroundSize: '40px 40px', opacity: 0.5,
      }} />

      <div style={{
        position: 'relative', zIndex: 1,
        width: 440,
        background: 'var(--surface)',
        border: `1px solid ${isPending ? 'var(--border)' : '#fecaca'}`,
        borderRadius: 12,
        padding: '40px 40px 36px',
        boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
        display: 'flex', flexDirection: 'column' as const, gap: 24,
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, background: 'var(--accent)', borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'DM Mono', fontWeight: 500, fontSize: 14, color: '#fff' }}>D</div>
          <span style={{ fontFamily: 'DM Mono', fontWeight: 500, fontSize: 15 }}>DispatchLens</span>
        </div>

        <div style={{ height: 1, background: 'var(--border)' }} />

        {/* Status icon + message */}
        <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 16, padding: '8px 0' }}>
          {isPending ? (
            <div style={{
              width: 56, height: 56, borderRadius: '50%',
              background: '#fef3c7', border: '2px solid #fde68a',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Clock size={26} color="#d97706" />
            </div>
          ) : (
            <div style={{
              width: 56, height: 56, borderRadius: '50%',
              background: '#fef2f2', border: '2px solid #fecaca',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <XCircle size={26} color="#dc2626" />
            </div>
          )}

          <div style={{ textAlign: 'center' as const }}>
            <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 8, color: 'var(--text)' }}>
              {isPending ? 'Access Pending' : 'Access Denied'}
            </h2>
            <p style={{ fontSize: 14, color: 'var(--text2)', lineHeight: 1.6 }}>
              {isPending
                ? <>Your request to access DispatchLens has been received.<br />Please wait for an administrator to approve your account.</>
                : <>Your account has been denied access to DispatchLens.<br />Please contact your administrator if you think this is a mistake.</>
              }
            </p>
          </div>

          {/* Email chip */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 20, padding: '6px 14px',
          }}>
            {user.user_metadata?.avatar_url && (
              <img src={user.user_metadata.avatar_url} alt="" style={{ width: 20, height: 20, borderRadius: '50%' }} />
            )}
            <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text2)' }}>{email}</span>
          </div>
        </div>

        <div style={{ height: 1, background: 'var(--border)' }} />

        <button onClick={handleSignOut} style={{
          width: '100%', padding: '10px 16px', borderRadius: 8,
          background: 'var(--surface)', border: '1px solid var(--border)',
          color: 'var(--text2)', fontSize: 14, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          fontFamily: 'DM Sans', fontWeight: 500,
          transition: 'border-color 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
        onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
        >
          <LogOut size={14} /> Sign out
        </button>
      </div>
    </div>
  )
}
