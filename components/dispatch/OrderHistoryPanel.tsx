'use client'
import { useState, useEffect, useRef } from 'react'
import { DBOrder } from '@/types'
import { X, Clock, Send, Package, Calendar, Ban, AlertTriangle, CheckCircle, Upload, RotateCcw, MessageSquare } from 'lucide-react'

interface OrderEvent {
  id: string
  order_id: string
  event_type: string
  title: string
  note: string | null
  created_by_email: string | null
  created_at: string
}

interface Props {
  order: DBOrder
  currentUserEmail: string
  onClose: () => void
}

const EVENT_ICONS: Record<string, React.ReactNode> = {
  import:        <Upload size={13} />,
  scheduled:     <Calendar size={13} />,
  rescheduled:   <RotateCcw size={13} />,
  hold:          <Clock size={13} />,
  unfulfillable: <AlertTriangle size={13} />,
  cancelled:     <Ban size={13} />,
  dispatched:    <CheckCircle size={13} />,
  target_set:    <Calendar size={13} />,
  note:          <MessageSquare size={13} />,
}

const EVENT_COLORS: Record<string, { dot: string; bg: string; text: string }> = {
  import:        { dot: '#9ca3af', bg: 'transparent', text: 'var(--text3)' },
  scheduled:     { dot: 'var(--dispatched)', bg: 'transparent', text: 'var(--text2)' },
  rescheduled:   { dot: 'var(--plan)', bg: 'transparent', text: 'var(--text2)' },
  hold:          { dot: 'var(--hold)', bg: 'transparent', text: 'var(--text2)' },
  unfulfillable: { dot: 'var(--critical)', bg: 'transparent', text: 'var(--text2)' },
  cancelled:     { dot: 'var(--critical)', bg: 'transparent', text: 'var(--text2)' },
  dispatched:    { dot: 'var(--dispatched)', bg: 'var(--dispatched-bg)', text: 'var(--dispatched)' },
  target_set:    { dot: 'var(--accent)', bg: 'transparent', text: 'var(--text2)' },
  note:          { dot: 'var(--accent)', bg: 'var(--surface)', text: 'var(--text)' },
}

function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function initials(email: string | null) {
  if (!email) return '?'
  return email.split('@')[0].slice(0, 2).toUpperCase()
}

