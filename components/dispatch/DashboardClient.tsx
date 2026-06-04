'use client'
import { useState, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { parseOrders } from '@/lib/parser'
import { DBOrder, DispatchSession, PlanDecision, UrgencyTier, Courier } from '@/types'
import { User } from '@supabase/supabase-js'
import {
  Star, Printer, CheckCircle, ChevronDown, ChevronUp,
  Upload, LogOut, Package, Truck, AlertTriangle, Clock,
  RefreshCw, Plus, ArrowRight
} from 'lucide-react'

type Tab = 'import' | 'plan' | 'picklist' | 'eod'
type FilterTier = 'ALL' | UrgencyTier

interface Props {
  user: User
  initialSessions: DispatchSession[]
}

const URGENCY_ORDER: UrgencyTier[] = ['CRITICAL', 'TODAY', 'PLAN', 'HOLD']

export default function DashboardClient({ user, initialSessions }: Props) {
  const supabase = createClient()
  const [tab, setTab] = useState<Tab>('import')
  const [sessions, setSessions] = useState<DispatchSession[]>(initialSessions)
  const [activeSession, setActiveSession] = useState<DispatchSession | null>(initialSessions[0] || null)
  const [orders, setOrders] = useState<DBOrder[]>([])
  const [loadingOrders, setLoadingOrders] = useState(false)
  const [delhiveryText, setDelhiveryText] = useState('')
  const [bluedartText, setBluedartText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ added: number; skipped: number } | null>(null)
  const [filterTier, setFilterTier] = useState<FilterTier>('ALL')
  const [showCancelled, setShowCancelled] = useState(false)
  const [showDispatched, setShowDispatched] = useState(false)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [eodDone, setEodDone] = useState(false)

  const loadOrders = useCallback(async (sessionId: string) => {
    setLoadingOrders(true)
    const { data } = await supabase
      .from('dispatch_orders')
      .select('*')
      .eq('session_id', sessionId)
    setOrders((data as DBOrder[]) || [])
    setLoadingOrders(false)
  }, [supabase])

  const selectSession = useCallback((s: DispatchSession) => {
    setActiveSession(s)
    loadOrders(s.id)
    setTab('plan')
  }, [loadOrders])

  const createSession = async () => {
    const today = new Date().toISOString().split('T')[0]
    const label = `Dispatch ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`
    const { data, error } = await supabase
      .from('dispatch_sessions')
      .insert({ created_by: user.id, session_date: today, label })
      .select().single()
    if (!error && data) {
      setSessions(prev => [data, ...prev])
      setActiveSession(data)
      setOrders([])
      setTab('import')
      setImportResult(null)
    }
  }

  const handleImport = async () => {
    if (!activeSession) return
    if (!delhiveryText.trim() && !bluedartText.trim()) return
    setImporting(true)
    setImportResult(null)

    const allParsed = [
      ...parseOrders(delhiveryText, 'Delhivery'),
      ...parseOrders(bluedartText, 'Bluedart'),
    ]

    if (allParsed.length === 0) { setImporting(false); return }

    const { data: existing } = await supabase
      .from('dispatch_orders').select('order_id').eq('session_id', activeSession.id)

    const existingIds = new Set((existing || []).map((o: { order_id: string }) => o.order_id))
    const newOrders = allParsed.filter(o => !existingIds.has(o.order_id))

    if (newOrders.length > 0) {
      const rows = newOrders.map(o => ({
        session_id: activeSession.id, ...o,
        plan_decision: o.is_dispatched ? 'dispatch_today' : 'undecided',
      }))
      await supabase.from('dispatch_orders').insert(rows)
      await loadOrders(activeSession.id)
      const total = (existing?.length || 0) + newOrders.length
      await supabase.from('dispatch_sessions').update({ total_orders: total }).eq('id', activeSession.id)
    }

    setImportResult({ added: newOrders.length, skipped: allParsed.length - newOrders.length })
    setImporting(false)
    setDelhiveryText('')
    setBluedartText('')
    if (newOrders.length > 0) setTab('plan')
  }

  const updateDecision = async (orderId: string, decision: PlanDecision) => {
    setUpdatingId(orderId)
    await supabase.from('dispatch_orders')
      .update({ plan_decision: decision, updated_at: new Date().toISOString() })
      .eq('id', orderId)
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, plan_decision: decision } : o))
    setUpdatingId(null)
  }

  const togglePriority = async (orderId: string, current: boolean) => {
    await supabase.from('dispatch_orders').update({ is_priority: !current }).eq('id', orderId)
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, is_priority: !current } : o))
  }

  const handleEOD = async () => {
    if (!activeSession) return
    const dispatchedOrders = orders.filter(o => o.plan_decision === 'dispatch_today' && !o.is_cancelled)
    const now = new Date().toISOString()
    await supabase.from('dispatch_orders')
      .update({ dispatched_at: now, is_dispatched: true })
      .in('id', dispatchedOrders.map(o => o.id))
    await supabase.from('dispatch_sessions').update({
      is_eod_done: true,
      dispatched_count: dispatchedOrders.length,
      held_count: orders.filter(o => o.plan_decision === 'hold').length,
      unfulfillable_count: orders.filter(o => o.plan_decision === 'unfulfillable').length,
    }).eq('id', activeSession.id)
    setEodDone(true)
    await loadOrders(activeSession.id)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  // Computed
  const activeOrders = useMemo(() => orders.filter(o => !o.is_cancelled && !o.is_dispatched), [orders])
  const cancelledOrders = useMemo(() => orders.filter(o => o.is_cancelled), [orders])
  const dispatchedOrders = useMemo(() => orders.filter(o => o.is_dispatched && !o.is_cancelled), [orders])

  const filteredActive = useMemo(() => {
    let list = [...activeOrders]
    if (filterTier !== 'ALL') list = list.filter(o => o.urgency === filterTier)
    const tierOrder: Record<string, number> = { CRITICAL: 0, TODAY: 1, PLAN: 2, HOLD: 3 }
    list.sort((a, b) => {
      if (a.is_priority !== b.is_priority) return a.is_priority ? -1 : 1
      const ta = tierOrder[a.urgency || 'HOLD'] ?? 3
      const tb = tierOrder[b.urgency || 'HOLD'] ?? 3
      if (ta !== tb) return ta - tb
      return (a.days_left ?? 99) - (b.days_left ?? 99)
    })
    return list
  }, [activeOrders, filterTier])

  const picklist = useMemo(() => {
    const dispatchToday = orders.filter(o => o.plan_decision === 'dispatch_today' && !o.is_cancelled)
    const skuMap: Record<string, { sku: string; courier: Courier; qty: number; count: number }> = {}
    dispatchToday.forEach(o => {
      const key = `${o.sku}__${o.courier}`
      if (!skuMap[key]) skuMap[key] = { sku: o.sku, courier: o.courier as Courier, qty: 0, count: 0 }
      skuMap[key].qty += o.qty
      skuMap[key].count += 1
    })
    return Object.values(skuMap).sort((a, b) => a.sku.localeCompare(b.sku))
  }, [orders])

  const dispatchTodayCount = orders.filter(o => o.plan_decision === 'dispatch_today' && !o.is_cancelled).length
  const holdCount = orders.filter(o => o.plan_decision === 'hold').length
  const unfulfillableCount = orders.filter(o => o.plan_decision === 'unfulfillable').length
  const undecidedCount = activeOrders.filter(o => o.plan_decision === 'undecided').length

  const tierCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    activeOrders.forEach(o => { if (o.urgency) counts[o.urgency] = (counts[o.urgency] || 0) + 1 })
    return counts
  }, [activeOrders])

  // Styles
  const card = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    boxShadow: 'var(--shadow)',
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' as const }}>
      {/* ── Header ── */}
      <header style={{
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        padding: '0 32px',
        height: 56,
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        position: 'sticky' as const, top: 0, zIndex: 100,
        boxShadow: 'var(--shadow)',
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 32 }}>
          <div style={{
            width: 30, height: 30, background: 'var(--accent)', borderRadius: 7,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'DM Mono', fontWeight: 500, fontSize: 14, color: '#fff',
          }}>D</div>
          <span style={{ fontFamily: 'DM Mono', fontWeight: 500, fontSize: 15, color: 'var(--text)' }}>
            DispatchLens
          </span>
        </div>

        {/* Nav tabs */}
        <nav style={{ display: 'flex', gap: 2, flex: 1 }}>
          {(['import', 'plan', 'picklist', 'eod'] as Tab[]).map(t => {
            const labels: Record<Tab, string> = {
              import: 'Import',
              plan: activeOrders.length ? `Plan (${activeOrders.length})` : 'Plan',
              picklist: `Picklist${dispatchTodayCount ? ` (${dispatchTodayCount})` : ''}`,
              eod: 'End of Day',
            }
            return (
              <button key={t} onClick={() => setTab(t)} style={{
                padding: '6px 16px',
                border: 'none', borderRadius: 6,
                background: tab === t ? 'var(--accent-bg)' : 'transparent',
                color: tab === t ? 'var(--accent)' : 'var(--text2)',
                fontFamily: 'DM Sans', fontWeight: tab === t ? 600 : 400, fontSize: 14,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}>
                {labels[t]}
              </button>
            )
          })}
        </nav>

        {/* Right side */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {activeSession && (
            <span style={{
              fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text3)',
              background: 'var(--bg2)', padding: '4px 10px', borderRadius: 20,
              border: '1px solid var(--border)',
            }}>
              {activeSession.label}
            </span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {user.user_metadata?.avatar_url && (
              <img src={user.user_metadata.avatar_url} alt="" style={{ width: 28, height: 28, borderRadius: '50%' }} />
            )}
            <span style={{ fontSize: 13, color: 'var(--text2)' }}>
              {user.user_metadata?.name?.split(' ')[0] || user.email?.split('@')[0]}
            </span>
          </div>
          <button onClick={handleSignOut} style={{
            background: 'none', border: '1px solid var(--border)', borderRadius: 6,
            color: 'var(--text3)', cursor: 'pointer', padding: '5px 8px',
            display: 'flex', alignItems: 'center', gap: 4, fontSize: 12,
            transition: 'border-color 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
          onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
          >
            <LogOut size={13} />
          </button>
        </div>
      </header>

      {/* ── Main content ── */}
      <main style={{ flex: 1, padding: '28px 32px', maxWidth: 1600, margin: '0 auto', width: '100%' }}>

        {/* ════════════════ IMPORT TAB ════════════════ */}
        {tab === 'import' && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 24 }}>
            {/* Session bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h1 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)' }}>
                {activeSession ? activeSession.label : 'No active session'}
              </h1>
              <button onClick={createSession} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 14px', borderRadius: 7,
                background: 'var(--accent)', border: 'none',
                color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer',
                boxShadow: '0 1px 3px rgba(217,119,6,0.3)',
                transition: 'opacity 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.opacity = '0.9'}
              onMouseLeave={e => e.currentTarget.style.opacity = '1'}
              >
                <Plus size={14} /> New Session
              </button>
              {sessions.length > 1 && (
                <select onChange={e => {
                  const s = sessions.find(x => x.id === e.target.value)
                  if (s) selectSession(s)
                }} value={activeSession?.id || ''} style={{
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  color: 'var(--text)', padding: '7px 12px', borderRadius: 7,
                  fontSize: 13, cursor: 'pointer',
                }}>
                  {sessions.map(s => (
                    <option key={s.id} value={s.id}>{s.label} · {s.total_orders} orders</option>
                  ))}
                </select>
              )}
            </div>

            {!activeSession ? (
              <div style={{
                ...card, padding: 48, textAlign: 'center' as const,
                color: 'var(--text2)',
              }}>
                <Package size={32} style={{ margin: '0 auto 12px', color: 'var(--text3)' }} />
                <p style={{ fontSize: 15 }}>Create a new session to start planning today's dispatches.</p>
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                  {/* Delhivery */}
                  <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: '#7c3aed',
                      }} />
                      <span style={{ fontFamily: 'DM Mono', fontSize: 12, fontWeight: 500, color: 'var(--text2)', letterSpacing: '0.05em' }}>
                        DELHIVERY
                      </span>
                      {delhiveryText.trim() && (
                        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text3)' }}>
                          ~{delhiveryText.trim().split('\n').length - 1} rows
                        </span>
                      )}
                    </div>
                    <textarea
                      value={delhiveryText}
                      onChange={e => setDelhiveryText(e.target.value)}
                      placeholder="Copy from Delhivery planning sheet (include header row) and paste here"
                      style={{
                        height: 260, width: '100%', padding: '12px 14px',
                        background: 'var(--bg)', border: '1px solid var(--border)',
                        borderRadius: 7, color: 'var(--text)', fontFamily: 'DM Mono',
                        fontSize: 12, resize: 'vertical' as const, outline: 'none',
                        lineHeight: 1.5, transition: 'border-color 0.15s',
                      }}
                      onFocus={e => e.target.style.borderColor = '#7c3aed'}
                      onBlur={e => e.target.style.borderColor = 'var(--border)'}
                    />
                  </div>

                  {/* Bluedart */}
                  <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: '#2563eb',
                      }} />
                      <span style={{ fontFamily: 'DM Mono', fontSize: 12, fontWeight: 500, color: 'var(--text2)', letterSpacing: '0.05em' }}>
                        BLUEDART
                      </span>
                      {bluedartText.trim() && (
                        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text3)' }}>
                          ~{bluedartText.trim().split('\n').length - 1} rows
                        </span>
                      )}
                    </div>
                    <textarea
                      value={bluedartText}
                      onChange={e => setBluedartText(e.target.value)}
                      placeholder="Copy from Bluedart planning sheet (include header row) and paste here"
                      style={{
                        height: 260, width: '100%', padding: '12px 14px',
                        background: 'var(--bg)', border: '1px solid var(--border)',
                        borderRadius: 7, color: 'var(--text)', fontFamily: 'DM Mono',
                        fontSize: 12, resize: 'vertical' as const, outline: 'none',
                        lineHeight: 1.5, transition: 'border-color 0.15s',
                      }}
                      onFocus={e => e.target.style.borderColor = '#2563eb'}
                      onBlur={e => e.target.style.borderColor = 'var(--border)'}
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <button
                    onClick={handleImport}
                    disabled={importing || (!delhiveryText.trim() && !bluedartText.trim())}
                    style={{
                      padding: '9px 22px', borderRadius: 7,
                      background: importing || (!delhiveryText.trim() && !bluedartText.trim()) ? 'var(--bg2)' : 'var(--accent)',
                      border: '1px solid transparent',
                      color: importing || (!delhiveryText.trim() && !bluedartText.trim()) ? 'var(--text3)' : '#fff',
                      fontWeight: 600, fontSize: 14, cursor: importing ? 'wait' : 'pointer',
                      display: 'flex', alignItems: 'center', gap: 8,
                      transition: 'all 0.15s',
                    }}
                  >
                    <Upload size={15} />
                    {importing ? 'Importing…' : 'Import Orders'}
                  </button>

                  {importResult && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      color: 'var(--dispatched)', fontSize: 13, fontWeight: 500,
                    }}>
                      <CheckCircle size={15} />
                      {importResult.added} orders imported
                      {importResult.skipped > 0 && (
                        <span style={{ color: 'var(--text3)' }}>
                          · {importResult.skipped} skipped (duplicates)
                        </span>
                      )}
                    </div>
                  )}

                  {orders.length > 0 && (
                    <button onClick={() => setTab('plan')} style={{
                      marginLeft: 'auto',
                      padding: '9px 18px', borderRadius: 7,
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      color: 'var(--text)', fontSize: 13, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 6,
                      fontWeight: 500,
                    }}>
                      View Plan <ArrowRight size={14} />
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ════════════════ PLAN TAB ════════════════ */}
        {tab === 'plan' && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 20 }}>
            {/* Stats row */}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              {[
                { label: 'Total Active', value: activeOrders.length, color: 'var(--text)' },
                { label: 'Undecided', value: undecidedCount, color: undecidedCount > 0 ? 'var(--today)' : 'var(--text2)', bg: undecidedCount > 0 ? 'var(--today-bg)' : 'var(--surface)' },
                { label: 'Dispatch Today', value: dispatchTodayCount, color: 'var(--dispatched)', bg: 'var(--dispatched-bg)' },
                { label: 'On Hold', value: holdCount, color: 'var(--hold)', bg: 'var(--hold-bg)' },
                { label: 'Unfulfillable', value: unfulfillableCount, color: 'var(--critical)', bg: 'var(--critical-bg)' },
              ].map(s => (
                <div key={s.label} style={{
                  padding: '10px 18px',
                  background: (s as any).bg || 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  display: 'flex', flexDirection: 'column' as const, gap: 2,
                  minWidth: 110,
                }}>
                  <span style={{ color: s.color, fontFamily: 'DM Mono', fontSize: 22, fontWeight: 500, lineHeight: 1 }}>{s.value}</span>
                  <span style={{ color: 'var(--text3)', fontSize: 11, marginTop: 2 }}>{s.label}</span>
                </div>
              ))}
              <div style={{ flex: 1 }} />
              {activeSession && (
                <button onClick={() => loadOrders(activeSession.id)} style={{
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 7, color: 'var(--text2)', cursor: 'pointer',
                  padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
                }}>
                  <RefreshCw size={13} /> Refresh
                </button>
              )}
            </div>

            {/* Urgency filters */}
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setFilterTier('ALL')} style={{
                padding: '5px 14px', borderRadius: 6,
                border: '1px solid ' + (filterTier === 'ALL' ? 'var(--accent)' : 'var(--border)'),
                background: filterTier === 'ALL' ? 'var(--accent-bg)' : 'var(--surface)',
                color: filterTier === 'ALL' ? 'var(--accent)' : 'var(--text2)',
                fontSize: 12, fontFamily: 'DM Mono', cursor: 'pointer', fontWeight: 500,
              }}>
                ALL {activeOrders.length > 0 && `(${activeOrders.length})`}
              </button>
              {URGENCY_ORDER.map(tier => {
                const colors: Record<UrgencyTier, { color: string; bg: string; border: string }> = {
                  CRITICAL: { color: 'var(--critical)', bg: 'var(--critical-bg)', border: '#fecaca' },
                  TODAY:    { color: 'var(--today)',    bg: 'var(--today-bg)',    border: '#fed7aa' },
                  PLAN:     { color: 'var(--plan)',     bg: 'var(--plan-bg)',     border: '#fde68a' },
                  HOLD:     { color: 'var(--hold)',     bg: 'var(--hold-bg)',     border: '#bfdbfe' },
                }
                const c = colors[tier]
                const active = filterTier === tier
                return (
                  <button key={tier} onClick={() => setFilterTier(tier)} style={{
                    padding: '5px 14px', borderRadius: 6,
                    border: `1px solid ${active ? c.border : 'var(--border)'}`,
                    background: active ? c.bg : 'var(--surface)',
                    color: active ? c.color : 'var(--text2)',
                    fontSize: 12, fontFamily: 'DM Mono', cursor: 'pointer', fontWeight: 500,
                  }}>
                    {tier}{tierCounts[tier] ? ` (${tierCounts[tier]})` : ''}
                  </button>
                )
              })}
            </div>

            {/* Orders table */}
            {loadingOrders ? (
              <div style={{ ...card, padding: 60, textAlign: 'center' as const, color: 'var(--text3)' }}>
                Loading orders…
              </div>
            ) : filteredActive.length === 0 ? (
              <div style={{ ...card, padding: 60, textAlign: 'center' as const, color: 'var(--text2)' }}>
                {activeOrders.length === 0
                  ? 'No orders imported yet. Go to Import tab to paste your planning data.'
                  : 'No orders match this filter.'}
              </div>
            ) : (
              <div style={{ ...card, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
                        {['', 'Urgency', 'Order ID', 'Customer', 'SKU', 'Cour.', 'Pincode · City', 'ODA', 'Transit', 'Promise', 'Days Left', 'Decision'].map(h => (
                          <th key={h} style={{
                            padding: '9px 12px', textAlign: 'left' as const,
                            color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono',
                            fontWeight: 500, whiteSpace: 'nowrap' as const, letterSpacing: '0.03em',
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredActive.map((order) => (
                        <OrderRow
                          key={order.id}
                          order={order}
                          updating={updatingId === order.id}
                          onDecision={updateDecision}
                          onPriority={togglePriority}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Collapsed sections */}
            {cancelledOrders.length > 0 && (
              <div style={{ ...card, overflow: 'hidden' }}>
                <button onClick={() => setShowCancelled(v => !v)} style={{
                  width: '100%', padding: '10px 16px',
                  background: 'none', border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                  color: 'var(--text3)', fontSize: 13, fontWeight: 500,
                }}>
                  {showCancelled ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  Cancelled orders ({cancelledOrders.length})
                </button>
                {showCancelled && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px' }}>
                    {cancelledOrders.map(o => (
                      <div key={o.id} style={{
                        padding: '5px 0', fontFamily: 'DM Mono', fontSize: 12,
                        color: 'var(--text3)', borderBottom: '1px solid var(--border)',
                        display: 'flex', gap: 16,
                      }}>
                        <span>{o.order_id}</span>
                        <span>{o.sku}</span>
                        <span>{o.customer_name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {dispatchedOrders.length > 0 && (
              <div style={{ ...card, overflow: 'hidden' }}>
                <button onClick={() => setShowDispatched(v => !v)} style={{
                  width: '100%', padding: '10px 16px',
                  background: 'none', border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                  color: 'var(--dispatched)', fontSize: 13, fontWeight: 500,
                }}>
                  {showDispatched ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  Already dispatched ({dispatchedOrders.length})
                </button>
                {showDispatched && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px' }}>
                    {dispatchedOrders.map(o => (
                      <div key={o.id} style={{
                        padding: '5px 0', fontFamily: 'DM Mono', fontSize: 12,
                        color: 'var(--dispatched)', borderBottom: '1px solid var(--border)',
                        display: 'flex', gap: 16,
                      }}>
                        <span>{o.order_id}</span>
                        <span>{o.sku}</span>
                        <span>{o.customer_name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ════════════════ PICKLIST TAB ════════════════ */}
        {tab === 'picklist' && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <h1 style={{ fontSize: 18, fontWeight: 600 }}>
                Picklist
              </h1>
              <span style={{ color: 'var(--text3)', fontSize: 14 }}>
                {dispatchTodayCount} orders · {picklist.reduce((s, i) => s + i.qty, 0)} pieces
              </span>
              <button onClick={() => window.print()} style={{
                marginLeft: 'auto',
                padding: '8px 16px', borderRadius: 7,
                background: 'var(--surface)', border: '1px solid var(--border)',
                color: 'var(--text)', fontSize: 13, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500,
              }}>
                <Printer size={14} /> Print Picklist
              </button>
            </div>

            {picklist.length === 0 ? (
              <div style={{ ...card, padding: 48, textAlign: 'center' as const, color: 'var(--text2)' }}>
                No orders marked "Dispatch Today" yet. Go to Plan tab and assign decisions first.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                {(['Bluedart', 'Delhivery'] as Courier[]).map(courier => {
                  const items = picklist.filter(p => p.courier === courier)
                  if (!items.length) return null
                  const totalQty = items.reduce((s, i) => s + i.qty, 0)
                  const courierColor = courier === 'Bluedart' ? '#2563eb' : '#7c3aed'
                  return (
                    <div key={courier} style={{ ...card, overflow: 'hidden' }}>
                      <div style={{
                        padding: '12px 20px',
                        borderBottom: '1px solid var(--border)',
                        background: 'var(--bg2)',
                        display: 'flex', alignItems: 'center', gap: 10,
                      }}>
                        <div style={{ width: 10, height: 10, borderRadius: '50%', background: courierColor }} />
                        <span style={{ fontFamily: 'DM Mono', fontWeight: 500, fontSize: 14 }}>{courier}</span>
                        <span style={{ marginLeft: 'auto', color: 'var(--text3)', fontSize: 12 }}>
                          {items.length} SKUs · {totalQty} pcs
                        </span>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse' as const }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <th style={{ padding: '8px 20px', textAlign: 'left' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500 }}>SKU</th>
                            <th style={{ padding: '8px 20px', textAlign: 'right' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500 }}>ORDERS</th>
                            <th style={{ padding: '8px 20px', textAlign: 'right' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500 }}>QTY</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((item, i) => (
                            <tr key={item.sku} style={{
                              borderBottom: i < items.length - 1 ? '1px solid var(--border)' : 'none',
                            }}>
                              <td style={{ padding: '10px 20px', fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text)' }}>{item.sku}</td>
                              <td style={{ padding: '10px 20px', textAlign: 'right' as const, color: 'var(--text2)', fontSize: 13 }}>{item.count}</td>
                              <td style={{ padding: '10px 20px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 600, color: courierColor, fontSize: 15 }}>{item.qty}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr style={{ borderTop: '2px solid var(--border2)', background: 'var(--bg2)' }}>
                            <td style={{ padding: '10px 20px', fontWeight: 600, fontSize: 13 }}>Total</td>
                            <td style={{ padding: '10px 20px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: 'var(--text2)' }}>{items.reduce((s, i) => s + i.count, 0)}</td>
                            <td style={{ padding: '10px 20px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, color: courierColor, fontSize: 18 }}>{totalQty}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ════════════════ EOD TAB ════════════════ */}
        {tab === 'eod' && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 24, maxWidth: 640 }}>
            <h1 style={{ fontSize: 18, fontWeight: 600 }}>
              End of Day — {activeSession?.label || 'No session'}
            </h1>

            {eodDone || activeSession?.is_eod_done ? (
              <div style={{
                ...card, padding: 32,
                border: '1px solid #bbf7d0',
                background: 'var(--dispatched-bg)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--dispatched)', marginBottom: 20 }}>
                  <CheckCircle size={22} />
                  <span style={{ fontWeight: 700, fontSize: 16 }}>EOD Confirmed</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
                  {[
                    { label: 'Dispatched', value: dispatchTodayCount, color: 'var(--dispatched)' },
                    { label: 'Held', value: holdCount, color: 'var(--hold)' },
                    { label: 'Unfulfillable', value: unfulfillableCount, color: 'var(--critical)' },
                  ].map(s => (
                    <div key={s.label} style={{ textAlign: 'center' as const }}>
                      <div style={{ fontSize: 32, fontFamily: 'DM Mono', fontWeight: 500, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
                <p style={{ color: 'var(--text2)', fontSize: 13, marginTop: 20 }}>
                  Held and unfulfillable orders will carry forward to tomorrow's session.
                </p>
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
                  {[
                    { label: 'Will Dispatch', value: dispatchTodayCount, color: 'var(--dispatched)', bg: 'var(--dispatched-bg)', icon: <CheckCircle size={18} /> },
                    { label: 'On Hold', value: holdCount, color: 'var(--hold)', bg: 'var(--hold-bg)', icon: <Clock size={18} /> },
                    { label: 'Unfulfillable', value: unfulfillableCount, color: 'var(--critical)', bg: 'var(--critical-bg)', icon: <AlertTriangle size={18} /> },
                  ].map(s => (
                    <div key={s.label} style={{
                      padding: 20, background: s.bg,
                      border: '1px solid var(--border)', borderRadius: 8, textAlign: 'center' as const,
                    }}>
                      <div style={{ color: s.color, display: 'flex', justifyContent: 'center', marginBottom: 8 }}>{s.icon}</div>
                      <div style={{ fontSize: 30, fontFamily: 'DM Mono', fontWeight: 500, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{s.label}</div>
                    </div>
                  ))}
                </div>

                {undecidedCount > 0 && (
                  <div style={{
                    padding: '12px 16px',
                    background: 'var(--today-bg)',
                    border: '1px solid #fed7aa',
                    borderRadius: 8, color: 'var(--today)', fontSize: 13,
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    <AlertTriangle size={15} />
                    {undecidedCount} orders still undecided — go to Plan tab before confirming EOD.
                  </div>
                )}

                <button
                  onClick={handleEOD}
                  disabled={dispatchTodayCount === 0}
                  style={{
                    padding: '11px 24px', borderRadius: 8,
                    background: dispatchTodayCount > 0 ? 'var(--dispatched)' : 'var(--bg2)',
                    border: 'none',
                    color: dispatchTodayCount > 0 ? '#fff' : 'var(--text3)',
                    fontWeight: 700, fontSize: 14,
                    cursor: dispatchTodayCount > 0 ? 'pointer' : 'not-allowed',
                    display: 'flex', alignItems: 'center', gap: 8, width: 'fit-content',
                    boxShadow: dispatchTodayCount > 0 ? '0 1px 3px rgba(22,163,74,0.3)' : 'none',
                  }}
                >
                  <CheckCircle size={16} />
                  Confirm EOD — Mark {dispatchTodayCount} as Dispatched
                </button>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

// ── Order Row ──
function OrderRow({ order, updating, onDecision, onPriority }: {
  order: DBOrder
  updating: boolean
  onDecision: (id: string, d: PlanDecision) => void
  onPriority: (id: string, current: boolean) => void
}) {
  const urgencyColors: Record<string, { color: string; bg: string; border: string }> = {
    CRITICAL: { color: 'var(--critical)', bg: 'var(--critical-bg)', border: '#fecaca' },
    TODAY:    { color: 'var(--today)',    bg: 'var(--today-bg)',    border: '#fed7aa' },
    PLAN:     { color: 'var(--plan)',     bg: 'var(--plan-bg)',     border: '#fde68a' },
    HOLD:     { color: 'var(--hold)',     bg: 'var(--hold-bg)',     border: '#bfdbfe' },
  }
  const uc = urgencyColors[order.urgency || 'HOLD']

  const rowBg: Record<PlanDecision, string> = {
    dispatch_today: '#f0fdf4',
    hold: '#eff6ff',
    unfulfillable: '#fef2f2',
    undecided: 'transparent',
  }

  return (
    <tr style={{
      borderBottom: '1px solid var(--border)',
      background: updating ? 'var(--accent-bg)' : rowBg[order.plan_decision],
      opacity: updating ? 0.7 : 1,
      transition: 'background 0.15s',
    }}>
      {/* Priority */}
      <td style={{ padding: '8px 12px', width: 36 }}>
        <button onClick={() => onPriority(order.id, order.is_priority)} style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          color: order.is_priority ? 'var(--accent)' : 'var(--border2)',
          transition: 'color 0.15s',
        }}>
          <Star size={14} fill={order.is_priority ? 'var(--accent)' : 'none'} />
        </button>
      </td>

      {/* Urgency badge */}
      <td style={{ padding: '8px 12px' }}>
        <span style={{
          display: 'inline-block',
          padding: '2px 8px', borderRadius: 4,
          fontSize: 10, fontFamily: 'DM Mono', fontWeight: 500, letterSpacing: '0.05em',
          color: uc.color, background: uc.bg, border: `1px solid ${uc.border}`,
        }}>
          {order.urgency || '—'}
        </span>
      </td>

      {/* Order ID */}
      <td style={{ padding: '8px 12px' }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>
          {order.order_id.length > 20 ? order.order_id.slice(0, 20) + '…' : order.order_id}
        </span>
      </td>

      {/* Customer */}
      <td style={{ padding: '8px 12px', maxWidth: 160 }}>
        <span style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', maxWidth: 150 }}>
          {order.customer_name}
        </span>
      </td>

      {/* SKU */}
      <td style={{ padding: '8px 12px' }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text)', background: 'var(--bg2)', padding: '2px 6px', borderRadius: 4 }}>
          {order.sku}
        </span>
      </td>

      {/* Courier */}
      <td style={{ padding: '8px 12px' }}>
        <span style={{
          fontSize: 10, fontFamily: 'DM Mono', fontWeight: 500,
          color: order.courier === 'Bluedart' ? '#2563eb' : '#7c3aed',
          background: order.courier === 'Bluedart' ? '#eff6ff' : '#f5f3ff',
          padding: '2px 7px', borderRadius: 4,
          border: `1px solid ${order.courier === 'Bluedart' ? '#bfdbfe' : '#e9d5ff'}`,
        }}>
          {order.courier === 'Bluedart' ? 'BD' : 'DL'}
        </span>
      </td>

      {/* Pincode · City */}
      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text)' }}>{order.pincode}</span>
        {order.city && <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 6 }}>{order.city}</span>}
      </td>

      {/* ODA */}
      <td style={{ padding: '8px 12px' }}>
        {order.oda === 'ODA' && (
          <span style={{ fontSize: 10, fontFamily: 'DM Mono', color: 'var(--today)', background: 'var(--today-bg)', padding: '1px 5px', borderRadius: 3, border: '1px solid #fed7aa' }}>ODA</span>
        )}
      </td>

      {/* Transit */}
      <td style={{ padding: '8px 12px', textAlign: 'center' as const }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text3)' }}>{order.transit_days}d</span>
      </td>

      {/* Promise date */}
      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text2)' }}>
          {order.promise_date
            ? new Date(order.promise_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
            : '—'}
        </span>
      </td>

      {/* Days left */}
      <td style={{ padding: '8px 12px', textAlign: 'center' as const }}>
        <span style={{
          fontFamily: 'DM Mono', fontSize: 14, fontWeight: 600,
          color: uc.color,
        }}>
          {order.days_left !== null ? order.days_left : '—'}
        </span>
      </td>

      {/* Decision buttons */}
      <td style={{ padding: '8px 12px' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {([
            { d: 'dispatch_today' as PlanDecision, label: 'Dispatch', ac: 'var(--dispatched)', ab: 'var(--dispatched-bg)', aborder: '#bbf7d0' },
            { d: 'hold' as PlanDecision, label: 'Hold', ac: 'var(--hold)', ab: 'var(--hold-bg)', aborder: '#bfdbfe' },
            { d: 'unfulfillable' as PlanDecision, label: 'Unfulfil.', ac: 'var(--critical)', ab: 'var(--critical-bg)', aborder: '#fecaca' },
          ]).map(({ d, label, ac, ab, aborder }) => {
            const isActive = order.plan_decision === d
            return (
              <button key={d} onClick={() => onDecision(order.id, d)} style={{
                padding: '4px 10px', borderRadius: 5, fontSize: 11,
                cursor: 'pointer', fontFamily: 'DM Sans', fontWeight: 500,
                background: isActive ? ab : 'var(--surface)',
                border: `1px solid ${isActive ? aborder : 'var(--border)'}`,
                color: isActive ? ac : 'var(--text3)',
                transition: 'all 0.1s',
                whiteSpace: 'nowrap' as const,
              }}>
                {label}
              </button>
            )
          })}
        </div>
      </td>
    </tr>
  )
}
