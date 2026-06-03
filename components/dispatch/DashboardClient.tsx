'use client'
import { useState, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { parseOrders } from '@/lib/parser'
import { DBOrder, DispatchSession, PlanDecision, UrgencyTier, Courier } from '@/types'
import { User } from '@supabase/supabase-js'
import { Star, Printer, CheckCircle, ChevronDown, ChevronUp, Upload, LogOut, Package, Truck, AlertTriangle, Clock, Calendar, RefreshCw } from 'lucide-react'

type Tab = 'import' | 'plan' | 'picklist' | 'eod'
type FilterTier = 'ALL' | UrgencyTier

interface Props {
  user: User
  initialSessions: DispatchSession[]
}

const URGENCY_ORDER: UrgencyTier[] = ['CRITICAL', 'TODAY', 'PLAN', 'HOLD']
const URGENCY_LABELS: Record<UrgencyTier, string> = {
  CRITICAL: 'CRITICAL',
  TODAY: 'TODAY',
  PLAN: 'PLAN',
  HOLD: 'HOLD',
}

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

  // Load orders for a session
  const loadOrders = useCallback(async (sessionId: string) => {
    setLoadingOrders(true)
    const { data } = await supabase
      .from('dispatch_orders')
      .select('*')
      .eq('session_id', sessionId)
      .order('urgency', { ascending: true })
    setOrders((data as DBOrder[]) || [])
    setLoadingOrders(false)
  }, [supabase])

  const selectSession = useCallback((s: DispatchSession) => {
    setActiveSession(s)
    loadOrders(s.id)
    setTab('plan')
  }, [loadOrders])

  // Create new session
  const createSession = async () => {
    const today = new Date().toISOString().split('T')[0]
    const label = `Dispatch ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`
    const { data, error } = await supabase
      .from('dispatch_sessions')
      .insert({ created_by: user.id, session_date: today, label })
      .select()
      .single()
    if (!error && data) {
      setSessions(prev => [data, ...prev])
      setActiveSession(data)
      setOrders([])
      setTab('import')
      setImportResult(null)
    }
  }

  // Import orders from pasted text
  const handleImport = async () => {
    if (!activeSession) return
    if (!delhiveryText.trim() && !bluedartText.trim()) return
    setImporting(true)
    setImportResult(null)

    const allParsed = [
      ...parseOrders(delhiveryText, 'Delhivery'),
      ...parseOrders(bluedartText, 'Bluedart'),
    ]

    if (allParsed.length === 0) {
      setImporting(false)
      return
    }

    // Check for existing order IDs in this session
    const { data: existing } = await supabase
      .from('dispatch_orders')
      .select('order_id')
      .eq('session_id', activeSession.id)

    const existingIds = new Set((existing || []).map((o: { order_id: string }) => o.order_id))
    const newOrders = allParsed.filter(o => !existingIds.has(o.order_id))

    if (newOrders.length > 0) {
      const rows = newOrders.map(o => ({
        session_id: activeSession.id,
        ...o,
        plan_decision: o.is_dispatched ? 'dispatch_today' : o.is_cancelled ? 'undecided' : 'undecided',
      }))
      await supabase.from('dispatch_orders').insert(rows)
      await loadOrders(activeSession.id)

      // Update session totals
      const total = (existing?.length || 0) + newOrders.length
      await supabase.from('dispatch_sessions').update({ total_orders: total }).eq('id', activeSession.id)
    }

    setImportResult({ added: newOrders.length, skipped: allParsed.length - newOrders.length })
    setImporting(false)
    setDelhiveryText('')
    setBluedartText('')
    if (newOrders.length > 0) setTab('plan')
  }

  // Update a single order's plan decision
  const updateDecision = async (orderId: string, decision: PlanDecision) => {
    setUpdatingId(orderId)
    await supabase
      .from('dispatch_orders')
      .update({ plan_decision: decision, updated_at: new Date().toISOString() })
      .eq('id', orderId)
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, plan_decision: decision } : o))
    setUpdatingId(null)
  }

  // Toggle priority
  const togglePriority = async (orderId: string, current: boolean) => {
    await supabase
      .from('dispatch_orders')
      .update({ is_priority: !current })
      .eq('id', orderId)
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, is_priority: !current } : o))
  }

  // EOD confirmation
  const handleEOD = async () => {
    if (!activeSession) return
    const dispatchedOrders = orders.filter(o => o.plan_decision === 'dispatch_today' && !o.is_cancelled)
    const now = new Date().toISOString()
    await supabase
      .from('dispatch_orders')
      .update({ dispatched_at: now, is_dispatched: true })
      .in('id', dispatchedOrders.map(o => o.id))

    const dispatched = dispatchedOrders.length
    const held = orders.filter(o => o.plan_decision === 'hold').length
    const unfulfillable = orders.filter(o => o.plan_decision === 'unfulfillable').length

    await supabase.from('dispatch_sessions').update({
      is_eod_done: true,
      dispatched_count: dispatched,
      held_count: held,
      unfulfillable_count: unfulfillable,
    }).eq('id', activeSession.id)

    setEodDone(true)
    await loadOrders(activeSession.id)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  // Computed lists
  const activeOrders = useMemo(() =>
    orders.filter(o => !o.is_cancelled && !o.is_dispatched),
    [orders]
  )

  const cancelledOrders = useMemo(() =>
    orders.filter(o => o.is_cancelled),
    [orders]
  )

  const dispatchedOrders = useMemo(() =>
    orders.filter(o => o.is_dispatched && !o.is_cancelled),
    [orders]
  )

  const filteredActive = useMemo(() => {
    let list = [...activeOrders]
    if (filterTier !== 'ALL') list = list.filter(o => o.urgency === filterTier)
    // Sort: priority first, then urgency tier, then days_left
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

  // Picklist
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
    activeOrders.forEach(o => {
      if (o.urgency) counts[o.urgency] = (counts[o.urgency] || 0) + 1
    })
    return counts
  }, [activeOrders])

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header style={{
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        padding: '0 24px',
        display: 'flex',
        alignItems: 'center',
        height: 52,
        gap: 16,
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 8 }}>
          <div style={{
            width: 26, height: 26, background: 'var(--accent)', borderRadius: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'IBM Plex Mono', fontWeight: 700, fontSize: 13, color: '#000'
          }}>D</div>
          <span style={{ fontFamily: 'IBM Plex Mono', fontWeight: 600, fontSize: 14 }}>DispatchLens</span>
        </div>

        {/* Tabs */}
        {(['import', 'plan', 'picklist', 'eod'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '4px 12px',
            borderRadius: 4,
            border: 'none',
            background: tab === t ? 'var(--surface2)' : 'transparent',
            color: tab === t ? 'var(--text)' : 'var(--text2)',
            cursor: 'pointer',
            fontSize: 13,
            fontFamily: 'IBM Plex Sans',
            borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
            textTransform: 'capitalize',
          }}>
            {t === 'eod' ? 'EOD' : t === 'plan' ? `Plan${activeOrders.length ? ` (${activeOrders.length})` : ''}` : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}

        <div style={{ flex: 1 }} />

        {/* Session selector */}
        {activeSession && (
          <span style={{ color: 'var(--text2)', fontSize: 12, fontFamily: 'IBM Plex Mono' }}>
            {activeSession.label}
          </span>
        )}

        <button onClick={handleSignOut} style={{
          background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 4, fontSize: 12,
        }}>
          <LogOut size={14} />
        </button>
      </header>

      <main style={{ flex: 1, padding: 24, maxWidth: 1400, margin: '0 auto', width: '100%' }}>

        {/* ── IMPORT TAB ── */}
        {tab === 'import' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {/* Session management */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h2 style={{ fontFamily: 'IBM Plex Mono', fontSize: 16, fontWeight: 600 }}>
                {activeSession ? `Session: ${activeSession.label}` : 'No active session'}
              </h2>
              <button onClick={createSession} style={{
                padding: '6px 14px', borderRadius: 5,
                background: 'var(--accent)', border: 'none',
                color: '#000', fontWeight: 600, fontSize: 13, cursor: 'pointer',
              }}>+ New Session</button>
              {sessions.length > 1 && (
                <select onChange={e => {
                  const s = sessions.find(x => x.id === e.target.value)
                  if (s) selectSession(s)
                }} value={activeSession?.id || ''} style={{
                  background: 'var(--surface2)', border: '1px solid var(--border)',
                  color: 'var(--text)', padding: '6px 10px', borderRadius: 5, fontSize: 13,
                }}>
                  {sessions.map(s => (
                    <option key={s.id} value={s.id}>{s.label} ({s.total_orders} orders)</option>
                  ))}
                </select>
              )}
            </div>

            {!activeSession && (
              <div style={{ color: 'var(--text2)', padding: 24, textAlign: 'center' }}>
                Create a new session to start planning today's dispatches.
              </div>
            )}

            {activeSession && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                {/* Delhivery paste */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label style={{ fontSize: 12, fontFamily: 'IBM Plex Mono', color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Truck size={13} /> DELHIVERY — paste from planning sheet
                  </label>
                  <textarea
                    value={delhiveryText}
                    onChange={e => setDelhiveryText(e.target.value)}
                    placeholder="Copy rows from Delhivery planning sheet and paste here (include header row)"
                    style={{
                      height: 240, width: '100%', padding: 12,
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      borderRadius: 6, color: 'var(--text)', fontFamily: 'IBM Plex Mono',
                      fontSize: 12, resize: 'vertical', outline: 'none',
                    }}
                    onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                  <span style={{ color: 'var(--text3)', fontSize: 11 }}>
                    {delhiveryText.trim() ? `~${delhiveryText.trim().split('\n').length - 1} rows` : 'No data pasted'}
                  </span>
                </div>

                {/* Bluedart paste */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label style={{ fontSize: 12, fontFamily: 'IBM Plex Mono', color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Package size={13} /> BLUEDART — paste from planning sheet
                  </label>
                  <textarea
                    value={bluedartText}
                    onChange={e => setBluedartText(e.target.value)}
                    placeholder="Copy rows from Bluedart planning sheet and paste here (include header row)"
                    style={{
                      height: 240, width: '100%', padding: 12,
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      borderRadius: 6, color: 'var(--text)', fontFamily: 'IBM Plex Mono',
                      fontSize: 12, resize: 'vertical', outline: 'none',
                    }}
                    onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                  <span style={{ color: 'var(--text3)', fontSize: 11 }}>
                    {bluedartText.trim() ? `~${bluedartText.trim().split('\n').length - 1} rows` : 'No data pasted'}
                  </span>
                </div>
              </div>
            )}

            {activeSession && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <button
                  onClick={handleImport}
                  disabled={importing || (!delhiveryText.trim() && !bluedartText.trim())}
                  style={{
                    padding: '10px 24px', borderRadius: 6,
                    background: importing ? 'var(--surface2)' : 'var(--accent)',
                    border: 'none', color: importing ? 'var(--text2)' : '#000',
                    fontWeight: 600, fontSize: 14, cursor: importing ? 'not-allowed' : 'pointer',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}
                >
                  <Upload size={15} />
                  {importing ? 'Importing…' : 'Import Orders'}
                </button>

                {importResult && (
                  <span style={{ color: 'var(--dispatched)', fontSize: 13 }}>
                    ✓ {importResult.added} orders imported
                    {importResult.skipped > 0 && `, ${importResult.skipped} skipped (duplicates)`}
                  </span>
                )}

                {orders.length > 0 && (
                  <button onClick={() => setTab('plan')} style={{
                    padding: '10px 20px', borderRadius: 6,
                    background: 'var(--surface2)', border: '1px solid var(--border2)',
                    color: 'var(--text)', fontSize: 13, cursor: 'pointer',
                  }}>
                    View Plan →
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── PLAN TAB ── */}
        {tab === 'plan' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Stats bar */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[
                { label: 'Total Active', value: activeOrders.length, color: 'var(--text)' },
                { label: 'Undecided', value: undecidedCount, color: undecidedCount > 0 ? 'var(--today)' : 'var(--text2)' },
                { label: 'Dispatch Today', value: dispatchTodayCount, color: 'var(--dispatched)' },
                { label: 'Hold', value: holdCount, color: 'var(--hold)' },
                { label: 'Unfulfillable', value: unfulfillableCount, color: 'var(--critical)' },
              ].map(s => (
                <div key={s.label} style={{
                  padding: '8px 16px', background: 'var(--surface)',
                  border: '1px solid var(--border)', borderRadius: 6,
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}>
                  <span style={{ color: s.color, fontFamily: 'IBM Plex Mono', fontSize: 20, fontWeight: 600 }}>{s.value}</span>
                  <span style={{ color: 'var(--text3)', fontSize: 11 }}>{s.label}</span>
                </div>
              ))}

              <div style={{ flex: 1 }} />

              {/* Reload */}
              {activeSession && (
                <button onClick={() => loadOrders(activeSession.id)} style={{
                  background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                  color: 'var(--text2)', cursor: 'pointer', padding: '8px 12px',
                  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
                }}>
                  <RefreshCw size={13} /> Refresh
                </button>
              )}
            </div>

            {/* Urgency filter */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(['ALL', ...URGENCY_ORDER] as FilterTier[]).map(tier => (
                <button key={tier} onClick={() => setFilterTier(tier)} style={{
                  padding: '4px 12px', borderRadius: 4,
                  border: filterTier === tier ? '1px solid var(--accent)' : '1px solid var(--border)',
                  background: filterTier === tier ? 'rgba(240,160,32,0.1)' : 'transparent',
                  color: tier === 'ALL' ? 'var(--text)' : `var(--${tier === 'CRITICAL' ? 'critical' : tier === 'TODAY' ? 'today' : tier === 'PLAN' ? 'plan' : 'hold'})`,
                  fontSize: 12, fontFamily: 'IBM Plex Mono', cursor: 'pointer',
                }}>
                  {tier}{tier !== 'ALL' && tierCounts[tier] ? ` (${tierCounts[tier]})` : ''}
                </button>
              ))}
            </div>

            {/* Orders table */}
            {loadingOrders ? (
              <div style={{ color: 'var(--text2)', padding: 40, textAlign: 'center' }}>Loading orders…</div>
            ) : filteredActive.length === 0 ? (
              <div style={{ color: 'var(--text2)', padding: 40, textAlign: 'center' }}>
                {activeOrders.length === 0 ? 'No orders imported yet. Go to Import tab.' : 'No orders match filter.'}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border2)' }}>
                      {['★', 'Urgency', 'Order ID', 'Customer', 'SKU', 'Courier', 'Pincode / City', 'Transit', 'Promise', 'Days Left', 'Decision'].map(h => (
                        <th key={h} style={{
                          padding: '8px 10px', textAlign: 'left',
                          color: 'var(--text3)', fontSize: 11, fontFamily: 'IBM Plex Mono',
                          fontWeight: 500, whiteSpace: 'nowrap',
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredActive.map((order, idx) => (
                      <OrderRow
                        key={order.id}
                        order={order}
                        idx={idx}
                        updating={updatingId === order.id}
                        onDecision={updateDecision}
                        onPriority={togglePriority}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Cancelled section */}
            {cancelledOrders.length > 0 && (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <button onClick={() => setShowCancelled(v => !v)} style={{
                  background: 'none', border: 'none', color: 'var(--text3)',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
                }}>
                  {showCancelled ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  Cancelled ({cancelledOrders.length})
                </button>
                {showCancelled && (
                  <div style={{ marginTop: 8, color: 'var(--text3)', fontSize: 12, fontFamily: 'IBM Plex Mono' }}>
                    {cancelledOrders.map(o => (
                      <div key={o.id} style={{ padding: '4px 0' }}>
                        {o.order_id} — {o.sku} — {o.customer_name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Already dispatched section */}
            {dispatchedOrders.length > 0 && (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <button onClick={() => setShowDispatched(v => !v)} style={{
                  background: 'none', border: 'none', color: 'var(--text3)',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
                }}>
                  {showDispatched ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  Already Dispatched ({dispatchedOrders.length})
                </button>
                {showDispatched && (
                  <div style={{ marginTop: 8, color: 'var(--dispatched)', fontSize: 12, fontFamily: 'IBM Plex Mono' }}>
                    {dispatchedOrders.map(o => (
                      <div key={o.id} style={{ padding: '4px 0' }}>
                        {o.order_id} — {o.sku} — {o.customer_name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── PICKLIST TAB ── */}
        {tab === 'picklist' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <h2 style={{ fontFamily: 'IBM Plex Mono', fontSize: 16, fontWeight: 600 }}>
                Picklist — {dispatchTodayCount} orders to dispatch
              </h2>
              <button onClick={() => window.print()} style={{
                padding: '6px 14px', borderRadius: 5,
                background: 'var(--surface2)', border: '1px solid var(--border2)',
                color: 'var(--text)', fontSize: 13, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <Printer size={13} /> Print
              </button>
            </div>

            {picklist.length === 0 ? (
              <p style={{ color: 'var(--text2)' }}>No orders marked "Dispatch Today" yet. Go to Plan tab.</p>
            ) : (
              <>
                {(['Bluedart', 'Delhivery'] as Courier[]).map(courier => {
                  const items = picklist.filter(p => p.courier === courier)
                  if (!items.length) return null
                  const totalQty = items.reduce((s, i) => s + i.qty, 0)
                  return (
                    <div key={courier} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                      <div style={{
                        padding: '10px 16px', borderBottom: '1px solid var(--border)',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        background: 'var(--surface2)',
                      }}>
                        <span style={{ fontFamily: 'IBM Plex Mono', fontWeight: 600, fontSize: 14 }}>{courier}</span>
                        <span style={{ color: 'var(--text2)', fontSize: 12 }}>{items.length} SKUs · {totalQty} pieces</span>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <th style={{ padding: '8px 16px', textAlign: 'left', color: 'var(--text3)', fontSize: 11, fontFamily: 'IBM Plex Mono', fontWeight: 500 }}>SKU</th>
                            <th style={{ padding: '8px 16px', textAlign: 'right', color: 'var(--text3)', fontSize: 11, fontFamily: 'IBM Plex Mono', fontWeight: 500 }}>ORDERS</th>
                            <th style={{ padding: '8px 16px', textAlign: 'right', color: 'var(--text3)', fontSize: 11, fontFamily: 'IBM Plex Mono', fontWeight: 500 }}>QTY</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((item, i) => (
                            <tr key={item.sku} style={{ borderBottom: i < items.length - 1 ? '1px solid var(--border)' : 'none' }}>
                              <td style={{ padding: '10px 16px', fontFamily: 'IBM Plex Mono', color: 'var(--text)' }}>{item.sku}</td>
                              <td style={{ padding: '10px 16px', textAlign: 'right', color: 'var(--text2)' }}>{item.count}</td>
                              <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'IBM Plex Mono', fontWeight: 600, color: 'var(--accent)' }}>{item.qty}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr style={{ borderTop: '1px solid var(--border2)' }}>
                            <td style={{ padding: '10px 16px', color: 'var(--text2)', fontSize: 12 }}>TOTAL</td>
                            <td style={{ padding: '10px 16px', textAlign: 'right', color: 'var(--text2)', fontFamily: 'IBM Plex Mono' }}>{items.reduce((s, i) => s + i.count, 0)}</td>
                            <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'IBM Plex Mono', fontWeight: 700, color: 'var(--accent)', fontSize: 16 }}>{totalQty}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )
                })}
              </>
            )}
          </div>
        )}

        {/* ── EOD TAB ── */}
        {tab === 'eod' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 600 }}>
            <h2 style={{ fontFamily: 'IBM Plex Mono', fontSize: 16, fontWeight: 600 }}>
              End of Day — {activeSession?.label || 'No session'}
            </h2>

            {eodDone || activeSession?.is_eod_done ? (
              <div style={{
                padding: 24, background: 'rgba(34,197,94,0.08)',
                border: '1px solid rgba(34,197,94,0.3)', borderRadius: 8,
                display: 'flex', flexDirection: 'column', gap: 12,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dispatched)' }}>
                  <CheckCircle size={20} />
                  <span style={{ fontFamily: 'IBM Plex Mono', fontWeight: 600 }}>EOD Complete</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  {[
                    { label: 'Dispatched', value: dispatchTodayCount, color: 'var(--dispatched)' },
                    { label: 'Held', value: holdCount, color: 'var(--hold)' },
                    { label: 'Unfulfillable', value: unfulfillableCount, color: 'var(--critical)' },
                  ].map(s => (
                    <div key={s.label} style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 28, fontFamily: 'IBM Plex Mono', fontWeight: 700, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 12, color: 'var(--text3)' }}>{s.label}</div>
                    </div>
                  ))}
                </div>
                <p style={{ color: 'var(--text2)', fontSize: 13 }}>
                  Held and unfulfillable orders will carry forward to tomorrow's session.
                </p>
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  {[
                    { label: 'Will Dispatch', value: dispatchTodayCount, color: 'var(--dispatched)', icon: <CheckCircle size={16} /> },
                    { label: 'On Hold', value: holdCount, color: 'var(--hold)', icon: <Clock size={16} /> },
                    { label: 'Unfulfillable', value: unfulfillableCount, color: 'var(--critical)', icon: <AlertTriangle size={16} /> },
                  ].map(s => (
                    <div key={s.label} style={{
                      padding: 16, background: 'var(--surface)',
                      border: '1px solid var(--border)', borderRadius: 8, textAlign: 'center',
                    }}>
                      <div style={{ color: s.color, marginBottom: 6, display: 'flex', justifyContent: 'center' }}>{s.icon}</div>
                      <div style={{ fontSize: 28, fontFamily: 'IBM Plex Mono', fontWeight: 700, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{s.label}</div>
                    </div>
                  ))}
                </div>

                {undecidedCount > 0 && (
                  <div style={{
                    padding: 12, background: 'rgba(249,115,22,0.08)',
                    border: '1px solid rgba(249,115,22,0.3)', borderRadius: 6,
                    color: 'var(--today)', fontSize: 13,
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    <AlertTriangle size={14} />
                    {undecidedCount} orders still undecided. Go to Plan tab before confirming EOD.
                  </div>
                )}

                <button
                  onClick={handleEOD}
                  disabled={dispatchTodayCount === 0}
                  style={{
                    padding: '12px 24px', borderRadius: 6,
                    background: dispatchTodayCount > 0 ? 'var(--dispatched)' : 'var(--surface2)',
                    border: 'none',
                    color: dispatchTodayCount > 0 ? '#000' : 'var(--text3)',
                    fontWeight: 700, fontSize: 14, cursor: dispatchTodayCount > 0 ? 'pointer' : 'not-allowed',
                    display: 'flex', alignItems: 'center', gap: 8, width: 'fit-content',
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

// ── Order Row Component ──
function OrderRow({ order, idx, updating, onDecision, onPriority }: {
  order: DBOrder
  idx: number
  updating: boolean
  onDecision: (id: string, d: PlanDecision) => void
  onPriority: (id: string, current: boolean) => void
}) {
  const tierColor = {
    CRITICAL: 'var(--critical)',
    TODAY: 'var(--today)',
    PLAN: 'var(--plan)',
    HOLD: 'var(--hold)',
  }[order.urgency || 'HOLD'] || 'var(--text3)'

  const decisionBg: Record<PlanDecision, string> = {
    dispatch_today: 'rgba(34,197,94,0.08)',
    hold: 'rgba(59,130,246,0.06)',
    unfulfillable: 'rgba(239,68,68,0.06)',
    undecided: 'transparent',
  }

  return (
    <tr style={{
      borderBottom: '1px solid var(--border)',
      background: updating ? 'rgba(240,160,32,0.05)' : decisionBg[order.plan_decision],
      opacity: updating ? 0.6 : 1,
    }}>
      {/* Priority star */}
      <td style={{ padding: '8px 10px', width: 32 }}>
        <button onClick={() => onPriority(order.id, order.is_priority)} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: order.is_priority ? 'var(--accent)' : 'var(--border2)',
          padding: 0,
        }}>
          <Star size={14} fill={order.is_priority ? 'var(--accent)' : 'none'} />
        </button>
      </td>

      {/* Urgency */}
      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
        <span style={{
          fontSize: 10, fontFamily: 'IBM Plex Mono', fontWeight: 600,
          color: tierColor, letterSpacing: '0.05em',
        }}>
          {order.urgency || '—'}
        </span>
      </td>

      {/* Order ID */}
      <td style={{ padding: '8px 10px' }}>
        <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 11, color: 'var(--text2)' }}>
          {order.order_id.length > 18 ? order.order_id.slice(0, 18) + '…' : order.order_id}
        </span>
      </td>

      {/* Customer */}
      <td style={{ padding: '8px 10px', maxWidth: 160 }}>
        <span style={{ fontSize: 12, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>
          {order.customer_name}
        </span>
      </td>

      {/* SKU */}
      <td style={{ padding: '8px 10px' }}>
        <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 11, color: 'var(--text)' }}>
          {order.sku}
        </span>
      </td>

      {/* Courier */}
      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
        <span style={{
          fontSize: 10, fontFamily: 'IBM Plex Mono',
          color: order.courier === 'Bluedart' ? '#60a5fa' : '#a78bfa',
          background: order.courier === 'Bluedart' ? 'rgba(96,165,250,0.1)' : 'rgba(167,139,250,0.1)',
          padding: '2px 6px', borderRadius: 3,
        }}>
          {order.courier === 'Bluedart' ? 'BD' : 'DL'}
        </span>
      </td>

      {/* Pincode / City */}
      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
        <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 11, color: 'var(--text2)' }}>
          {order.pincode}
        </span>
        {order.city && (
          <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 4 }}>
            {order.city}
          </span>
        )}
        {order.oda === 'ODA' && (
          <span style={{ fontSize: 10, color: 'var(--today)', marginLeft: 4 }}>ODA</span>
        )}
      </td>

      {/* Transit */}
      <td style={{ padding: '8px 10px', textAlign: 'center' }}>
        <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 12, color: 'var(--text3)' }}>
          {order.transit_days}d
        </span>
      </td>

      {/* Promise date */}
      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
        <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 11, color: 'var(--text2)' }}>
          {order.promise_date ? new Date(order.promise_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}
        </span>
      </td>

      {/* Days left */}
      <td style={{ padding: '8px 10px', textAlign: 'center' }}>
        <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 13, fontWeight: 600, color: tierColor }}>
          {order.days_left !== null ? order.days_left : '—'}
        </span>
      </td>

      {/* Decision buttons */}
      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {([
            { d: 'dispatch_today' as PlanDecision, label: 'Dispatch', activeColor: 'var(--dispatched)' },
            { d: 'hold' as PlanDecision, label: 'Hold', activeColor: 'var(--hold)' },
            { d: 'unfulfillable' as PlanDecision, label: 'Unful.', activeColor: 'var(--critical)' },
          ]).map(({ d, label, activeColor }) => (
            <button key={d} onClick={() => onDecision(order.id, d)} style={{
              padding: '3px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
              fontFamily: 'IBM Plex Sans', fontWeight: 500,
              background: order.plan_decision === d ? activeColor : 'var(--surface2)',
              border: `1px solid ${order.plan_decision === d ? activeColor : 'var(--border)'}`,
              color: order.plan_decision === d ? '#000' : 'var(--text3)',
              transition: 'all 0.1s',
            }}>
              {label}
            </button>
          ))}
        </div>
      </td>
    </tr>
  )
}