export default function OrderHistoryPanel({ order, currentUserEmail, onClose }: Props) {
  const [events, setEvents] = useState<OrderEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [noteText, setNoteText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    fetchEvents()
  }, [order.id])

  const fetchEvents = async () => {
    setLoading(true)
    const res = await fetch(`/api/events?order_id=${order.order_id}`)
    const data = await res.json()
    setEvents(data)
    setLoading(false)
  }

  const addNote = async () => {
    if (!noteText.trim() || submitting) return
    setSubmitting(true)
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: order.order_id,
        event_type: 'note',
        title: 'Note added',
        note: noteText.trim(),
      }),
    })
    if (res.ok) {
      const newEvent = await res.json()
      setEvents(prev => [newEvent, ...prev])
      setNoteText('')
    }
    setSubmitting(false)
  }

  const urgencyColors: Record<string, string> = {
    CRITICAL: 'var(--critical)', TODAY: 'var(--today)',
    PLAN: 'var(--plan)', HOLD: 'var(--hold)',
  }
  const uc = urgencyColors[order.urgency || ''] || 'var(--text3)'

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 200,
          background: 'rgba(0,0,0,0.15)',
        }}
      />

      {/* Panel */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 201,
        width: 400,
        background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        boxShadow: '-4px 0 24px rgba(0,0,0,0.08)',
        display: 'flex', flexDirection: 'column',
        animation: 'slideIn 0.2s ease-out',
      }}>
        <style>{`
          @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
          }
        `}</style>

        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'flex-start', gap: 12,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{
                fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600,
                color: uc, background: order.urgency ? `${uc}18` : 'var(--bg2)',
                padding: '2px 7px', borderRadius: 4,
              }}>{order.urgency || '—'}</span>
              <span style={{
                fontSize: 10, fontFamily: 'DM Mono',
                color: order.courier === 'Bluedart' ? '#2563eb' : '#7c3aed',
                background: order.courier === 'Bluedart' ? '#eff6ff' : '#f5f3ff',
                padding: '2px 7px', borderRadius: 4,
              }}>{order.courier === 'Bluedart' ? 'BD' : 'DL'}</span>
              {order.is_dispatched && (
                <span style={{ fontSize: 10, fontFamily: 'DM Mono', color: 'var(--dispatched)', background: 'var(--dispatched-bg)', padding: '2px 7px', borderRadius: 4 }}>DISPATCHED</span>
              )}
            </div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', marginBottom: 2 }}>{order.customer_name}</div>
            <div style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>{order.order_id}</div>
            {/* Snapshot grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' }}>
              {[
                { label: 'SKU', value: order.sku },
                { label: 'Promise', value: order.promise_date ? new Date(order.promise_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—' },
                { label: 'AWB', value: order.tracking_number || '—' },
                { label: 'Pincode', value: `${order.pincode}${order.city ? ` · ${order.city}` : ''}` },
              ].map(({ label, value }) => (
                <div key={label}>
                  <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{label} </span>
                  <span style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'DM Mono', fontWeight: 500 }}>{value}</span>
                </div>
              ))}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 4, flexShrink: 0 }}>
            <X size={16} />
          </button>
        </div>

        {/* Timeline */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px 8px' }}>
          {loading ? (
            <div style={{ color: 'var(--text3)', fontSize: 13, textAlign: 'center', padding: 32 }}>Loading history…</div>
          ) : events.length === 0 ? (
            <div style={{ color: 'var(--text3)', fontSize: 13, textAlign: 'center', padding: 32 }}>
              <Clock size={24} style={{ margin: '0 auto 8px', opacity: 0.3 }} />
              No history yet
            </div>
          ) : (
            <div style={{ position: 'relative' }}>
              {/* Vertical line */}
              <div style={{
                position: 'absolute', left: 15, top: 8, bottom: 8,
                width: 1, background: 'var(--border)',
              }} />

              {events.map((event, idx) => {
                const colors = EVENT_COLORS[event.event_type] || EVENT_COLORS.note
                const isNote = event.event_type === 'note'

                return (
                  <div key={event.id} style={{
                    display: 'flex', gap: 14, marginBottom: idx < events.length - 1 ? 20 : 0,
                    position: 'relative',
                  }}>
                    {/* Dot */}
                    <div style={{
                      width: 30, flexShrink: 0, display: 'flex', justifyContent: 'center', paddingTop: 2,
                    }}>
                      <div style={{
                        width: isNote ? 28 : 20,
                        height: isNote ? 28 : 20,
                        borderRadius: '50%',
                        background: isNote ? 'var(--accent)' : colors.dot + '20',
                        border: `2px solid ${colors.dot}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: isNote ? '#fff' : colors.dot,
                        flexShrink: 0,
                        marginLeft: isNote ? -4 : 0,
                        zIndex: 1,
                        position: 'relative',
                      }}>
                        {EVENT_ICONS[event.event_type] || <Clock size={11} />}
                      </div>
                    </div>

                    {/* Content */}
                    <div style={{ flex: 1, paddingTop: isNote ? 0 : 1 }}>
                      {isNote ? (
                        // Note card — prominent
                        <div style={{
                          background: 'var(--bg2)',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          padding: '10px 12px',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                            <div style={{
                              width: 20, height: 20, borderRadius: '50%',
                              background: 'var(--accent)', color: '#fff',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 9, fontWeight: 700, fontFamily: 'DM Mono',
                              flexShrink: 0,
                            }}>
                              {initials(event.created_by_email)}
                            </div>
                            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)' }}>
                              {event.created_by_email?.split('@')[0] || 'Unknown'}
                            </span>
                            <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 'auto' }}>
                              {formatTime(event.created_at)}
                            </span>
                          </div>
                          <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5, margin: 0 }}>
                            {event.note}
                          </p>
                        </div>
                      ) : (
                        // System event — compact
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 12, color: colors.text, fontWeight: 500 }}>{event.title}</span>
                          </div>
                          {event.note && (
                            <p style={{ fontSize: 11, color: 'var(--text3)', margin: '2px 0 0', lineHeight: 1.4 }}>{event.note}</p>
                          )}
                          <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'DM Mono' }}>
                            {formatTime(event.created_at)}
                            {event.created_by_email && ` · ${event.created_by_email.split('@')[0]}`}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Add note */}
        <div style={{
          padding: '12px 20px 16px',
          borderTop: '1px solid var(--border)',
          background: 'var(--surface)',
        }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6, fontFamily: 'DM Mono' }}>ADD NOTE</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <textarea
              ref={inputRef}
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote() }
              }}
              placeholder="Type a note… (Enter to send, Shift+Enter for new line)"
              rows={2}
              style={{
                flex: 1, padding: '8px 10px',
                borderRadius: 7, border: '1px solid var(--border)',
                background: 'var(--bg)', color: 'var(--text)',
                fontSize: 13, fontFamily: 'DM Sans',
                resize: 'none', outline: 'none',
                transition: 'border-color 0.15s',
                lineHeight: 1.5,
              }}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'}
            />
            <button
              onClick={addNote}
              disabled={!noteText.trim() || submitting}
              style={{
                padding: '8px 12px', borderRadius: 7, border: 'none',
                background: noteText.trim() ? 'var(--accent)' : 'var(--bg2)',
                color: noteText.trim() ? '#fff' : 'var(--text3)',
                cursor: noteText.trim() ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, alignSelf: 'flex-end',
                transition: 'all 0.15s',
              }}
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
