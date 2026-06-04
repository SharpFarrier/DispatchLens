'use client'
import { useState, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { parseOrders } from '@/lib/parser'
import { DBOrder, DispatchSession, PlanDecision, UrgencyTier, Courier } from '@/types'
import { User } from '@supabase/supabase-js'
import {
  Star, Printer, CheckCircle, ChevronDown, ChevronUp,
  Upload, LogOut, Package, Truck, AlertTriangle, Clock,
  RefreshCw, Plus, ArrowRight, X, AlertCircle
} from 'lucide-react'

type Tab = 'import' | 'plan' | 'picklist' | 'eod'
type FilterTier = 'ALL' | UrgencyTier
type ActiveFilter = FilterTier | 'dispatch_today' | 'hold' | 'unfulfillable' | 'undecided'

interface Props {
  user: User
  initialSessions: DispatchSession[]
}

const URGENCY_ORDER: UrgencyTier[] = ['CRITICAL', 'TODAY', 'PLAN', 'HOLD']

// ── Modal ──
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.25)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, padding: 28, minWidth: 440, maxWidth: 600,
        boxShadow: '0 20px 40px rgba(0,0,0,0.12)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 4 }}>
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
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

  // Plan tab state
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('ALL')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDecision, setBulkDecision] = useState<PlanDecision | ''>('')
  const [showBulkConfirm, setShowBulkConfirm] = useState(false)
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set())

  // Picklist state
  const [showUnfulfillableModal, setShowUnfulfillableModal] = useState(false)
  const [unfulfillableSku, setUnfulfillableSku] = useState<string | null>(null)

  // EOD state
  const [shypassistText, setShypassistText] = useState('')
  const [eodMatchResult, setEodMatchResult] = useState<{
    matched: Array<{ orderId: string; sku: string; awb: string; customerName: string }>
    unmatched: Array<{ orderId: string; sku: string; customerName: string }>
  } | null>(null)
  const [showEodConfirm, setShowEodConfirm] = useState(false)
  const [eodDone, setEodDone] = useState(false)

  // Collapsed sections
  const [showCancelled, setShowCancelled] = useState(false)
  const [showDispatched, setShowDispatched] = useState(false)

  const card = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  }

  // ── Data loading ──
  const loadOrders = useCallback(async (sessionId: string) => {
    setLoadingOrders(true)
    const { data } = await supabase.from('dispatch_orders').select('*').eq('session_id', sessionId)
    setOrders((data as DBOrder[]) || [])
    setLoadingOrders(false)
    setSelectedIds(new Set())
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
      .from('dispatch_sessions').insert({ created_by: user.id, session_date: today, label })
      .select().single()
    if (!error && data) {
      setSessions(prev => [data, ...prev])
      setActiveSession(data)
      setOrders([])
      setTab('import')
      setImportResult(null)
    }
  }

  // ── Import ──
  const handleImport = async () => {
    if (!activeSession || (!delhiveryText.trim() && !bluedartText.trim())) return
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

  // ── Single decision ──
  const updateDecision = async (orderId: string, decision: PlanDecision) => {
    setUpdatingIds(prev => new Set(prev).add(orderId))
    await supabase.from('dispatch_orders')
      .update({ plan_decision: decision, updated_at: new Date().toISOString() })
      .eq('id', orderId)
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, plan_decision: decision } : o))
    setUpdatingIds(prev => { const n = new Set(prev); n.delete(orderId); return n })
  }

  // ── Bulk decision ──
  const handleBulkDecisionConfirm = async () => {
    if (!bulkDecision || selectedIds.size === 0) return
    const ids = Array.from(selectedIds)
    ids.forEach(id => setUpdatingIds(prev => new Set(prev).add(id)))
    await supabase.from('dispatch_orders')
      .update({ plan_decision: bulkDecision, updated_at: new Date().toISOString() })
      .in('id', ids)
    setOrders(prev => prev.map(o => selectedIds.has(o.id) ? { ...o, plan_decision: bulkDecision as PlanDecision } : o))
    setUpdatingIds(new Set())
    setSelectedIds(new Set())
    setBulkDecision('')
    setShowBulkConfirm(false)
  }

  const togglePriority = async (orderId: string, current: boolean) => {
    await supabase.from('dispatch_orders').update({ is_priority: !current }).eq('id', orderId)
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, is_priority: !current } : o))
  }

  // ── Unfulfillable by SKU (from picklist) ──
  const handleUnfulfillableSku = async () => {
    if (!unfulfillableSku || !activeSession) return
    const affectedIds = orders
      .filter(o => o.sku === unfulfillableSku && !o.is_cancelled && !o.is_dispatched)
      .map(o => o.id)
    if (affectedIds.length > 0) {
      await supabase.from('dispatch_orders')
        .update({ plan_decision: 'unfulfillable', updated_at: new Date().toISOString() })
        .in('id', affectedIds)
      setOrders(prev => prev.map(o =>
        affectedIds.includes(o.id) ? { ...o, plan_decision: 'unfulfillable' } : o
      ))
    }
    setShowUnfulfillableModal(false)
    setUnfulfillableSku(null)
  }

  // ── EOD: parse Shypassist and match ──
  const parseShypassist = () => {
    const lines = shypassistText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) return

    // Parse AWB entries: SKU -> [AWB, AWB, ...]
    const skuAwbs: Record<string, string[]> = {}
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t')
      if (cols.length < 3) continue
      const sku = cols[0].trim()
      const awb = cols[2].trim()
      if (!sku || !awb) continue
      if (!skuAwbs[sku]) skuAwbs[sku] = []
      skuAwbs[sku].push(awb)
    }

    // Get today's "dispatch_today" orders that aren't already dispatched
    const toDispatch = orders.filter(o =>
      o.plan_decision === 'dispatch_today' && !o.is_cancelled && !o.is_dispatched
    )

    // Group orders by SKU, maintain order
    const ordersBySku: Record<string, DBOrder[]> = {}
    toDispatch.forEach(o => {
      if (!ordersBySku[o.sku]) ordersBySku[o.sku] = []
      ordersBySku[o.sku].push(o)
    })

    // Match positionally
    const matched: Array<{ orderId: string; sku: string; awb: string; customerName: string }> = []
    const unmatched: Array<{ orderId: string; sku: string; customerName: string }> = []

    toDispatch.forEach(order => {
      const awbList = skuAwbs[order.sku]
      const orderList = ordersBySku[order.sku]
      const idx = orderList.indexOf(order)
      if (awbList && awbList[idx]) {
        matched.push({ orderId: order.id, sku: order.sku, awb: awbList[idx], customerName: order.customer_name })
      } else {
        unmatched.push({ orderId: order.id, sku: order.sku, customerName: order.customer_name })
      }
    })

    setEodMatchResult({ matched, unmatched })
    setShowEodConfirm(true)
  }

  const confirmEOD = async () => {
    if (!eodMatchResult || !activeSession) return
    const now = new Date().toISOString()

    // Mark matched as dispatched with AWB
    for (const m of eodMatchResult.matched) {
      await supabase.from('dispatch_orders')
        .update({ is_dispatched: true, dispatched_at: now, tracking_number: m.awb })
        .eq('id', m.orderId)
    }

    await supabase.from('dispatch_sessions').update({
      is_eod_done: true,
      dispatched_count: eodMatchResult.matched.length,
      held_count: orders.filter(o => o.plan_decision === 'hold').length,
      unfulfillable_count: orders.filter(o => o.plan_decision === 'unfulfillable').length,
    }).eq('id', activeSession.id)

    await loadOrders(activeSession.id)
    setShowEodConfirm(false)
    setEodDone(true)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  // ── Computed ──
  const activeOrders = useMemo(() => orders.filter(o => !o.is_cancelled && !o.is_dispatched), [orders])
  const cancelledOrders = useMemo(() => orders.filter(o => o.is_cancelled), [orders])
  const dispatchedOrders = useMemo(() => orders.filter(o => o.is_dispatched && !o.is_cancelled), [orders])

  const dispatchTodayCount = useMemo(() => orders.filter(o => o.plan_decision === 'dispatch_today' && !o.is_cancelled && !o.is_dispatched).length, [orders])
  const holdCount = useMemo(() => orders.filter(o => o.plan_decision === 'hold' && !o.is_cancelled).length, [orders])
  const unfulfillableCount = useMemo(() => orders.filter(o => o.plan_decision === 'unfulfillable' && !o.is_cancelled).length, [orders])
  const undecidedCount = useMemo(() => activeOrders.filter(o => o.plan_decision === 'undecided').length, [activeOrders])

  const tierCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    activeOrders.forEach(o => { if (o.urgency) counts[o.urgency] = (counts[o.urgency] || 0) + 1 })
    return counts
  }, [activeOrders])

  const filteredActive = useMemo(() => {
    let list = [...activeOrders]
    if (activeFilter === 'dispatch_today') list = list.filter(o => o.plan_decision === 'dispatch_today')
    else if (activeFilter === 'hold') list = list.filter(o => o.plan_decision === 'hold')
    else if (activeFilter === 'unfulfillable') list = list.filter(o => o.plan_decision === 'unfulfillable')
    else if (activeFilter === 'undecided') list = list.filter(o => o.plan_decision === 'undecided')
    else if (activeFilter !== 'ALL') list = list.filter(o => o.urgency === activeFilter)
    const tierOrder: Record<string, number> = { CRITICAL: 0, TODAY: 1, PLAN: 2, HOLD: 3 }
    list.sort((a, b) => {
      if (a.is_priority !== b.is_priority) return a.is_priority ? -1 : 1
      const ta = tierOrder[a.urgency || 'HOLD'] ?? 3
      const tb = tierOrder[b.urgency || 'HOLD'] ?? 3
      if (ta !== tb) return ta - tb
      return (a.days_left ?? 99) - (b.days_left ?? 99)
    })
    return list
  }, [activeOrders, activeFilter])

  const picklist = useMemo(() => {
    const dispatchToday = orders.filter(o => o.plan_decision === 'dispatch_today' && !o.is_cancelled && !o.is_dispatched)
    const skuMap: Record<string, { sku: string; courier: Courier; qty: number; count: number; isUnfulfillable: boolean }> = {}
    dispatchToday.forEach(o => {
      const key = `${o.sku}__${o.courier}`
      if (!skuMap[key]) skuMap[key] = { sku: o.sku, courier: o.courier as Courier, qty: 0, count: 0, isUnfulfillable: false }
      skuMap[key].qty += o.qty
      skuMap[key].count += 1
    })
    return Object.values(skuMap).sort((a, b) => a.sku.localeCompare(b.sku))
  }, [orders])

  // ── Selection helpers ──
  const allVisibleSelected = filteredActive.length > 0 && filteredActive.every(o => selectedIds.has(o.id))
  const someSelected = selectedIds.size > 0

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedIds(prev => {
        const n = new Set(prev)
        filteredActive.forEach(o => n.delete(o.id))
        return n
      })
    } else {
      setSelectedIds(prev => {
        const n = new Set(prev)
        filteredActive.forEach(o => n.add(o.id))
        return n
      })
    }
  }

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  // ── Urgency filter toggle ──
  const toggleFilter = (f: ActiveFilter) => {
    setActiveFilter(prev => prev === f ? 'ALL' : f)
    setSelectedIds(new Set())
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' as const }}>

      {/* ── Bulk confirm modal ── */}
      {showBulkConfirm && bulkDecision && (
        <Modal title={`Apply to ${selectedIds.size} orders`} onClose={() => setShowBulkConfirm(false)}>
          <p style={{ color: 'var(--text2)', marginBottom: 20, fontSize: 14 }}>
            Mark <strong style={{ color: 'var(--text)' }}>{selectedIds.size} selected orders</strong> as{' '}
            <strong style={{ color: bulkDecision === 'dispatch_today' ? 'var(--dispatched)' : bulkDecision === 'hold' ? 'var(--hold)' : 'var(--critical)' }}>
              {bulkDecision === 'dispatch_today' ? 'Dispatch Today' : bulkDecision === 'hold' ? 'On Hold' : 'Unfulfillable'}
            </strong>?
          </p>
          <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 20, border: '1px solid var(--border)', borderRadius: 6 }}>
            {Array.from(selectedIds).map(id => {
              const o = orders.find(x => x.id === id)
              if (!o) return null
              return (
                <div key={id} style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, fontFamily: 'DM Mono', display: 'flex', gap: 12, color: 'var(--text2)' }}>
                  <span style={{ color: 'var(--text)' }}>{o.customer_name}</span>
                  <span>{o.sku}</span>
                  <span style={{ color: 'var(--text3)' }}>{o.courier}</span>
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => setShowBulkConfirm(false)} style={{
              padding: '8px 18px', borderRadius: 7, border: '1px solid var(--border)',
              background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer', fontSize: 13,
            }}>Cancel</button>
            <button onClick={handleBulkDecisionConfirm} style={{
              padding: '8px 18px', borderRadius: 7, border: 'none',
              background: bulkDecision === 'dispatch_today' ? 'var(--dispatched)' : bulkDecision === 'hold' ? 'var(--hold)' : 'var(--critical)',
              color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
            }}>Confirm</button>
          </div>
        </Modal>
      )}

      {/* ── Unfulfillable SKU modal ── */}
      {showUnfulfillableModal && unfulfillableSku && (
        <Modal title="Mark SKU Unfulfillable" onClose={() => { setShowUnfulfillableModal(false); setUnfulfillableSku(null) }}>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontFamily: 'DM Mono', fontSize: 13, background: 'var(--bg2)', padding: '8px 12px', borderRadius: 6, marginBottom: 12, color: 'var(--text)' }}>
              {unfulfillableSku}
            </div>
            <p style={{ color: 'var(--text2)', fontSize: 14, marginBottom: 12 }}>
              The following orders will be marked <strong style={{ color: 'var(--critical)' }}>Unfulfillable</strong>:
            </p>
            <div style={{ border: '1px solid var(--border)', borderRadius: 6, maxHeight: 200, overflowY: 'auto' }}>
              {orders.filter(o => o.sku === unfulfillableSku && !o.is_cancelled && !o.is_dispatched).map(o => (
                <div key={o.id} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, fontFamily: 'DM Mono', display: 'flex', gap: 12, color: 'var(--text2)' }}>
                  <span style={{ color: 'var(--text)' }}>{o.customer_name}</span>
                  <span style={{ color: 'var(--text3)' }}>{o.order_id.slice(0, 18)}</span>
                </div>
              ))}
            </div>
            <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 12 }}>
              The dispatch planner can then decide to move these to next day or mark cancelled after speaking with the customer.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => { setShowUnfulfillableModal(false); setUnfulfillableSku(null) }} style={{
              padding: '8px 18px', borderRadius: 7, border: '1px solid var(--border)',
              background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer', fontSize: 13,
            }}>Cancel</button>
            <button onClick={handleUnfulfillableSku} style={{
              padding: '8px 18px', borderRadius: 7, border: 'none',
              background: 'var(--critical)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
            }}>Mark Unfulfillable</button>
          </div>
        </Modal>
      )}

      {/* ── EOD confirm modal ── */}
      {showEodConfirm && eodMatchResult && (
        <Modal title="Confirm EOD Dispatch" onClose={() => setShowEodConfirm(false)}>
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div style={{ padding: '12px 16px', background: 'var(--dispatched-bg)', border: '1px solid #bbf7d0', borderRadius: 7, textAlign: 'center' as const }}>
                <div style={{ fontSize: 24, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--dispatched)' }}>{eodMatchResult.matched.length}</div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>AWBs matched</div>
              </div>
              <div style={{ padding: '12px 16px', background: eodMatchResult.unmatched.length > 0 ? 'var(--critical-bg)' : 'var(--bg2)', border: `1px solid ${eodMatchResult.unmatched.length > 0 ? '#fecaca' : 'var(--border)'}`, borderRadius: 7, textAlign: 'center' as const }}>
                <div style={{ fontSize: 24, fontFamily: 'DM Mono', fontWeight: 600, color: eodMatchResult.unmatched.length > 0 ? 'var(--critical)' : 'var(--text3)' }}>{eodMatchResult.unmatched.length}</div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>Unmatched orders</div>
              </div>
            </div>

            {eodMatchResult.unmatched.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <p style={{ fontSize: 12, color: 'var(--critical)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AlertCircle size={13} /> These orders had no AWB in Shypassist — they will remain pending:
                </p>
                <div style={{ border: '1px solid #fecaca', borderRadius: 6, maxHeight: 120, overflowY: 'auto' }}>
                  {eodMatchResult.unmatched.map(o => (
                    <div key={o.orderId} style={{ padding: '6px 12px', borderBottom: '1px solid #fecaca', fontSize: 12, fontFamily: 'DM Mono', color: 'var(--critical)' }}>
                      {o.customerName} — {o.sku}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <p style={{ color: 'var(--text2)', fontSize: 13 }}>
              Matched orders will be marked dispatched with their AWB numbers. This cannot be undone.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => setShowEodConfirm(false)} style={{
              padding: '8px 18px', borderRadius: 7, border: '1px solid var(--border)',
              background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer', fontSize: 13,
            }}>Cancel</button>
            <button onClick={confirmEOD} style={{
              padding: '8px 18px', borderRadius: 7, border: 'none',
              background: 'var(--dispatched)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
            }}>Confirm & Mark Dispatched</button>
          </div>
        </Modal>
      )}

      {/* ── Header ── */}
      <header style={{
        background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        padding: '0 32px', height: 56,
        display: 'flex', alignItems: 'center',
        position: 'sticky' as const, top: 0, zIndex: 100,
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 32 }}>
          <div style={{ width: 30, height: 30, background: 'var(--accent)', borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'DM Mono', fontWeight: 500, fontSize: 14, color: '#fff' }}>D</div>
          <span style={{ fontFamily: 'DM Mono', fontWeight: 500, fontSize: 15, color: 'var(--text)' }}>DispatchLens</span>
        </div>
        <nav style={{ display: 'flex', gap: 2, flex: 1 }}>
          {(['import', 'plan', 'picklist', 'eod'] as Tab[]).map(t => {
            const labels: Record<Tab, string> = {
              import: 'Import',
              plan: activeOrders.length ? `Plan (${activeOrders.length})` : 'Plan',
              picklist: dispatchTodayCount ? `Picklist (${dispatchTodayCount})` : 'Picklist',
              eod: 'End of Day',
            }
            return (
              <button key={t} onClick={() => setTab(t)} style={{
                padding: '6px 16px', border: 'none', borderRadius: 6,
                background: tab === t ? 'var(--accent-bg)' : 'transparent',
                color: tab === t ? 'var(--accent)' : 'var(--text2)',
                fontFamily: 'DM Sans', fontWeight: tab === t ? 600 : 400, fontSize: 14,
                cursor: 'pointer', transition: 'all 0.15s',
              }}>{labels[t]}</button>
            )
          })}
        </nav>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {activeSession && (
            <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text3)', background: 'var(--bg2)', padding: '4px 10px', borderRadius: 20, border: '1px solid var(--border)' }}>
              {activeSession.label}
            </span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {user.user_metadata?.avatar_url && (
              <img src={user.user_metadata.avatar_url} alt="" style={{ width: 28, height: 28, borderRadius: '50%' }} />
            )}
            <span style={{ fontSize: 13, color: 'var(--text2)' }}>{user.user_metadata?.name?.split(' ')[0] || user.email?.split('@')[0]}</span>
          </div>
          <button onClick={handleSignOut} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text3)', cursor: 'pointer', padding: '5px 8px', display: 'flex', alignItems: 'center' }}>
            <LogOut size={13} />
          </button>
        </div>
      </header>

      <main style={{ flex: 1, padding: '28px 32px', maxWidth: 1600, margin: '0 auto', width: '100%' }}>

        {/* ════ IMPORT ════ */}
        {tab === 'import' && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h1 style={{ fontSize: 18, fontWeight: 600 }}>{activeSession ? activeSession.label : 'No active session'}</h1>
              <button onClick={createSession} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 7, background: 'var(--accent)', border: 'none', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                <Plus size={14} /> New Session
              </button>
              {sessions.length > 1 && (
                <select onChange={e => { const s = sessions.find(x => x.id === e.target.value); if (s) selectSession(s) }} value={activeSession?.id || ''} style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', padding: '7px 12px', borderRadius: 7, fontSize: 13 }}>
                  {sessions.map(s => <option key={s.id} value={s.id}>{s.label} · {s.total_orders} orders</option>)}
                </select>
              )}
            </div>
            {!activeSession ? (
              <div style={{ ...card, padding: 48, textAlign: 'center' as const, color: 'var(--text2)' }}>
                <Package size={32} style={{ margin: '0 auto 12px', color: 'var(--text3)' }} />
                <p>Create a new session to start planning today's dispatches.</p>
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                  {[
                    { key: 'delhivery', label: 'DELHIVERY', color: '#7c3aed', text: delhiveryText, set: setDelhiveryText },
                    { key: 'bluedart', label: 'BLUEDART', color: '#2563eb', text: bluedartText, set: setBluedartText },
                  ].map(({ key, label, color, text, set }) => (
                    <div key={key} style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
                        <span style={{ fontFamily: 'DM Mono', fontSize: 12, fontWeight: 500, color: 'var(--text2)', letterSpacing: '0.05em' }}>{label}</span>
                        {text.trim() && <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text3)' }}>~{text.trim().split('\n').length - 1} rows</span>}
                      </div>
                      <textarea value={text} onChange={e => set(e.target.value)}
                        placeholder={`Copy from ${label} planning sheet (include header row) and paste here`}
                        style={{ height: 260, width: '100%', padding: '12px 14px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text)', fontFamily: 'DM Mono', fontSize: 12, resize: 'vertical' as const, outline: 'none', lineHeight: 1.5, transition: 'border-color 0.15s' }}
                        onFocus={e => e.target.style.borderColor = color}
                        onBlur={e => e.target.style.borderColor = 'var(--border)'}
                      />
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <button onClick={handleImport} disabled={importing || (!delhiveryText.trim() && !bluedartText.trim())} style={{ padding: '9px 22px', borderRadius: 7, background: importing || (!delhiveryText.trim() && !bluedartText.trim()) ? 'var(--bg2)' : 'var(--accent)', border: '1px solid transparent', color: importing || (!delhiveryText.trim() && !bluedartText.trim()) ? 'var(--text3)' : '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Upload size={15} />{importing ? 'Importing…' : 'Import Orders'}
                  </button>
                  {importResult && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--dispatched)', fontSize: 13, fontWeight: 500 }}>
                      <CheckCircle size={15} />
                      {importResult.added} orders imported
                      {importResult.skipped > 0 && <span style={{ color: 'var(--text3)' }}>· {importResult.skipped} skipped</span>}
                    </div>
                  )}
                  {orders.length > 0 && (
                    <button onClick={() => setTab('plan')} style={{ marginLeft: 'auto', padding: '9px 18px', borderRadius: 7, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
                      View Plan <ArrowRight size={14} />
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ════ PLAN ════ */}
        {tab === 'plan' && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
            {/* KPI cards — clickable filters */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' as const, alignItems: 'stretch' }}>
              {[
                { key: 'ALL' as ActiveFilter, label: 'Total Active', value: activeOrders.length, color: 'var(--text)', bg: 'var(--surface)', activeBg: 'var(--bg2)', border: 'var(--border)' },
                { key: 'undecided' as ActiveFilter, label: 'Undecided', value: undecidedCount, color: 'var(--today)', bg: 'var(--today-bg)', activeBg: 'var(--today-bg)', border: '#fed7aa' },
                { key: 'dispatch_today' as ActiveFilter, label: 'Dispatch Today', value: dispatchTodayCount, color: 'var(--dispatched)', bg: 'var(--dispatched-bg)', activeBg: 'var(--dispatched-bg)', border: '#bbf7d0' },
                { key: 'hold' as ActiveFilter, label: 'On Hold', value: holdCount, color: 'var(--hold)', bg: 'var(--hold-bg)', activeBg: 'var(--hold-bg)', border: '#bfdbfe' },
                { key: 'unfulfillable' as ActiveFilter, label: 'Unfulfillable', value: unfulfillableCount, color: 'var(--critical)', bg: 'var(--critical-bg)', activeBg: 'var(--critical-bg)', border: '#fecaca' },
              ].map(kpi => {
                const isActive = activeFilter === kpi.key
                return (
                  <button key={kpi.key} onClick={() => toggleFilter(kpi.key)} style={{
                    padding: '10px 18px', minWidth: 120,
                    background: isActive ? kpi.bg : 'var(--surface)',
                    border: `1px solid ${isActive ? kpi.border : 'var(--border)'}`,
                    borderRadius: 8, cursor: 'pointer',
                    display: 'flex', flexDirection: 'column' as const, gap: 2, textAlign: 'left' as const,
                    boxShadow: isActive ? `0 0 0 3px ${kpi.bg}` : '0 1px 3px rgba(0,0,0,0.06)',
                    transition: 'all 0.15s', outline: 'none',
                  }}>
                    <span style={{ color: kpi.color, fontFamily: 'DM Mono', fontSize: 22, fontWeight: 500, lineHeight: 1 }}>{kpi.value}</span>
                    <span style={{ color: 'var(--text3)', fontSize: 11, marginTop: 2 }}>{kpi.label}</span>
                    {isActive && <span style={{ fontSize: 10, color: kpi.color, marginTop: 1 }}>● filtered</span>}
                  </button>
                )
              })}

              <div style={{ flex: 1 }} />

              {/* Urgency filters */}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {URGENCY_ORDER.map(tier => {
                  const colors: Record<UrgencyTier, { c: string; bg: string; b: string }> = {
                    CRITICAL: { c: 'var(--critical)', bg: 'var(--critical-bg)', b: '#fecaca' },
                    TODAY:    { c: 'var(--today)',    bg: 'var(--today-bg)',    b: '#fed7aa' },
                    PLAN:     { c: 'var(--plan)',     bg: 'var(--plan-bg)',     b: '#fde68a' },
                    HOLD:     { c: 'var(--hold)',     bg: 'var(--hold-bg)',     b: '#bfdbfe' },
                  }
                  const { c, bg, b } = colors[tier]
                  const isActive = activeFilter === tier
                  return (
                    <button key={tier} onClick={() => toggleFilter(tier)} style={{
                      padding: '5px 12px', borderRadius: 6,
                      border: `1px solid ${isActive ? b : 'var(--border)'}`,
                      background: isActive ? bg : 'var(--surface)',
                      color: isActive ? c : 'var(--text2)',
                      fontSize: 11, fontFamily: 'DM Mono', cursor: 'pointer', fontWeight: 500,
                    }}>
                      {tier}{tierCounts[tier] ? ` (${tierCounts[tier]})` : ''}
                    </button>
                  )
                })}
                {activeSession && (
                  <button onClick={() => loadOrders(activeSession.id)} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text2)', cursor: 'pointer', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                    <RefreshCw size={12} />
                  </button>
                )}
              </div>
            </div>

            {/* Bulk action bar */}
            {someSelected && (
              <div style={{
                background: 'var(--text)', borderRadius: 8, padding: '10px 16px',
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <span style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>{selectedIds.size} selected</span>
                <div style={{ flex: 1 }} />
                <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>Mark as:</span>
                {[
                  { d: 'dispatch_today' as PlanDecision, label: 'Dispatch Today', bg: 'var(--dispatched)' },
                  { d: 'hold' as PlanDecision, label: 'Hold', bg: 'var(--hold)' },
                  { d: 'unfulfillable' as PlanDecision, label: 'Unfulfillable', bg: 'var(--critical)' },
                ].map(({ d, label, bg }) => (
                  <button key={d} onClick={() => { setBulkDecision(d); setShowBulkConfirm(true) }} style={{
                    padding: '6px 14px', borderRadius: 6, border: 'none',
                    background: bg, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  }}>{label}</button>
                ))}
                <button onClick={() => setSelectedIds(new Set())} style={{ background: 'none', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, color: 'rgba(255,255,255,0.6)', cursor: 'pointer', padding: '5px 10px', fontSize: 12 }}>
                  Clear
                </button>
              </div>
            )}

            {/* Table */}
            {loadingOrders ? (
              <div style={{ ...card, padding: 60, textAlign: 'center' as const, color: 'var(--text3)' }}>Loading orders…</div>
            ) : filteredActive.length === 0 ? (
              <div style={{ ...card, padding: 60, textAlign: 'center' as const, color: 'var(--text2)' }}>
                {activeOrders.length === 0 ? 'No orders imported yet. Go to Import tab.' : 'No orders match this filter.'}
              </div>
            ) : (
              <div style={{ ...card, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
                        <th style={{ padding: '9px 12px', width: 36 }}>
                          <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll}
                            style={{ cursor: 'pointer', width: 14, height: 14, accentColor: 'var(--accent)' }} />
                        </th>
                        {['', 'Urgency', 'Order ID', 'Customer', 'SKU', 'Cour.', 'Pincode · City', 'ODA', 'Transit', 'Promise', 'Days Left', 'Decision'].map(h => (
                          <th key={h} style={{ padding: '9px 12px', textAlign: 'left' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, whiteSpace: 'nowrap' as const, letterSpacing: '0.03em' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredActive.map(order => (
                        <OrderRow
                          key={order.id}
                          order={order}
                          selected={selectedIds.has(order.id)}
                          updating={updatingIds.has(order.id)}
                          onSelect={toggleSelect}
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
                <button onClick={() => setShowCancelled(v => !v)} style={{ width: '100%', padding: '10px 16px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text3)', fontSize: 13, fontWeight: 500 }}>
                  {showCancelled ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  Cancelled orders ({cancelledOrders.length})
                </button>
                {showCancelled && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px' }}>
                    {cancelledOrders.map(o => (
                      <div key={o.id} style={{ padding: '5px 0', fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text3)', borderBottom: '1px solid var(--border)', display: 'flex', gap: 16 }}>
                        <span>{o.order_id}</span><span>{o.sku}</span><span>{o.customer_name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {dispatchedOrders.length > 0 && (
              <div style={{ ...card, overflow: 'hidden' }}>
                <button onClick={() => setShowDispatched(v => !v)} style={{ width: '100%', padding: '10px 16px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dispatched)', fontSize: 13, fontWeight: 500 }}>
                  {showDispatched ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  Already dispatched ({dispatchedOrders.length})
                </button>
                {showDispatched && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px' }}>
                    {dispatchedOrders.map(o => (
                      <div key={o.id} style={{ padding: '5px 0', fontFamily: 'DM Mono', fontSize: 12, color: 'var(--dispatched)', borderBottom: '1px solid var(--border)', display: 'flex', gap: 16 }}>
                        <span>{o.order_id}</span><span>{o.sku}</span><span>{o.customer_name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ════ PICKLIST ════ */}
        {tab === 'picklist' && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <h1 style={{ fontSize: 18, fontWeight: 600 }}>Picklist</h1>
              <span style={{ color: 'var(--text3)', fontSize: 14 }}>{dispatchTodayCount} orders · {picklist.reduce((s, i) => s + i.qty, 0)} pieces</span>
              <button onClick={() => window.print()} style={{ marginLeft: 'auto', padding: '8px 16px', borderRadius: 7, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
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
                      <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)', display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 10, height: 10, borderRadius: '50%', background: courierColor }} />
                        <span style={{ fontFamily: 'DM Mono', fontWeight: 500, fontSize: 14 }}>{courier}</span>
                        <span style={{ marginLeft: 'auto', color: 'var(--text3)', fontSize: 12 }}>{items.length} SKUs · {totalQty} pcs</span>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse' as const }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <th style={{ padding: '8px 20px', textAlign: 'left' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500 }}>SKU</th>
                            <th style={{ padding: '8px 20px', textAlign: 'right' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500 }}>ORDERS</th>
                            <th style={{ padding: '8px 20px', textAlign: 'right' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500 }}>QTY</th>
                            <th style={{ padding: '8px 20px', textAlign: 'center' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500 }}>ACTION</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((item, i) => {
                            const isUnfulfillable = orders.some(o => o.sku === item.sku && o.plan_decision === 'unfulfillable' && !o.is_cancelled)
                            return (
                              <tr key={item.sku} style={{ borderBottom: i < items.length - 1 ? '1px solid var(--border)' : 'none', background: isUnfulfillable ? 'var(--critical-bg)' : 'transparent' }}>
                                <td style={{ padding: '10px 20px', fontFamily: 'DM Mono', fontSize: 12, color: isUnfulfillable ? 'var(--critical)' : 'var(--text)' }}>{item.sku}</td>
                                <td style={{ padding: '10px 20px', textAlign: 'right' as const, color: 'var(--text2)', fontSize: 13 }}>{item.count}</td>
                                <td style={{ padding: '10px 20px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 600, color: courierColor, fontSize: 15 }}>{item.qty}</td>
                                <td style={{ padding: '10px 20px', textAlign: 'center' as const }}>
                                  {!isUnfulfillable ? (
                                    <button onClick={() => { setUnfulfillableSku(item.sku); setShowUnfulfillableModal(true) }} style={{
                                      padding: '4px 10px', borderRadius: 5, border: '1px solid #fecaca',
                                      background: 'var(--critical-bg)', color: 'var(--critical)',
                                      fontSize: 11, cursor: 'pointer', fontWeight: 500, fontFamily: 'DM Sans',
                                    }}>
                                      Mark Unfulfillable
                                    </button>
                                  ) : (
                                    <span style={{ fontSize: 11, color: 'var(--critical)', fontFamily: 'DM Mono' }}>● Unfulfillable</span>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                        <tfoot>
                          <tr style={{ borderTop: '2px solid var(--border2)', background: 'var(--bg2)' }}>
                            <td style={{ padding: '10px 20px', fontWeight: 600, fontSize: 13 }}>Total</td>
                            <td style={{ padding: '10px 20px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: 'var(--text2)' }}>{items.reduce((s, i) => s + i.count, 0)}</td>
                            <td style={{ padding: '10px 20px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, color: courierColor, fontSize: 18 }}>{totalQty}</td>
                            <td />
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

        {/* ════ EOD ════ */}
        {tab === 'eod' && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 24, maxWidth: 700 }}>
            <h1 style={{ fontSize: 18, fontWeight: 600 }}>End of Day — {activeSession?.label || 'No session'}</h1>

            {eodDone || activeSession?.is_eod_done ? (
              <div style={{ ...card, padding: 32, border: '1px solid #bbf7d0', background: 'var(--dispatched-bg)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--dispatched)', marginBottom: 20 }}>
                  <CheckCircle size={22} />
                  <span style={{ fontWeight: 700, fontSize: 16 }}>EOD Complete</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
                  {[
                    { label: 'Dispatched', value: dispatchedOrders.length, color: 'var(--dispatched)' },
                    { label: 'Held', value: holdCount, color: 'var(--hold)' },
                    { label: 'Unfulfillable', value: unfulfillableCount, color: 'var(--critical)' },
                  ].map(s => (
                    <div key={s.label} style={{ textAlign: 'center' as const }}>
                      <div style={{ fontSize: 32, fontFamily: 'DM Mono', fontWeight: 500, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {/* Summary before upload */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  {[
                    { label: 'Marked Dispatch Today', value: dispatchTodayCount, color: 'var(--dispatched)', bg: 'var(--dispatched-bg)' },
                    { label: 'On Hold', value: holdCount, color: 'var(--hold)', bg: 'var(--hold-bg)' },
                    { label: 'Unfulfillable', value: unfulfillableCount, color: 'var(--critical)', bg: 'var(--critical-bg)' },
                  ].map(s => (
                    <div key={s.label} style={{ padding: 16, background: s.bg, border: '1px solid var(--border)', borderRadius: 8, textAlign: 'center' as const }}>
                      <div style={{ fontSize: 28, fontFamily: 'DM Mono', fontWeight: 500, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{s.label}</div>
                    </div>
                  ))}
                </div>

                {undecidedCount > 0 && (
                  <div style={{ padding: '12px 16px', background: 'var(--today-bg)', border: '1px solid #fed7aa', borderRadius: 8, color: 'var(--today)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <AlertTriangle size={15} />
                    {undecidedCount} orders still undecided — complete the Plan tab before EOD.
                  </div>
                )}

                {/* Shypassist paste */}
                <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Truck size={14} style={{ color: 'var(--text2)' }} />
                    <span style={{ fontFamily: 'DM Mono', fontSize: 12, fontWeight: 500, color: 'var(--text2)', letterSpacing: '0.05em' }}>SHYPASSIST EXPORT</span>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text3)' }}>Paste SKU · QTY · AWB data</span>
                  </div>
                  <textarea
                    value={shypassistText}
                    onChange={e => { setShypassistText(e.target.value); setEodMatchResult(null) }}
                    placeholder={'SKU\tQTY\tAWB\nHT-DBM-EL-4x6\t1\t305328290\n...'}
                    style={{ height: 200, width: '100%', padding: '12px 14px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text)', fontFamily: 'DM Mono', fontSize: 12, resize: 'vertical' as const, outline: 'none', lineHeight: 1.5, transition: 'border-color 0.15s' }}
                    onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button
                      onClick={parseShypassist}
                      disabled={!shypassistText.trim() || dispatchTodayCount === 0}
                      style={{
                        padding: '9px 20px', borderRadius: 7,
                        background: !shypassistText.trim() || dispatchTodayCount === 0 ? 'var(--bg2)' : 'var(--accent)',
                        border: 'none',
                        color: !shypassistText.trim() || dispatchTodayCount === 0 ? 'var(--text3)' : '#fff',
                        fontWeight: 600, fontSize: 13, cursor: 'pointer',
                        display: 'flex', alignItems: 'center', gap: 8,
                      }}
                    >
                      <CheckCircle size={14} /> Match & Preview
                    </button>
                    {dispatchTodayCount === 0 && (
                      <span style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'center' }}>
                        No orders marked "Dispatch Today" yet.
                      </span>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

// ── Order Row ──
function OrderRow({ order, selected, updating, onSelect, onDecision, onPriority }: {
  order: DBOrder; selected: boolean; updating: boolean
  onSelect: (id: string) => void
  onDecision: (id: string, d: PlanDecision) => void
  onPriority: (id: string, current: boolean) => void
}) {
  const uc = {
    CRITICAL: { color: 'var(--critical)', bg: 'var(--critical-bg)', border: '#fecaca' },
    TODAY:    { color: 'var(--today)',    bg: 'var(--today-bg)',    border: '#fed7aa' },
    PLAN:     { color: 'var(--plan)',     bg: 'var(--plan-bg)',     border: '#fde68a' },
    HOLD:     { color: 'var(--hold)',     bg: 'var(--hold-bg)',     border: '#bfdbfe' },
  }[order.urgency || 'HOLD'] || { color: 'var(--text3)', bg: 'var(--bg2)', border: 'var(--border)' }

  const rowBg: Record<PlanDecision, string> = {
    dispatch_today: '#f0fdf4', hold: '#eff6ff', unfulfillable: '#fef2f2', undecided: 'transparent',
  }

  return (
    <tr style={{
      borderBottom: '1px solid var(--border)',
      background: selected ? '#fefce8' : updating ? 'var(--accent-bg)' : rowBg[order.plan_decision],
      transition: 'background 0.1s',
    }}>
      <td style={{ padding: '8px 12px' }}>
        <input type="checkbox" checked={selected} onChange={() => onSelect(order.id)}
          style={{ cursor: 'pointer', width: 14, height: 14, accentColor: 'var(--accent)' }} />
      </td>
      <td style={{ padding: '8px 12px', width: 36 }}>
        <button onClick={() => onPriority(order.id, order.is_priority)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: order.is_priority ? 'var(--accent)' : 'var(--border2)' }}>
          <Star size={14} fill={order.is_priority ? 'var(--accent)' : 'none'} />
        </button>
      </td>
      <td style={{ padding: '8px 12px' }}>
        <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontFamily: 'DM Mono', fontWeight: 500, letterSpacing: '0.05em', color: uc.color, background: uc.bg, border: `1px solid ${uc.border}` }}>
          {order.urgency || '—'}
        </span>
      </td>
      <td style={{ padding: '8px 12px' }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>
          {order.order_id.length > 20 ? order.order_id.slice(0, 20) + '…' : order.order_id}
        </span>
      </td>
      <td style={{ padding: '8px 12px', maxWidth: 160 }}>
        <span style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', maxWidth: 150 }}>{order.customer_name}</span>
      </td>
      <td style={{ padding: '8px 12px' }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text)', background: 'var(--bg2)', padding: '2px 6px', borderRadius: 4 }}>{order.sku}</span>
      </td>
      <td style={{ padding: '8px 12px' }}>
        <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 500, color: order.courier === 'Bluedart' ? '#2563eb' : '#7c3aed', background: order.courier === 'Bluedart' ? '#eff6ff' : '#f5f3ff', padding: '2px 7px', borderRadius: 4, border: `1px solid ${order.courier === 'Bluedart' ? '#bfdbfe' : '#e9d5ff'}` }}>
          {order.courier === 'Bluedart' ? 'BD' : 'DL'}
        </span>
      </td>
      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text)' }}>{order.pincode}</span>
        {order.city && <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 6 }}>{order.city}</span>}
      </td>
      <td style={{ padding: '8px 12px' }}>
        {order.oda === 'ODA' && <span style={{ fontSize: 10, fontFamily: 'DM Mono', color: 'var(--today)', background: 'var(--today-bg)', padding: '1px 5px', borderRadius: 3, border: '1px solid #fed7aa' }}>ODA</span>}
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'center' as const }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text3)' }}>{order.transit_days}d</span>
      </td>
      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text2)' }}>
          {order.promise_date ? new Date(order.promise_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}
        </span>
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'center' as const }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 14, fontWeight: 600, color: uc.color }}>{order.days_left !== null ? order.days_left : '—'}</span>
      </td>
      <td style={{ padding: '8px 12px' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {([
            { d: 'dispatch_today' as PlanDecision, label: 'Dispatch', ac: 'var(--dispatched)', ab: 'var(--dispatched-bg)', ab2: '#bbf7d0' },
            { d: 'hold' as PlanDecision, label: 'Hold', ac: 'var(--hold)', ab: 'var(--hold-bg)', ab2: '#bfdbfe' },
            { d: 'unfulfillable' as PlanDecision, label: 'Unfulfil.', ac: 'var(--critical)', ab: 'var(--critical-bg)', ab2: '#fecaca' },
          ]).map(({ d, label, ac, ab, ab2 }) => {
            const isActive = order.plan_decision === d
            return (
              <button key={d} onClick={() => onDecision(order.id, d)} style={{
                padding: '4px 10px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                fontFamily: 'DM Sans', fontWeight: 500,
                background: isActive ? ab : 'var(--surface)',
                border: `1px solid ${isActive ? ab2 : 'var(--border)'}`,
                color: isActive ? ac : 'var(--text3)',
                transition: 'all 0.1s', whiteSpace: 'nowrap' as const,
              }}>{label}</button>
            )
          })}
        </div>
      </td>
    </tr>
  )
}
