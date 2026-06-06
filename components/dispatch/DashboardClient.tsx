'use client'
import { useState, useCallback, useMemo, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { parseOrders } from '@/lib/parser'
import { DBOrder, DispatchSession, PlanDecision, UrgencyTier, Courier, UnfulfillableReason } from '@/types'
import UsersTab from './UsersTab'
import { User } from '@supabase/supabase-js'
import {
  Star, Printer, CheckCircle, ChevronDown, ChevronUp,
  Upload, LogOut, Package, Truck, AlertTriangle, Clock,
  RefreshCw, Plus, ArrowRight, X, AlertCircle, Calendar,
  Ban
} from 'lucide-react'

type Tab = 'import' | 'plan' | 'review' | 'picklist' | 'eod' | 'users'
type ActiveFilter = 'ALL' | UrgencyTier | 'scheduled' | 'scheduled_today' | 'hold' | 'unfulfillable' | 'undecided'

interface Props {
  user: User
  access: import('@/types').UserAccess
  initialOrders: DBOrder[]
}

const URGENCY_ORDER: UrgencyTier[] = ['CRITICAL', 'TODAY', 'PLAN', 'HOLD']
const UNFULFILLABLE_REASONS: UnfulfillableReason[] = ['Not ready', 'No stock available', 'Other']

// ── Reusable Modal ──
function Modal({ title, children, onClose, width = 480 }: { title: string; children: React.ReactNode; onClose: () => void; width?: number }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 28, width, maxWidth: '90vw', maxHeight: '85vh', overflow: 'auto', boxShadow: '0 20px 40px rgba(0,0,0,0.12)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 4 }}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── Modal action buttons ──
function ModalActions({ onCancel, onConfirm, confirmLabel, confirmColor = 'var(--accent)', disabled = false }: {
  onCancel: () => void; onConfirm: () => void; confirmLabel: string; confirmColor?: string; disabled?: boolean
}) {
  return (
    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
      <button onClick={onCancel} style={{ padding: '8px 18px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
      <button onClick={onConfirm} disabled={disabled} style={{ padding: '8px 18px', borderRadius: 7, border: 'none', background: disabled ? 'var(--bg2)' : confirmColor, color: disabled ? 'var(--text3)' : '#fff', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}>{confirmLabel}</button>
    </div>
  )
}

export default function DashboardClient({ user, access, initialOrders }: Props) {
  const supabase = createClient()
  const [tab, setTab] = useState<Tab>('import')
  const [orders, setOrders] = useState<DBOrder[]>(initialOrders)
  const [loadingOrders, setLoadingOrders] = useState(false)

  // Import
  const [delhiveryText, setDelhiveryText] = useState('')
  const [bluedartText, setBluedartText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ added: number; skipped: number } | null>(null)

  // Plan
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('ALL')
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [daysFilter, setDaysFilter] = useState<Set<number>>(new Set())
  const [showDaysPopover, setShowDaysPopover] = useState(false)
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 })
  const [courierFilter, setCourierFilter] = useState<Set<string>>(new Set())
  const [showCourierPopover, setShowCourierPopover] = useState(false)
  const [courierPopoverPos, setCourierPopoverPos] = useState({ top: 0, left: 0 })
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDecision, setBulkDecision] = useState<PlanDecision | ''>('')
  const [showBulkConfirm, setShowBulkConfirm] = useState(false)
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set())
  const [showCancelled, setShowCancelled] = useState(false)
  const [showDispatched, setShowDispatched] = useState(false)

  // Manual cancel modal
  const [cancelOrderId, setCancelOrderId] = useState<string | null>(null)

  // Unfulfillable from picklist
  const [unfulfillableSku, setUnfulfillableSku] = useState<string | null>(null)
  const [unfulfillableReason, setUnfulfillableReason] = useState<UnfulfillableReason>('Not ready')
  const [unfulfillableNote, setUnfulfillableNote] = useState('')
  const [availableQty, setAvailableQty] = useState<number | ''>('')
  const [allocationPreview, setAllocationPreview] = useState<{
    dispatch: DBOrder[]
    unfulfillable: DBOrder[]
  } | null>(null)

  // Review tab
  const [targetDates, setTargetDates] = useState<Record<string, string>>({})
  const [savingReview, setSavingReview] = useState<string | null>(null)

  // EOD
  const [shypassistText, setShypassistText] = useState('')
  const [eodMatchResult, setEodMatchResult] = useState<{
    matched: Array<{ orderId: string; sku: string; awb: string; customerName: string }>
    unmatched: Array<{ orderId: string; sku: string; customerName: string; storedAwb?: string | null }>
  } | null>(null)
  const [showEodConfirm, setShowEodConfirm] = useState(false)
  const [eodDone, setEodDone] = useState(false)

  const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

  // ── Data ──
  const loadOrders = useCallback(async () => {
    setLoadingOrders(true)
    const { data } = await supabase.from('dispatch_orders').select('*').order('created_at', { ascending: false })
    setOrders((data as DBOrder[]) || [])
    setLoadingOrders(false)
    setSelectedIds(new Set())
  }, [supabase])

  // Auto-load on mount if initialOrders is empty

  useEffect(() => {
    // Always load fresh from DB to ensure all columns (incl. scheduled_date) are present
    loadOrders()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])



  // ── Import ──
  const handleImport = async () => {
    if (!delhiveryText.trim() && !bluedartText.trim()) return
    setImporting(true)
    setImportResult(null)
    const allParsed = [...parseOrders(delhiveryText, 'Delhivery'), ...parseOrders(bluedartText, 'Bluedart')]
    if (allParsed.length === 0) { setImporting(false); return }
    // Check for duplicates across all orders in the pool
    const existingIds = new Set(orders.map(o => o.order_id))
    const newOrders = allParsed.filter(o => !existingIds.has(o.order_id))
    if (newOrders.length > 0) {
      // Use a placeholder session_id (create a batch record for tracking)
      const batchLabel = `Import ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
      const { data: session } = await supabase.from('dispatch_sessions')
        .insert({ created_by: user.id, session_date: new Date().toISOString().split('T')[0], label: batchLabel, total_orders: newOrders.length })
        .select().single()
      if (session) {
        const rows = newOrders.map(o => ({
          session_id: session.id, ...o,
          plan_decision: o.is_dispatched ? 'scheduled' : 'undecided',
        }))
        await supabase.from('dispatch_orders').insert(rows)
        await loadOrders()
      }
    }
    setImportResult({ added: newOrders.length, skipped: allParsed.length - newOrders.length })
    setImporting(false)
    setDelhiveryText('')
    setBluedartText('')
    if (newOrders.length > 0) setTab('plan')
  }

  // ── Single decision ──
  const updateDecision = async (orderId: string, decision: PlanDecision, scheduledDate?: string) => {
    setUpdatingIds(prev => new Set(prev).add(orderId))
    const update: Record<string, string | null> = {
      plan_decision: decision,
      updated_at: new Date().toISOString(),
    }
    if (decision === 'scheduled') update.scheduled_date = scheduledDate || null
    if (decision === 'hold' || decision === 'undecided' || decision === 'unfulfillable') update.scheduled_date = null
    await supabase.from('dispatch_orders').update(update).eq('id', orderId)
    setOrders(prev => prev.map(o => o.id === orderId ? {
      ...o, plan_decision: decision,
      scheduled_date: update.scheduled_date !== undefined ? update.scheduled_date : o.scheduled_date
    } : o))
    setUpdatingIds(prev => { const n = new Set(prev); n.delete(orderId); return n })
  }

  // ── Schedule with date (called from row date picker) ──
  const scheduleOrder = async (orderId: string, date: string) => {
    if (!date) {
      await updateDecision(orderId, 'undecided')
      return
    }
    await updateDecision(orderId, 'scheduled', date)
  }

  // ── Bulk decision ──
  const [bulkScheduleDate, setBulkScheduleDate] = useState('')

  const handleBulkConfirm = async () => {
    if (!bulkDecision || selectedIds.size === 0) return
    const ids = Array.from(selectedIds)
    ids.forEach(id => setUpdatingIds(prev => new Set(prev).add(id)))
    const update: Record<string, string | null> = {
      plan_decision: bulkDecision,
      updated_at: new Date().toISOString(),
    }
    if (bulkDecision === 'scheduled') update.scheduled_date = bulkScheduleDate || new Date().toISOString().split('T')[0]
    else update.scheduled_date = null
    await supabase.from('dispatch_orders').update(update).in('id', ids)
    setOrders(prev => prev.map(o => selectedIds.has(o.id) ? {
      ...o, plan_decision: bulkDecision as PlanDecision,
      scheduled_date: update.scheduled_date !== undefined ? update.scheduled_date : o.scheduled_date
    } : o))
    setUpdatingIds(new Set())
    setSelectedIds(new Set())
    setBulkDecision('')
    setBulkScheduleDate('')
    setShowBulkConfirm(false)
  }

  // ── Priority ──
  const togglePriority = async (orderId: string, current: boolean) => {
    await supabase.from('dispatch_orders').update({ is_priority: !current }).eq('id', orderId)
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, is_priority: !current } : o))
  }

  // ── Manual cancel ──
  const handleManualCancel = async () => {
    if (!cancelOrderId) return
    const now = new Date().toISOString()
    await supabase.from('dispatch_orders').update({
      is_cancelled: true, manual_cancelled: true, manual_cancelled_at: now,
      plan_decision: 'undecided', updated_at: now,
    }).eq('id', cancelOrderId)
    setOrders(prev => prev.map(o => o.id === cancelOrderId ? { ...o, is_cancelled: true, manual_cancelled: true } : o))
    setCancelOrderId(null)
  }

  // ── Compute allocation preview ──
  const computeAllocation = (sku: string, available: number) => {
    const tierOrder: Record<string, number> = { CRITICAL: 0, TODAY: 1, PLAN: 2, HOLD: 3 }
    const skuOrders = orders
      .filter(o => o.sku === sku && o.plan_decision === 'scheduled' && !o.is_cancelled && !o.is_dispatched)
      .sort((a, b) => {
        const ta = tierOrder[a.urgency || 'HOLD'] ?? 3
        const tb = tierOrder[b.urgency || 'HOLD'] ?? 3
        if (ta !== tb) return ta - tb
        return (a.days_left ?? 99) - (b.days_left ?? 99)
      })
    return {
      dispatch: skuOrders.slice(0, available),
      unfulfillable: skuOrders.slice(available),
    }
  }

  // ── Unfulfillable by SKU (partial or full) ──
  const handleUnfulfillableSku = async () => {
    if (!unfulfillableSku || !allocationPreview) return
    const now = new Date().toISOString()

    // Mark unfulfillable orders
    if (allocationPreview.unfulfillable.length > 0) {
      const unfulfillableIds = allocationPreview.unfulfillable.map(o => o.id)
      await supabase.from('dispatch_orders').update({
        plan_decision: 'unfulfillable',
        unfulfillable_reason: unfulfillableReason,
        unfulfillable_note: unfulfillableNote.trim() || null,
        updated_at: now,
      }).in('id', unfulfillableIds)
      setOrders(prev => prev.map(o => unfulfillableIds.includes(o.id) ? {
        ...o, plan_decision: 'unfulfillable',
        unfulfillable_reason: unfulfillableReason,
        unfulfillable_note: unfulfillableNote.trim() || null,
      } : o))
    }

    setUnfulfillableSku(null)
    setUnfulfillableReason('Not ready')
    setUnfulfillableNote('')
    setAvailableQty('')
    setAllocationPreview(null)
  }

  // ── Review: save target date ──
  const saveTargetDate = async (orderId: string) => {
    const date = targetDates[orderId]
    if (!date) return
    setSavingReview(orderId)
    await supabase.from('dispatch_orders').update({ target_dispatch_date: date, updated_at: new Date().toISOString() }).eq('id', orderId)
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, target_dispatch_date: date } : o))
    setSavingReview(null)
    // Reload to pick up any auto-carried orders
    await loadOrders()
  }

  // ── Review: cancel from review ──
  const cancelFromReview = async (orderId: string) => {
    const now = new Date().toISOString()
    await supabase.from('dispatch_orders').update({ is_cancelled: true, manual_cancelled: true, manual_cancelled_at: now, updated_at: now }).eq('id', orderId)
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, is_cancelled: true, manual_cancelled: true } : o))
  }

  // ── EOD ──
  const parseShypassist = () => {
    const lines = shypassistText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) return

    // Build AWB set from Shypassist — normalise: strip .0 decimals, trim whitespace
    const shypassistAwbs = new Set<string>()
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t')
      if (cols.length < 3) continue
      const awb = cols[2].trim().replace(/\.0+$/, '')
      if (awb) shypassistAwbs.add(awb)
    }

    // Today's scheduled orders
    const eodToday = new Date().toISOString().split('T')[0]
    const toDispatch = orders.filter(o =>
      o.plan_decision === 'scheduled' &&
      o.scheduled_date === eodToday &&
      !o.is_cancelled &&
      !o.is_dispatched
    )

    const matched: Array<{ orderId: string; sku: string; awb: string; customerName: string }> = []
    const unmatched: Array<{ orderId: string; sku: string; customerName: string; storedAwb: string | null }> = []

    toDispatch.forEach(order => {
      // Normalise stored tracking number the same way
      const storedAwb = order.tracking_number?.trim().replace(/\.0+$/, '') || null
      if (storedAwb && shypassistAwbs.has(storedAwb)) {
        matched.push({ orderId: order.id, sku: order.sku, awb: storedAwb, customerName: order.customer_name })
      } else {
        unmatched.push({ orderId: order.id, sku: order.sku, customerName: order.customer_name, storedAwb })
      }
    })

    setEodMatchResult({ matched, unmatched })
    setShowEodConfirm(true)
  }

  const confirmEOD = async () => {
    if (!eodMatchResult) return
    const now = new Date().toISOString()
    for (const m of eodMatchResult.matched) {
      await supabase.from('dispatch_orders').update({ is_dispatched: true, dispatched_at: now, tracking_number: m.awb }).eq('id', m.orderId)
    }
    await loadOrders()
    setShowEodConfirm(false)
    setEodDone(true)
  }

  const handleSignOut = async () => { await supabase.auth.signOut(); window.location.href = '/login' }

  // ── Computed ──
  const activeOrders = useMemo(() => orders.filter(o => !o.is_cancelled && !o.is_dispatched), [orders])
  const cancelledOrders = useMemo(() => orders.filter(o => o.is_cancelled), [orders])
  const dispatchedOrders = useMemo(() => orders.filter(o => o.is_dispatched && !o.is_cancelled), [orders])
  const unfulfillableOrders = useMemo(() => activeOrders.filter(o => o.plan_decision === 'unfulfillable'), [activeOrders])

  const today = new Date().toISOString().split('T')[0]
  const scheduledCount = useMemo(() => orders.filter(o => o.plan_decision === 'scheduled' && !o.is_cancelled && !o.is_dispatched).length, [orders])
  const dispatchTodayCount = useMemo(() => orders.filter(o => o.plan_decision === 'scheduled' && o.scheduled_date === today && !o.is_cancelled && !o.is_dispatched).length, [orders, today])
  const holdCount = useMemo(() => orders.filter(o => o.plan_decision === 'hold' && !o.is_cancelled).length, [orders])
  const unfulfillableCount = useMemo(() => unfulfillableOrders.length, [unfulfillableOrders])
  const undecidedCount = useMemo(() => activeOrders.filter(o => o.plan_decision === 'undecided').length, [activeOrders])

  const tierCounts = useMemo(() => {
    const c: Record<string, number> = {}
    activeOrders.forEach(o => { if (o.urgency) c[o.urgency] = (c[o.urgency] || 0) + 1 })
    return c
  }, [activeOrders])

  // Display days left = raw - 1 (buffer)
  const displayDaysLeft = (raw: number | null) => raw === null ? null : raw - 1

  const filteredActive = useMemo(() => {
    let list = [...activeOrders]
    // Decision/urgency filter
    if (activeFilter === 'scheduled') list = list.filter(o => o.plan_decision === 'scheduled')
    else if (activeFilter === 'scheduled_today') list = list.filter(o => o.plan_decision === 'scheduled' && o.scheduled_date === today)
    else if (activeFilter === 'hold') list = list.filter(o => o.plan_decision === 'hold')
    else if (activeFilter === 'unfulfillable') list = list.filter(o => o.plan_decision === 'unfulfillable')
    else if (activeFilter === 'undecided') list = list.filter(o => o.plan_decision === 'undecided')
    else if (activeFilter !== 'ALL') list = list.filter(o => o.urgency === activeFilter)
    // Days left filter (applied to display value = raw - 1)
    if (daysFilter.size > 0) list = list.filter(o => daysFilter.has(displayDaysLeft(o.days_left) ?? -999))
    if (courierFilter.size > 0) list = list.filter(o => courierFilter.has(o.courier))
    // Sort
    const to: Record<string, number> = { CRITICAL: 0, TODAY: 1, PLAN: 2, HOLD: 3 }
    if (sortCol) {
      list.sort((a, b) => {
        let av: any, bv: any
        if (sortCol === 'urgency') { av = to[a.urgency || 'HOLD'] ?? 3; bv = to[b.urgency || 'HOLD'] ?? 3 }
        else if (sortCol === 'days_left') { av = a.days_left ?? 999; bv = b.days_left ?? 999 }
        else if (sortCol === 'customer') { av = a.customer_name.toLowerCase(); bv = b.customer_name.toLowerCase() }
        else if (sortCol === 'sku') { av = a.sku.toLowerCase(); bv = b.sku.toLowerCase() }
        else if (sortCol === 'courier') { av = a.courier; bv = b.courier }
        else if (sortCol === 'promise') { av = a.promise_date || ''; bv = b.promise_date || '' }
        else if (sortCol === 'transit') { av = a.transit_days; bv = b.transit_days }
        else if (sortCol === 'pincode') { av = a.pincode; bv = b.pincode }
        else { av = 0; bv = 0 }
        if (av < bv) return sortDir === 'asc' ? -1 : 1
        if (av > bv) return sortDir === 'asc' ? 1 : -1
        return 0
      })
    } else {
      list.sort((a, b) => {
        if (a.is_priority !== b.is_priority) return a.is_priority ? -1 : 1
        return (to[a.urgency || 'HOLD'] ?? 3) - (to[b.urgency || 'HOLD'] ?? 3) || (a.days_left ?? 99) - (b.days_left ?? 99)
      })
    }
    return list
  }, [activeOrders, activeFilter, daysFilter, courierFilter, sortCol, sortDir])

  // Unique display days left values for filter popover
  const uniqueDaysLeft = useMemo(() => {
    const vals = new Set<number>()
    activeOrders.forEach(o => { const d = displayDaysLeft(o.days_left); if (d !== null) vals.add(d) })
    return Array.from(vals).sort((a, b) => a - b)
  }, [activeOrders])

  const handleColSort = (col: string) => {
    if (sortCol === col) {
      if (sortDir === 'asc') setSortDir('desc')
      else { setSortCol(null); setSortDir('asc') }
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }

  const picklist = useMemo(() => {
    const scheduled = orders.filter(o => o.plan_decision === 'scheduled' && !o.is_cancelled && !o.is_dispatched)
    // Group by date -> courier -> sku
    const dateMap: Record<string, Record<string, Record<string, { sku: string; courier: Courier; qty: number; count: number; orders: DBOrder[] }>>> = {}
    scheduled.forEach(o => {
      const date = o.scheduled_date || 'Unscheduled'
      const courier = o.courier
      const key = `${o.sku}__${courier}`
      if (!dateMap[date]) dateMap[date] = {}
      if (!dateMap[date][courier]) dateMap[date][courier] = {}
      if (!dateMap[date][courier][key]) dateMap[date][courier][key] = { sku: o.sku, courier: courier as Courier, qty: 0, count: 0, orders: [] }
      dateMap[date][courier][key].qty += o.qty
      dateMap[date][courier][key].count += 1
      dateMap[date][courier][key].orders.push(o)
    })
    // Sort dates ascending
    return Object.entries(dateMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, courierMap]) => ({
        date,
        couriers: Object.entries(courierMap).map(([courier, skuMap]) => ({
          courier: courier as Courier,
          items: Object.values(skuMap).sort((a, b) => a.sku.localeCompare(b.sku)),
        }))
      }))
  }, [orders])

  const allVisibleSelected = filteredActive.length > 0 && filteredActive.every(o => selectedIds.has(o.id))
  const toggleSelectAll = () => {
    if (allVisibleSelected) setSelectedIds(prev => { const n = new Set(prev); filteredActive.forEach(o => n.delete(o.id)); return n })
    else setSelectedIds(prev => { const n = new Set(prev); filteredActive.forEach(o => n.add(o.id)); return n })
  }
  const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleFilter = (f: ActiveFilter) => { setActiveFilter(prev => prev === f ? 'ALL' : f); setSelectedIds(new Set()) }

  const cancelOrder = orders.find(o => o.id === cancelOrderId)

  // ── Urgency badge helper ──
  const urgencyStyle = (u: string | null) => ({
    CRITICAL: { color: 'var(--critical)', bg: 'var(--critical-bg)', border: '#fecaca' },
    TODAY:    { color: 'var(--today)',    bg: 'var(--today-bg)',    border: '#fed7aa' },
    PLAN:     { color: 'var(--plan)',     bg: 'var(--plan-bg)',     border: '#fde68a' },
    HOLD:     { color: 'var(--hold)',     bg: 'var(--hold-bg)',     border: '#bfdbfe' },
  }[u || ''] || { color: 'var(--text3)', bg: 'var(--bg2)', border: 'var(--border)' })

  const reviewCount = unfulfillableOrders.filter(o => !o.target_dispatch_date).length

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' as const }} onClick={() => { setShowDaysPopover(false); setShowCourierPopover(false) }}>

      {/* ── Modals ── */}

      {/* Bulk confirm */}
      {showBulkConfirm && bulkDecision && (
        <Modal title={`Apply to ${selectedIds.size} orders`} onClose={() => setShowBulkConfirm(false)}>
          <p style={{ color: 'var(--text2)', fontSize: 14, marginBottom: 12 }}>
            Mark <strong>{selectedIds.size} orders</strong> as{' '}
            <strong style={{ color: bulkDecision === 'scheduled' ? 'var(--dispatched)' : bulkDecision === 'hold' ? 'var(--hold)' : 'var(--critical)' }}>
              {bulkDecision === 'scheduled' ? 'Scheduled' : bulkDecision === 'hold' ? 'On Hold' : 'Unfulfillable'}
            </strong>?
          </p>
          {bulkDecision === 'scheduled' && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text2)', marginBottom: 6, fontWeight: 500 }}>Dispatch date</label>
              <input type="date"
                value={bulkScheduleDate}
                min={new Date().toISOString().split('T')[0]}
                onChange={e => setBulkScheduleDate(e.target.value)}
                style={{ padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, fontFamily: 'DM Mono' }}
              />
            </div>
          )}
          <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, marginBottom: 4 }}>
            {Array.from(selectedIds).map(id => {
              const o = orders.find(x => x.id === id)
              if (!o) return null
              return (
                <div key={id} style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, fontFamily: 'DM Mono', display: 'flex', gap: 12, color: 'var(--text2)' }}>
                  <span style={{ color: 'var(--text)' }}>{o.customer_name}</span>
                  <span>{o.sku}</span>
                  <span style={{ color: 'var(--text3)' }}>{o.courier === 'Bluedart' ? 'BD' : 'DL'}</span>
                </div>
              )
            })}
          </div>
          <ModalActions onCancel={() => setShowBulkConfirm(false)} onConfirm={handleBulkConfirm}
            confirmLabel="Confirm"
            confirmColor={bulkDecision === 'scheduled' ? 'var(--dispatched)' : bulkDecision === 'hold' ? 'var(--hold)' : 'var(--critical)'} />
        </Modal>
      )}

      {/* Manual cancel */}
      {cancelOrderId && cancelOrder && (
        <Modal title="Cancel Order" onClose={() => setCancelOrderId(null)}>
          <div style={{ marginBottom: 4 }}>
            <p style={{ color: 'var(--text2)', fontSize: 14, marginBottom: 16 }}>
              Manually cancel this order? This is typically done after confirming with the customer.
            </p>
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7, padding: '12px 14px', fontFamily: 'DM Mono', fontSize: 12, display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
              <span style={{ color: 'var(--text)', fontWeight: 500 }}>{cancelOrder.customer_name}</span>
              <span style={{ color: 'var(--text2)' }}>{cancelOrder.sku}</span>
              <span style={{ color: 'var(--text3)' }}>{cancelOrder.order_id}</span>
            </div>
          </div>
          <ModalActions onCancel={() => setCancelOrderId(null)} onConfirm={handleManualCancel} confirmLabel="Cancel Order" confirmColor="var(--critical)" />
        </Modal>
      )}

      {/* Unfulfillable SKU — partial allocation */}
      {unfulfillableSku && (() => {
        const skuOrders = orders.filter(o => o.sku === unfulfillableSku && o.plan_decision === 'scheduled' && !o.is_cancelled && !o.is_dispatched)
        const totalQty = skuOrders.reduce((s, o) => s + o.qty, 0)
        const closeModal = () => { setUnfulfillableSku(null); setUnfulfillableReason('Not ready'); setUnfulfillableNote(''); setAvailableQty(''); setAllocationPreview(null) }
        const showPreview = allocationPreview !== null
        const canConfirm = showPreview && allocationPreview.unfulfillable.length > 0 && !(unfulfillableReason === 'Other' && !unfulfillableNote.trim())

        return (
          <Modal title="Mark SKU Unfulfillable" onClose={closeModal} width={520}>
            {/* SKU pill */}
            <div style={{ fontFamily: 'DM Mono', fontSize: 13, background: 'var(--bg2)', padding: '8px 12px', borderRadius: 6, marginBottom: 20, color: 'var(--text)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{unfulfillableSku}</span>
              <span style={{ color: 'var(--text3)', fontSize: 12 }}>{skuOrders.length} orders · {totalQty} pcs total</span>
            </div>

            {/* Step 1: Available qty */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text2)', marginBottom: 8, fontWeight: 600 }}>
                How many pieces are available to dispatch?
              </label>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input
                  type="number" min={0} max={totalQty}
                  value={availableQty}
                  onChange={e => {
                    const val = e.target.value === '' ? '' : Math.min(Math.max(0, parseInt(e.target.value)), totalQty)
                    setAvailableQty(val as number | '')
                    setAllocationPreview(null)
                  }}
                  placeholder={`0 – ${totalQty}`}
                  style={{ width: 100, padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14, fontFamily: 'DM Mono', outline: 'none', textAlign: 'center' as const }}
                  onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
                <span style={{ fontSize: 13, color: 'var(--text3)' }}>out of {totalQty}</span>
                <button
                  onClick={() => {
                    if (availableQty === '' || (availableQty as number) >= totalQty) return
                    setAllocationPreview(computeAllocation(unfulfillableSku, availableQty as number))
                  }}
                  disabled={availableQty === '' || (availableQty as number) >= totalQty}
                  style={{
                    padding: '8px 16px', borderRadius: 7, border: 'none',
                    background: availableQty === '' || (availableQty as number) >= totalQty ? 'var(--bg2)' : 'var(--accent)',
                    color: availableQty === '' || (availableQty as number) >= totalQty ? 'var(--text3)' : '#fff',
                    fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  Preview Allocation
                </button>
              </div>
              {availableQty !== '' && (availableQty as number) >= totalQty && (
                <p style={{ fontSize: 12, color: 'var(--today)', marginTop: 6 }}>
                  If all pieces are available, no orders need to be marked unfulfillable.
                </p>
              )}
              {availableQty !== '' && availableQty === 0 && (
                <p style={{ fontSize: 12, color: 'var(--critical)', marginTop: 6 }}>
                  0 available — all {skuOrders.length} orders will be marked unfulfillable.
                </p>
              )}
            </div>

            {/* Allocation preview */}
            {showPreview && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                  <div style={{ background: 'var(--dispatched-bg)', border: '1px solid #bbf7d0', borderRadius: 7, padding: '10px 14px', textAlign: 'center' as const }}>
                    <div style={{ fontSize: 20, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--dispatched)' }}>{allocationPreview.dispatch.length}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>Will dispatch</div>
                  </div>
                  <div style={{ background: 'var(--critical-bg)', border: '1px solid #fecaca', borderRadius: 7, padding: '10px 14px', textAlign: 'center' as const }}>
                    <div style={{ fontSize: 20, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--critical)' }}>{allocationPreview.unfulfillable.length}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>Unfulfillable</div>
                  </div>
                </div>

                <p style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>Allocated by urgency — CRITICAL first, then TODAY, PLAN, HOLD:</p>

                <div style={{ border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden', maxHeight: 220, overflowY: 'auto' }}>
                  {/* Dispatch rows */}
                  {allocationPreview.dispatch.map((o, i) => {
                    const uc = {
                      CRITICAL: 'var(--critical)', TODAY: 'var(--today)',
                      PLAN: 'var(--plan)', HOLD: 'var(--hold)',
                    }[o.urgency as string] || 'var(--text3)'
                    return (
                      <div key={o.id} style={{
                        padding: '8px 12px',
                        borderBottom: '1px solid var(--border)',
                        background: '#f0fdf4',
                        display: 'flex', alignItems: 'center', gap: 10,
                      }}>
                        <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--dispatched)', background: 'var(--dispatched-bg)', padding: '2px 6px', borderRadius: 4, border: '1px solid #bbf7d0', whiteSpace: 'nowrap' as const }}>DISPATCH</span>
                        <span style={{ fontSize: 11, fontFamily: 'DM Mono', fontWeight: 600, color: uc, minWidth: 60 }}>{o.urgency}</span>
                        <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>{o.customer_name}</span>
                        <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'DM Mono' }}>d{o.days_left ?? '?'}</span>
                      </div>
                    )
                  })}
                  {/* Unfulfillable rows */}
                  {allocationPreview.unfulfillable.map((o, i) => {
                    const uc = {
                      CRITICAL: 'var(--critical)', TODAY: 'var(--today)',
                      PLAN: 'var(--plan)', HOLD: 'var(--hold)',
                    }[o.urgency as string] || 'var(--text3)'
                    return (
                      <div key={o.id} style={{
                        padding: '8px 12px',
                        borderBottom: i < allocationPreview.unfulfillable.length - 1 ? '1px solid var(--border)' : 'none',
                        background: '#fef2f2',
                        display: 'flex', alignItems: 'center', gap: 10,
                      }}>
                        <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--critical)', background: 'var(--critical-bg)', padding: '2px 6px', borderRadius: 4, border: '1px solid #fecaca', whiteSpace: 'nowrap' as const }}>UNFULFIL.</span>
                        <span style={{ fontSize: 11, fontFamily: 'DM Mono', fontWeight: 600, color: uc, minWidth: 60 }}>{o.urgency}</span>
                        <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>{o.customer_name}</span>
                        <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'DM Mono' }}>d{o.days_left ?? '?'}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Reason + note — only show after preview */}
            {showPreview && allocationPreview.unfulfillable.length > 0 && (
              <div style={{ marginBottom: 4 }}>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text2)', marginBottom: 6, fontWeight: 600 }}>Reason for unfulfillable orders</label>
                <select value={unfulfillableReason} onChange={e => setUnfulfillableReason(e.target.value as UnfulfillableReason)}
                  style={{ width: '100%', padding: '9px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, marginBottom: 12, cursor: 'pointer' }}>
                  {UNFULFILLABLE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text2)', marginBottom: 6, fontWeight: 500 }}>
                  {unfulfillableReason === 'Other' ? <>Note <span style={{ color: 'var(--critical)' }}>(required)</span></> : <>Note <span style={{ color: 'var(--text3)', fontWeight: 400 }}>(optional)</span></>}
                </label>
                <textarea value={unfulfillableNote} onChange={e => setUnfulfillableNote(e.target.value)}
                  placeholder={unfulfillableReason === 'Other' ? 'Describe the issue...' : 'Any additional context...'}
                  style={{ width: '100%', height: 68, padding: '9px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, fontFamily: 'DM Sans', resize: 'vertical' as const, outline: 'none' }}
                  onFocus={e => e.target.style.borderColor = 'var(--critical)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
              </div>
            )}

            <ModalActions
              onCancel={closeModal}
              onConfirm={handleUnfulfillableSku}
              confirmLabel={`Mark ${allocationPreview?.unfulfillable.length ?? 0} Orders Unfulfillable`}
              confirmColor="var(--critical)"
              disabled={!canConfirm}
            />
          </Modal>
        )
      })()}

      {/* EOD confirm */}
      {showEodConfirm && eodMatchResult && (
        <Modal title="Confirm EOD Dispatch" onClose={() => setShowEodConfirm(false)} width={520}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div style={{ padding: '12px 16px', background: 'var(--dispatched-bg)', border: '1px solid #bbf7d0', borderRadius: 7, textAlign: 'center' as const }}>
              <div style={{ fontSize: 24, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--dispatched)' }}>{eodMatchResult.matched.length}</div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>AWBs matched</div>
            </div>
            <div style={{ padding: '12px 16px', background: eodMatchResult.unmatched.length > 0 ? 'var(--critical-bg)' : 'var(--bg2)', border: `1px solid ${eodMatchResult.unmatched.length > 0 ? '#fecaca' : 'var(--border)'}`, borderRadius: 7, textAlign: 'center' as const }}>
              <div style={{ fontSize: 24, fontFamily: 'DM Mono', fontWeight: 600, color: eodMatchResult.unmatched.length > 0 ? 'var(--critical)' : 'var(--text3)' }}>{eodMatchResult.unmatched.length}</div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>Unmatched</div>
            </div>
          </div>
          {eodMatchResult.unmatched.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <p style={{ fontSize: 12, color: 'var(--critical)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}><AlertCircle size={13} /> These orders had no AWB — will remain pending:</p>
              <div style={{ border: '1px solid #fecaca', borderRadius: 6, maxHeight: 120, overflowY: 'auto' }}>
                {eodMatchResult.unmatched.map(o => (
                  <div key={o.orderId} style={{ padding: '6px 12px', borderBottom: '1px solid #fecaca', fontSize: 12, fontFamily: 'DM Mono', color: 'var(--critical)' }}>{o.customerName} — {o.sku}</div>
                ))}
              </div>
            </div>
          )}
          <p style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 4 }}>Matched orders will be marked dispatched with their AWB numbers. This cannot be undone.</p>
          <ModalActions onCancel={() => setShowEodConfirm(false)} onConfirm={confirmEOD} confirmLabel="Confirm & Mark Dispatched" confirmColor="var(--dispatched)" />
        </Modal>
      )}

      {/* ── Header ── */}
      <header style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', padding: '0 32px', height: 56, display: 'flex', alignItems: 'center', position: 'sticky' as const, top: 0, zIndex: 100, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 32 }}>
          <div style={{ width: 30, height: 30, background: 'var(--accent)', borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'DM Mono', fontWeight: 500, fontSize: 14, color: '#fff' }}>D</div>
          <span style={{ fontFamily: 'DM Mono', fontWeight: 500, fontSize: 15, color: 'var(--text)' }}>DispatchLens</span>
        </div>
        <nav style={{ display: 'flex', gap: 2, flex: 1 }}>
          {([
            { key: 'import', label: 'Import', show: access.can_import },
            { key: 'plan', label: activeOrders.length ? `Plan (${activeOrders.length})` : 'Plan', show: access.can_plan },
            { key: 'review', label: reviewCount > 0 ? `Review (${reviewCount})` : 'Review', show: access.can_review },
            { key: 'picklist', label: dispatchTodayCount ? `Picklist (${dispatchTodayCount})` : 'Picklist', show: access.can_picklist },
            { key: 'eod', label: 'End of Day', show: access.can_eod },
            { key: 'users', label: 'Users', show: access.can_users },
          ] as { key: Tab; label: string; show: boolean }[]).filter(t => t.show).map(({ key, label }) => (
            <button key={key} onClick={() => setTab(key)} style={{
              padding: '6px 16px', border: 'none', borderRadius: 6,
              background: tab === key ? 'var(--accent-bg)' : 'transparent',
              color: tab === key ? 'var(--accent)' : 'var(--text2)',
              fontFamily: 'DM Sans', fontWeight: tab === key ? 600 : 400, fontSize: 14,
              cursor: 'pointer', transition: 'all 0.15s',
              position: 'relative' as const,
            }}>
              {label}
              {key === 'review' && reviewCount > 0 && (
                <span style={{ position: 'absolute' as const, top: 2, right: 4, width: 6, height: 6, borderRadius: '50%', background: 'var(--today)' }} />
              )}
            </button>
          ))}
        </nav>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text3)', background: 'var(--bg2)', padding: '4px 10px', borderRadius: 20, border: '1px solid var(--border)' }}>
            {new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {user.user_metadata?.avatar_url && <img src={user.user_metadata.avatar_url} alt="" style={{ width: 28, height: 28, borderRadius: '50%' }} />}
            <span style={{ fontSize: 13, color: 'var(--text2)' }}>{user.user_metadata?.name?.split(' ')[0] || user.email?.split('@')[0]}</span>
          </div>
          <button onClick={handleSignOut} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text3)', cursor: 'pointer', padding: '5px 8px', display: 'flex', alignItems: 'center' }}><LogOut size={13} /></button>
        </div>
      </header>

      <main style={{ flex: 1, padding: '28px 32px', maxWidth: 1600, margin: '0 auto', width: '100%' }}>

        {/* ════ IMPORT ════ */}
        {tab === 'import' && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h1 style={{ fontSize: 18, fontWeight: 600 }}>Import Orders</h1>
              {orders.length > 0 && (
                <span style={{ fontSize: 13, color: 'var(--text3)', fontFamily: 'DM Mono' }}>
                  {orders.filter(o => !o.is_cancelled && !o.is_dispatched).length} active orders in pool
                </span>
              )}
            </div>
            <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                  {[
                    { key: 'dl', label: 'DELHIVERY', color: '#7c3aed', text: delhiveryText, set: setDelhiveryText },
                    { key: 'bd', label: 'BLUEDART', color: '#2563eb', text: bluedartText, set: setBluedartText },
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
                  <button onClick={handleImport} disabled={importing || (!delhiveryText.trim() && !bluedartText.trim())} style={{ padding: '9px 22px', borderRadius: 7, background: importing || (!delhiveryText.trim() && !bluedartText.trim()) ? 'var(--bg2)' : 'var(--accent)', border: 'none', color: importing || (!delhiveryText.trim() && !bluedartText.trim()) ? 'var(--text3)' : '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Upload size={15} />{importing ? 'Importing…' : 'Import Orders'}
                  </button>
                  {importResult && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--dispatched)', fontSize: 13, fontWeight: 500 }}>
                      <CheckCircle size={15} />{importResult.added} orders imported
                      {importResult.skipped > 0 && <span style={{ color: 'var(--text3)' }}>· {importResult.skipped} skipped</span>}
                    </div>
                  )}
                  {orders.length > 0 && (
                    <button onClick={() => setTab('plan')} style={{ marginLeft: 'auto', padding: '9px 18px', borderRadius: 7, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
                      Go to Plan <ArrowRight size={14} />
                    </button>
                  )}
                </div>
            </>
          </div>
        )}

        {/* ════ PLAN ════ */}
        {tab === 'plan' && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
            {/* KPI cards */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' as const, alignItems: 'stretch' }}>
              {[
                { key: 'ALL' as ActiveFilter, label: 'Total Active', value: activeOrders.length, color: 'var(--text)', bg: 'var(--surface)', border: 'var(--border)' },
                { key: 'undecided' as ActiveFilter, label: 'Undecided', value: undecidedCount, color: 'var(--today)', bg: 'var(--today-bg)', border: '#fed7aa' },
                { key: 'scheduled' as ActiveFilter, label: 'Scheduled', value: scheduledCount, color: 'var(--dispatched)', bg: 'var(--dispatched-bg)', border: '#bbf7d0' },
                { key: 'scheduled_today' as ActiveFilter, label: 'Going Today', value: dispatchTodayCount, color: '#059669', bg: '#ecfdf5', border: '#6ee7b7' },
                { key: 'hold' as ActiveFilter, label: 'On Hold', value: holdCount, color: 'var(--hold)', bg: 'var(--hold-bg)', border: '#bfdbfe' },
                { key: 'unfulfillable' as ActiveFilter, label: 'Unfulfillable', value: unfulfillableCount, color: 'var(--critical)', bg: 'var(--critical-bg)', border: '#fecaca' },
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
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {URGENCY_ORDER.map(tier => {
                  const uc = urgencyStyle(tier)
                  const isActive = activeFilter === tier
                  return (
                    <button key={tier} onClick={() => toggleFilter(tier)} style={{ padding: '5px 12px', borderRadius: 6, border: `1px solid ${isActive ? uc.border : 'var(--border)'}`, background: isActive ? uc.bg : 'var(--surface)', color: isActive ? uc.color : 'var(--text2)', fontSize: 11, fontFamily: 'DM Mono', cursor: 'pointer', fontWeight: 500 }}>
                      {tier}{tierCounts[tier] ? ` (${tierCounts[tier]})` : ''}
                    </button>
                  )
                })}
                <button onClick={() => loadOrders()} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text2)', cursor: 'pointer', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <RefreshCw size={12} />
                </button>
              </div>
            </div>

            {/* Bulk bar */}
            {selectedIds.size > 0 && (
              <div style={{ background: 'var(--text)', borderRadius: 8, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>{selectedIds.size} selected</span>
                <div style={{ flex: 1 }} />
                <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>Mark as:</span>
                {([
                  { d: 'scheduled' as PlanDecision, label: 'Schedule', bg: 'var(--dispatched)' },
                  { d: 'hold' as PlanDecision, label: 'Hold', bg: 'var(--hold)' },
                  { d: 'unfulfillable' as PlanDecision, label: 'Unfulfillable', bg: 'var(--critical)' },
                ]).map(({ d, label, bg }) => (
                  <button key={d} onClick={() => { setBulkDecision(d); setShowBulkConfirm(true) }} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: bg, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{label}</button>
                ))}
                <button onClick={() => setSelectedIds(new Set())} style={{ background: 'none', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, color: 'rgba(255,255,255,0.6)', cursor: 'pointer', padding: '5px 10px', fontSize: 12 }}>Clear</button>
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
                          <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} style={{ cursor: 'pointer', width: 14, height: 14, accentColor: 'var(--accent)' }} />
                        </th>
                        {/* Priority */}
                        <th style={{ padding: '9px 12px', width: 32 }} />
                        {/* Sortable headers */}
                        {([
                          { label: 'Urgency', col: 'urgency' },
                          { label: 'Order ID', col: null },
                          { label: 'Customer', col: 'customer' },
                          { label: 'SKU', col: 'sku' },
                          { label: 'COURIER_SPECIAL', col: 'courier' },
                          { label: 'Pincode · City', col: 'pincode' },
                          { label: 'ODA', col: null },
                          { label: 'AWB', col: null },
                          { label: 'Transit', col: 'transit' },
                          { label: 'Promise', col: 'promise' },
                        ] as { label: string; col: string | null }[]).map(({ label, col }) => {
                          // Special courier header with filter
                          if (label === 'COURIER_SPECIAL') return (
                            <th key="courier" style={{ padding: '9px 12px', whiteSpace: 'nowrap' as const }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <span
                                  onClick={() => handleColSort('courier')}
                                  style={{ color: sortCol === 'courier' ? 'var(--accent)' : 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, cursor: 'pointer', userSelect: 'none' as const }}
                                >
                                  Cour.{sortCol === 'courier' ? <span style={{ marginLeft: 3 }}>{sortDir === 'asc' ? '↑' : '↓'}</span> : <span style={{ marginLeft: 3, opacity: 0.3 }}>↕</span>}
                                </span>
                                <button
                                  onClick={e => {
                                    e.stopPropagation()
                                    const rect = e.currentTarget.getBoundingClientRect()
                                    setCourierPopoverPos({ top: rect.bottom + 6, left: rect.left })
                                    setShowCourierPopover(v => !v)
                                    setShowDaysPopover(false)
                                  }}
                                  style={{
                                    background: courierFilter.size > 0 ? 'var(--accent-bg)' : 'none',
                                    border: courierFilter.size > 0 ? '1px solid var(--accent)' : '1px solid var(--border)',
                                    borderRadius: 4, cursor: 'pointer', padding: '1px 5px',
                                    color: courierFilter.size > 0 ? 'var(--accent)' : 'var(--text3)',
                                    fontSize: 10, fontFamily: 'DM Mono', lineHeight: 1.4,
                                  }}
                                >
                                  {courierFilter.size > 0 ? `${courierFilter.size} ▾` : '▾'}
                                </button>
                                {courierFilter.size > 0 && (
                                  <button onClick={() => setCourierFilter(new Set())} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 10, padding: '0 2px' }}>✕</button>
                                )}
                              </div>
                              {/* Courier popover */}
                              {showCourierPopover && (
                                <div
                                  style={{
                                    position: 'fixed' as const,
                                    top: courierPopoverPos.top,
                                    left: courierPopoverPos.left,
                                    zIndex: 500,
                                    background: 'var(--surface)', border: '1px solid var(--border)',
                                    borderRadius: 8, padding: 12, minWidth: 160,
                                    boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                                  }}
                                  onClick={e => e.stopPropagation()}
                                >
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                    <span style={{ fontSize: 11, color: 'var(--text2)', fontFamily: 'DM Mono', fontWeight: 500 }}>COURIER</span>
                                    <button onClick={() => { setCourierFilter(new Set()); setShowCourierPopover(false) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 11 }}>Clear</button>
                                  </div>
                                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2 }}>
                                    {(['Bluedart', 'Delhivery'] as const).map(courier => {
                                      const isSelected = courierFilter.has(courier)
                                      const count = activeOrders.filter(o => o.courier === courier).length
                                      const color = courier === 'Bluedart' ? '#2563eb' : '#7c3aed'
                                      return (
                                        <button key={courier} onClick={() => {
                                          setCourierFilter(prev => {
                                            const n = new Set(prev)
                                            n.has(courier) ? n.delete(courier) : n.add(courier)
                                            return n
                                          })
                                        }} style={{
                                          display: 'flex', alignItems: 'center', gap: 8,
                                          padding: '6px 8px', borderRadius: 5, border: 'none',
                                          background: isSelected ? 'var(--accent-bg)' : 'transparent',
                                          cursor: 'pointer', textAlign: 'left' as const, width: '100%',
                                        }}>
                                          <span style={{ width: 14, height: 14, borderRadius: 3, border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--border2)'}`, background: isSelected ? 'var(--accent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                            {isSelected && <span style={{ color: '#fff', fontSize: 9, lineHeight: 1 }}>✓</span>}
                                          </span>
                                          <span style={{ fontSize: 12, fontFamily: 'DM Mono', fontWeight: 600, color }}>{courier === 'Bluedart' ? 'BD' : 'DL'}</span>
                                          <span style={{ fontSize: 11, color: 'var(--text)', flex: 1 }}>{courier}</span>
                                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>{count}</span>
                                        </button>
                                      )
                                    })}
                                  </div>
                                  <button onClick={() => setShowCourierPopover(false)} style={{ marginTop: 10, width: '100%', padding: '6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12 }}>Done</button>
                                </div>
                              )}
                            </th>
                          )
                          return (
                          <th key={label}
                            onClick={() => col && handleColSort(col)}
                            style={{
                              padding: '9px 12px', textAlign: 'left' as const,
                              color: sortCol === col ? 'var(--accent)' : 'var(--text3)',
                              fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500,
                              whiteSpace: 'nowrap' as const,
                              cursor: col ? 'pointer' : 'default',
                              userSelect: 'none' as const,
                            }}>
                            {label}
                            {col && sortCol === col && (
                              <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>
                            )}
                            {col && sortCol !== col && (
                              <span style={{ marginLeft: 4, opacity: 0.3 }}>↕</span>
                            )}
                          </th>
                          )
                        })}
                        {/* Days Left — with filter popover */}
                        <th style={{ padding: '9px 12px', textAlign: 'left' as const, whiteSpace: 'nowrap' as const }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span
                              onClick={() => handleColSort('days_left')}
                              style={{ color: sortCol === 'days_left' ? 'var(--accent)' : 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, cursor: 'pointer', userSelect: 'none' as const }}
                            >
                              Days Left
                              {sortCol === 'days_left' ? <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span> : <span style={{ marginLeft: 4, opacity: 0.3 }}>↕</span>}
                            </span>
                            {/* Filter button */}
                            <button
                              onClick={e => {
                                e.stopPropagation()
                                const rect = e.currentTarget.getBoundingClientRect()
                                setPopoverPos({ top: rect.bottom + 6, left: rect.left })
                                setShowDaysPopover(v => !v)
                              }}
                              style={{
                                background: daysFilter.size > 0 ? 'var(--accent-bg)' : 'none',
                                border: daysFilter.size > 0 ? '1px solid var(--accent)' : '1px solid var(--border)',
                                borderRadius: 4, cursor: 'pointer', padding: '1px 5px',
                                color: daysFilter.size > 0 ? 'var(--accent)' : 'var(--text3)',
                                fontSize: 10, fontFamily: 'DM Mono', lineHeight: 1.4,
                              }}
                            >
                              {daysFilter.size > 0 ? `${daysFilter.size} ▾` : '▾'}
                            </button>
                            {daysFilter.size > 0 && (
                              <button onClick={() => setDaysFilter(new Set())} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 10, padding: '0 2px' }}>✕</button>
                            )}
                          </div>
                          {/* Popover — fixed position to escape table clipping */}
                          {showDaysPopover && (
                            <div
                              style={{
                                position: 'fixed' as const,
                                top: popoverPos.top,
                                left: popoverPos.left,
                                zIndex: 500,
                                background: 'var(--surface)', border: '1px solid var(--border)',
                                borderRadius: 8, padding: 12, minWidth: 180,
                                boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                              }}
                              onClick={e => e.stopPropagation()}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                <span style={{ fontSize: 11, color: 'var(--text2)', fontFamily: 'DM Mono', fontWeight: 500 }}>DAYS LEFT</span>
                                <button onClick={() => { setDaysFilter(new Set()); setShowDaysPopover(false) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 11 }}>Clear</button>
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2, maxHeight: 220, overflowY: 'auto' }}>
                                {uniqueDaysLeft.map(d => {
                                  const isSelected = daysFilter.has(d)
                                  const color = d <= 0 ? 'var(--critical)' : d <= 2 ? 'var(--today)' : d === 3 ? 'var(--plan)' : 'var(--hold)'
                                  return (
                                    <button key={d} onClick={() => {
                                      setDaysFilter(prev => {
                                        const n = new Set(prev)
                                        n.has(d) ? n.delete(d) : n.add(d)
                                        return n
                                      })
                                    }} style={{
                                      display: 'flex', alignItems: 'center', gap: 8,
                                      padding: '5px 8px', borderRadius: 5, border: 'none',
                                      background: isSelected ? 'var(--accent-bg)' : 'transparent',
                                      cursor: 'pointer', textAlign: 'left' as const, width: '100%',
                                    }}>
                                      <span style={{ width: 14, height: 14, borderRadius: 3, border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--border2)'}`, background: isSelected ? 'var(--accent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                        {isSelected && <span style={{ color: '#fff', fontSize: 9, lineHeight: 1 }}>✓</span>}
                                      </span>
                                      <span style={{ fontFamily: 'DM Mono', fontSize: 13, fontWeight: 600, color }}>{d}</span>
                                      <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 'auto' }}>
                                        {activeOrders.filter(o => displayDaysLeft(o.days_left) === d).length}
                                      </span>
                                    </button>
                                  )
                                })}
                              </div>
                              <button onClick={() => setShowDaysPopover(false)} style={{ marginTop: 10, width: '100%', padding: '6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12 }}>Done</button>
                            </div>
                          )}
                        </th>
                        <th style={{ padding: '9px 12px', color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500 }}>Decision</th>
                        <th style={{ padding: '9px 12px', width: 32 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {filteredActive.map(order => (
                        <OrderRow key={order.id} order={order}
                          selected={selectedIds.has(order.id)}
                          updating={updatingIds.has(order.id)}
                          daysLeftDisplay={displayDaysLeft(order.days_left)}
                          onSelect={toggleSelect}
                          onDecision={updateDecision}
                          onSchedule={scheduleOrder}
                          onPriority={togglePriority}
                          onCancel={id => setCancelOrderId(id)}
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
                        {o.manual_cancelled && <span style={{ color: 'var(--critical)', fontSize: 10 }}>MANUAL</span>}
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

        {/* ════ REVIEW ════ */}
        {tab === 'review' && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h1 style={{ fontSize: 18, fontWeight: 600 }}>Review — Unfulfillable Orders</h1>
              <span style={{ color: 'var(--text3)', fontSize: 14 }}>{unfulfillableOrders.length} orders need a decision</span>
            </div>

            {unfulfillableOrders.length === 0 ? (
              <div style={{ ...card, padding: 60, textAlign: 'center' as const, color: 'var(--text2)' }}>
                <CheckCircle size={28} style={{ margin: '0 auto 12px', color: 'var(--dispatched)' }} />
                <p>No unfulfillable orders. All orders have been planned.</p>
              </div>
            ) : (
              <>
                {/* Group by reason */}
                {UNFULFILLABLE_REASONS.map(reason => {
                  const group = unfulfillableOrders.filter(o => o.unfulfillable_reason === reason)
                  if (group.length === 0) return null
                  return (
                    <div key={reason} style={{ ...card, overflow: 'hidden' }}>
                      <div style={{ padding: '12px 20px', background: 'var(--bg2)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontFamily: 'DM Mono', fontWeight: 500, fontSize: 13, color: 'var(--critical)' }}>{reason}</span>
                        <span style={{ fontSize: 12, color: 'var(--text3)' }}>{group.length} order{group.length !== 1 ? 's' : ''}</span>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            {['Customer', 'SKU', 'Courier', 'Promise', 'Days Left', 'Urgency', 'Note', 'Target Dispatch Date', 'Action'].map(h => (
                              <th key={h} style={{ padding: '8px 16px', textAlign: 'left' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, whiteSpace: 'nowrap' as const }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {group.map((order, i) => {
                            const uc = urgencyStyle(order.urgency)
                            const savedDate = order.target_dispatch_date
                            const inputDate = targetDates[order.id] ?? (savedDate || '')
                            return (
                              <tr key={order.id} style={{ borderBottom: i < group.length - 1 ? '1px solid var(--border)' : 'none', background: savedDate ? '#f0fdf4' : 'transparent' }}>
                                <td style={{ padding: '10px 16px' }}>
                                  <div style={{ fontSize: 13, fontWeight: 500 }}>{order.customer_name}</div>
                                  <div style={{ fontSize: 11, fontFamily: 'DM Mono', color: 'var(--text3)', marginTop: 2 }}>{order.order_id.slice(0, 18)}</div>
                                </td>
                                <td style={{ padding: '10px 16px' }}>
                                  <span style={{ fontFamily: 'DM Mono', fontSize: 11, background: 'var(--bg2)', padding: '2px 6px', borderRadius: 4 }}>{order.sku}</span>
                                </td>
                                <td style={{ padding: '10px 16px' }}>
                                  <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 500, color: order.courier === 'Bluedart' ? '#2563eb' : '#7c3aed', background: order.courier === 'Bluedart' ? '#eff6ff' : '#f5f3ff', padding: '2px 7px', borderRadius: 4 }}>
                                    {order.courier === 'Bluedart' ? 'BD' : 'DL'}
                                  </span>
                                </td>
                                <td style={{ padding: '10px 16px' }}>
                                  <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text2)' }}>
                                    {order.promise_date ? new Date(order.promise_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}
                                  </span>
                                </td>
                                <td style={{ padding: '10px 16px', textAlign: 'center' as const }}>
                                  <span style={{ fontFamily: 'DM Mono', fontSize: 14, fontWeight: 600, color: uc.color }}>{order.days_left ?? '—'}</span>
                                </td>
                                <td style={{ padding: '10px 16px' }}>
                                  <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontFamily: 'DM Mono', fontWeight: 500, color: uc.color, background: uc.bg, border: `1px solid ${uc.border}` }}>
                                    {order.urgency || '—'}
                                  </span>
                                </td>
                                <td style={{ padding: '10px 16px', maxWidth: 180 }}>
                                  <span style={{ fontSize: 12, color: 'var(--text2)', fontStyle: order.unfulfillable_note ? 'normal' : 'italic' }}>
                                    {order.unfulfillable_note || '—'}
                                  </span>
                                </td>
                                {/* Target date + save */}
                                <td style={{ padding: '10px 16px', whiteSpace: 'nowrap' as const }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <input type="date"
                                      value={inputDate}
                                      min={new Date().toISOString().split('T')[0]}
                                      onChange={e => setTargetDates(prev => ({ ...prev, [order.id]: e.target.value }))}
                                      style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, fontFamily: 'DM Mono', cursor: 'pointer' }}
                                    />
                                    {(targetDates[order.id] && targetDates[order.id] !== savedDate) && (
                                      <button onClick={() => saveTargetDate(order.id)} disabled={savingReview === order.id} style={{ padding: '5px 10px', borderRadius: 6, border: 'none', background: 'var(--dispatched)', color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                                        {savingReview === order.id ? '…' : 'Save'}
                                      </button>
                                    )}
                                    {savedDate && (!targetDates[order.id] || targetDates[order.id] === savedDate) && (
                                      <span style={{ fontSize: 11, color: 'var(--dispatched)', display: 'flex', alignItems: 'center', gap: 3 }}>
                                        <CheckCircle size={12} /> Saved
                                      </span>
                                    )}
                                  </div>
                                </td>
                                {/* Cancel from review */}
                                <td style={{ padding: '10px 16px' }}>
                                  <button onClick={() => cancelFromReview(order.id)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #fecaca', background: 'var(--critical-bg)', color: 'var(--critical)', fontSize: 11, cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <Ban size={11} /> Cancel Order
                                  </button>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )
                })}

                {/* Orders with no reason set (bulk-marked unfulfillable from plan tab) */}
                {(() => {
                  const noReason = unfulfillableOrders.filter(o => !o.unfulfillable_reason)
                  if (noReason.length === 0) return null
                  return (
                    <div style={{ ...card, overflow: 'hidden' }}>
                      <div style={{ padding: '12px 20px', background: 'var(--bg2)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontFamily: 'DM Mono', fontWeight: 500, fontSize: 13, color: 'var(--text2)' }}>No reason assigned</span>
                        <span style={{ fontSize: 12, color: 'var(--text3)' }}>{noReason.length} order{noReason.length !== 1 ? 's' : ''}</span>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            {['Customer', 'SKU', 'Courier', 'Promise', 'Days Left', 'Target Dispatch Date', 'Action'].map(h => (
                              <th key={h} style={{ padding: '8px 16px', textAlign: 'left' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500 }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {noReason.map((order, i) => {
                            const uc = urgencyStyle(order.urgency)
                            const savedDate = order.target_dispatch_date
                            const inputDate = targetDates[order.id] ?? (savedDate || '')
                            return (
                              <tr key={order.id} style={{ borderBottom: i < noReason.length - 1 ? '1px solid var(--border)' : 'none', background: savedDate ? '#f0fdf4' : 'transparent' }}>
                                <td style={{ padding: '10px 16px' }}>
                                  <div style={{ fontSize: 13, fontWeight: 500 }}>{order.customer_name}</div>
                                  <div style={{ fontSize: 11, fontFamily: 'DM Mono', color: 'var(--text3)', marginTop: 2 }}>{order.order_id.slice(0, 18)}</div>
                                </td>
                                <td style={{ padding: '10px 16px' }}><span style={{ fontFamily: 'DM Mono', fontSize: 11, background: 'var(--bg2)', padding: '2px 6px', borderRadius: 4 }}>{order.sku}</span></td>
                                <td style={{ padding: '10px 16px' }}><span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 500, color: order.courier === 'Bluedart' ? '#2563eb' : '#7c3aed' }}>{order.courier === 'Bluedart' ? 'BD' : 'DL'}</span></td>
                                <td style={{ padding: '10px 16px' }}><span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text2)' }}>{order.promise_date ? new Date(order.promise_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}</span></td>
                                <td style={{ padding: '10px 16px', textAlign: 'center' as const }}><span style={{ fontFamily: 'DM Mono', fontSize: 14, fontWeight: 600, color: uc.color }}>{order.days_left ?? '—'}</span></td>
                                <td style={{ padding: '10px 16px', whiteSpace: 'nowrap' as const }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <input type="date" value={inputDate} min={new Date().toISOString().split('T')[0]}
                                      onChange={e => setTargetDates(prev => ({ ...prev, [order.id]: e.target.value }))}
                                      style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, fontFamily: 'DM Mono' }}
                                    />
                                    {(targetDates[order.id] && targetDates[order.id] !== savedDate) && (
                                      <button onClick={() => saveTargetDate(order.id)} disabled={savingReview === order.id} style={{ padding: '5px 10px', borderRadius: 6, border: 'none', background: 'var(--dispatched)', color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                                        {savingReview === order.id ? '…' : 'Save'}
                                      </button>
                                    )}
                                    {savedDate && (!targetDates[order.id] || targetDates[order.id] === savedDate) && <span style={{ fontSize: 11, color: 'var(--dispatched)', display: 'flex', alignItems: 'center', gap: 3 }}><CheckCircle size={12} /> Saved</span>}
                                  </div>
                                </td>
                                <td style={{ padding: '10px 16px' }}>
                                  <button onClick={() => cancelFromReview(order.id)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #fecaca', background: 'var(--critical-bg)', color: 'var(--critical)', fontSize: 11, cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <Ban size={11} /> Cancel Order
                                  </button>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )
                })()}
              </>
            )}
          </div>
        )}

        {/* ════ PICKLIST ════ */}
        {tab === 'picklist' && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <h1 style={{ fontSize: 18, fontWeight: 600 }}>Picklist</h1>
              <span style={{ color: 'var(--text3)', fontSize: 14 }}>
                {scheduledCount} orders scheduled · {picklist.reduce((s, g) => s + g.couriers.reduce((cs, c) => cs + c.items.reduce((is, i) => is + i.qty, 0), 0), 0)} pieces
              </span>
              <button onClick={() => window.print()} style={{ marginLeft: 'auto', padding: '8px 16px', borderRadius: 7, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
                <Printer size={14} /> Print
              </button>
            </div>

            {picklist.length === 0 ? (
              <div style={{ ...card, padding: 48, textAlign: 'center' as const, color: 'var(--text2)' }}>
                No orders scheduled yet. Go to Plan tab and assign dispatch dates.
              </div>
            ) : (
              picklist.map(({ date, couriers: courierGroups }) => {
                const isToday = date === today
                const isFuture = date > today
                const dateLabel = isToday
                  ? `Today — ${new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}`
                  : date === 'Unscheduled' ? 'No date set'
                  : new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
                const totalOrders = courierGroups.reduce((s, c) => s + c.items.reduce((si, i) => si + i.count, 0), 0)
                const totalPcs = courierGroups.reduce((s, c) => s + c.items.reduce((si, i) => si + i.qty, 0), 0)

                return (
                  <div key={date}>
                    {/* Date header */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '6px 14px', borderRadius: 20,
                        background: isToday ? '#ecfdf5' : isFuture ? 'var(--hold-bg)' : 'var(--bg2)',
                        border: `1px solid ${isToday ? '#6ee7b7' : isFuture ? '#bfdbfe' : 'var(--border)'}`,
                      }}>
                        <Calendar size={13} style={{ color: isToday ? '#059669' : isFuture ? 'var(--hold)' : 'var(--text3)' }} />
                        <span style={{ fontFamily: 'DM Mono', fontSize: 13, fontWeight: 600, color: isToday ? '#059669' : isFuture ? 'var(--hold)' : 'var(--text2)' }}>
                          {dateLabel}
                        </span>
                      </div>
                      <span style={{ color: 'var(--text3)', fontSize: 13 }}>{totalOrders} orders · {totalPcs} pcs</span>
                    </div>

                    {/* Courier tables side by side */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                      {courierGroups.map(({ courier, items }) => {
                        const totalQty = items.reduce((s, i) => s + i.qty, 0)
                        const cc = courier === 'Bluedart' ? '#2563eb' : '#7c3aed'
                        return (
                          <div key={courier} style={{ ...card, overflow: 'hidden' }}>
                            <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)', display: 'flex', alignItems: 'center', gap: 10 }}>
                              <div style={{ width: 8, height: 8, borderRadius: '50%', background: cc }} />
                              <span style={{ fontFamily: 'DM Mono', fontWeight: 500, fontSize: 13 }}>{courier}</span>
                              <span style={{ marginLeft: 'auto', color: 'var(--text3)', fontSize: 12 }}>{items.length} SKUs · {totalQty} pcs</span>
                            </div>
                            <table style={{ width: '100%', borderCollapse: 'collapse' as const }}>
                              <thead>
                                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                  {['SKU', 'ORDERS', 'QTY', 'ACTION'].map(h => (
                                    <th key={h} style={{ padding: '7px 16px', textAlign: h === 'SKU' || h === 'ACTION' ? 'left' as const : 'right' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500 }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {items.map((item, i) => {
                                  const isUnfulfillable = orders.some(o => o.sku === item.sku && o.plan_decision === 'unfulfillable' && !o.is_cancelled)
                                  return (
                                    <tr key={item.sku} style={{ borderBottom: i < items.length - 1 ? '1px solid var(--border)' : 'none', background: isUnfulfillable ? 'var(--critical-bg)' : 'transparent' }}>
                                      <td style={{ padding: '9px 16px', fontFamily: 'DM Mono', fontSize: 12, color: isUnfulfillable ? 'var(--critical)' : 'var(--text)' }}>{item.sku}</td>
                                      <td style={{ padding: '9px 16px', textAlign: 'right' as const, color: 'var(--text2)', fontSize: 13 }}>{item.count}</td>
                                      <td style={{ padding: '9px 16px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 600, color: cc, fontSize: 14 }}>{item.qty}</td>
                                      <td style={{ padding: '9px 16px' }}>
                                        {!isUnfulfillable ? (
                                          <button onClick={() => { setUnfulfillableSku(item.sku); setUnfulfillableReason('Not ready'); setUnfulfillableNote(''); setAvailableQty(''); setAllocationPreview(null) }}
                                            style={{ padding: '3px 9px', borderRadius: 5, border: '1px solid #fecaca', background: 'var(--critical-bg)', color: 'var(--critical)', fontSize: 11, cursor: 'pointer', fontWeight: 500 }}>
                                            Unfulfillable
                                          </button>
                                        ) : (
                                          <span style={{ fontSize: 11, color: 'var(--critical)', fontFamily: 'DM Mono', display: 'flex', alignItems: 'center', gap: 3 }}>
                                            <AlertCircle size={11} />
                                            {orders.find(o => o.sku === item.sku && o.unfulfillable_reason)?.unfulfillable_reason || 'Unfulfillable'}
                                          </span>
                                        )}
                                      </td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                              <tfoot>
                                <tr style={{ borderTop: '2px solid var(--border2)', background: 'var(--bg2)' }}>
                                  <td style={{ padding: '9px 16px', fontWeight: 600, fontSize: 13 }}>Total</td>
                                  <td style={{ padding: '9px 16px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: 'var(--text2)' }}>{items.reduce((s, i) => s + i.count, 0)}</td>
                                  <td style={{ padding: '9px 16px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, color: cc, fontSize: 16 }}>{totalQty}</td>
                                  <td />
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        )
                      })}
                      {/* Fill empty column if only one courier */}
                      {courierGroups.length === 1 && <div />}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        )}

        {/* ════ EOD ════ */}
        {tab === 'eod' && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 24, maxWidth: 700 }}>
            <h1 style={{ fontSize: 18, fontWeight: 600 }}>End of Day — {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</h1>
            {eodDone ? (
              <div style={{ ...card, padding: 32, border: '1px solid #bbf7d0', background: 'var(--dispatched-bg)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--dispatched)', marginBottom: 20 }}>
                  <CheckCircle size={22} /><span style={{ fontWeight: 700, fontSize: 16 }}>EOD Complete</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
                  {[{ label: 'Dispatched', value: dispatchedOrders.length, color: 'var(--dispatched)' }, { label: 'Held', value: holdCount, color: 'var(--hold)' }, { label: 'Unfulfillable', value: unfulfillableCount, color: 'var(--critical)' }].map(s => (
                    <div key={s.label} style={{ textAlign: 'center' as const }}>
                      <div style={{ fontSize: 32, fontFamily: 'DM Mono', fontWeight: 500, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                  {[
                    { label: "Going Today", value: dispatchTodayCount, color: '#059669', bg: '#ecfdf5' },
                    { label: 'Future Scheduled', value: scheduledCount - dispatchTodayCount, color: 'var(--hold)', bg: 'var(--hold-bg)' },
                    { label: 'On Hold', value: holdCount, color: 'var(--text2)', bg: 'var(--surface)' },
                    { label: 'Unfulfillable', value: unfulfillableCount, color: 'var(--critical)', bg: 'var(--critical-bg)' }
                  ].map(s => (
                    <div key={s.label} style={{ padding: 16, background: s.bg, border: '1px solid var(--border)', borderRadius: 8, textAlign: 'center' as const }}>
                      <div style={{ fontSize: 24, fontFamily: 'DM Mono', fontWeight: 500, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
                {/* Future scheduled orders info */}
                {scheduledCount - dispatchTodayCount > 0 && (
                  <div style={{ ...card, padding: 16 }}>
                    <div style={{ fontSize: 12, fontFamily: 'DM Mono', fontWeight: 500, color: 'var(--text2)', marginBottom: 10 }}>SCHEDULED FOR FUTURE DATES</div>
                    {Array.from(new Set(
                      orders.filter(o => o.plan_decision === 'scheduled' && o.scheduled_date && o.scheduled_date > today && !o.is_cancelled && !o.is_dispatched)
                        .map(o => o.scheduled_date!)
                    )).sort().map(date => {
                      const count = orders.filter(o => o.scheduled_date === date && o.plan_decision === 'scheduled').length
                      return (
                        <div key={date} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                          <Calendar size={13} style={{ color: 'var(--hold)' }} />
                          <span style={{ fontFamily: 'DM Mono', fontSize: 13, color: 'var(--text)' }}>
                            {new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
                          </span>
                          <span style={{ color: 'var(--text3)', fontSize: 12 }}>{count} orders</span>
                        </div>
                      )
                    })}
                  </div>
                )}
                {undecidedCount > 0 && (
                  <div style={{ padding: '12px 16px', background: 'var(--today-bg)', border: '1px solid #fed7aa', borderRadius: 8, color: 'var(--today)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <AlertTriangle size={15} />{undecidedCount} orders still undecided — complete Plan tab first.
                  </div>
                )}
                <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Truck size={14} style={{ color: 'var(--text2)' }} />
                    <span style={{ fontFamily: 'DM Mono', fontSize: 12, fontWeight: 500, color: 'var(--text2)', letterSpacing: '0.05em' }}>SHYPASSIST EXPORT</span>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text3)' }}>Paste SKU · QTY · AWB data</span>
                  </div>
                  <textarea value={shypassistText} onChange={e => { setShypassistText(e.target.value); setEodMatchResult(null) }}
                    placeholder={'SKU\tQTY\tAWB\nHT-DBM-EL-4x6\t1\t305328290\n...'}
                    style={{ height: 200, width: '100%', padding: '12px 14px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text)', fontFamily: 'DM Mono', fontSize: 12, resize: 'vertical' as const, outline: 'none', lineHeight: 1.5, transition: 'border-color 0.15s' }}
                    onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                  <button onClick={parseShypassist} disabled={!shypassistText.trim() || dispatchTodayCount === 0} style={{ padding: '9px 20px', borderRadius: 7, background: !shypassistText.trim() || dispatchTodayCount === 0 ? 'var(--bg2)' : 'var(--accent)', border: 'none', color: !shypassistText.trim() || dispatchTodayCount === 0 ? 'var(--text3)' : '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, width: 'fit-content' }}>
                    <CheckCircle size={14} /> Match & Preview
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ════ USERS ════ */}
        {tab === 'users' && (
          <UsersTab ownerEmail={user.email!} />
        )}
      </main>
    </div>
  )
}

// ── Order Row ──
function OrderRow({ order, selected, updating, onSelect, onDecision, onSchedule, onPriority, onCancel, daysLeftDisplay }: {
  order: DBOrder; selected: boolean; updating: boolean
  daysLeftDisplay: number | null
  onSelect: (id: string) => void
  onDecision: (id: string, d: PlanDecision) => void
  onSchedule: (id: string, date: string) => void
  onPriority: (id: string, current: boolean) => void
  onCancel: (id: string) => void
}) {
  const uc = {
    CRITICAL: { color: 'var(--critical)', bg: 'var(--critical-bg)', border: '#fecaca' },
    TODAY:    { color: 'var(--today)',    bg: 'var(--today-bg)',    border: '#fed7aa' },
    PLAN:     { color: 'var(--plan)',     bg: 'var(--plan-bg)',     border: '#fde68a' },
    HOLD:     { color: 'var(--hold)',     bg: 'var(--hold-bg)',     border: '#bfdbfe' },
  }[order.urgency as string] || { color: 'var(--text3)', bg: 'var(--bg2)', border: 'var(--border)' }

  const rowBg: Record<PlanDecision, string> = { scheduled: '#f0fdf4', hold: '#eff6ff', unfulfillable: '#fef2f2', undecided: 'transparent' }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)', background: selected ? '#fefce8' : updating ? 'var(--accent-bg)' : rowBg[order.plan_decision], transition: 'background 0.1s' }}>
      <td style={{ padding: '8px 12px' }}>
        <input type="checkbox" checked={selected} onChange={() => onSelect(order.id)} style={{ cursor: 'pointer', width: 14, height: 14, accentColor: 'var(--accent)' }} />
      </td>
      <td style={{ padding: '8px 12px', width: 36 }}>
        <button onClick={() => onPriority(order.id, order.is_priority)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: order.is_priority ? 'var(--accent)' : 'var(--border2)' }}>
          <Star size={14} fill={order.is_priority ? 'var(--accent)' : 'none'} />
        </button>
      </td>
      <td style={{ padding: '8px 12px' }}>
        <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontFamily: 'DM Mono', fontWeight: 500, letterSpacing: '0.05em', color: uc.color, background: uc.bg, border: `1px solid ${uc.border}` }}>{order.urgency || '—'}</span>
      </td>
      <td style={{ padding: '8px 12px' }}><span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{order.order_id.length > 20 ? order.order_id.slice(0, 20) + '…' : order.order_id}</span></td>
      <td style={{ padding: '8px 12px', maxWidth: 160 }}><span style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', maxWidth: 150 }}>{order.customer_name}</span></td>
      <td style={{ padding: '8px 12px' }}><span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text)', background: 'var(--bg2)', padding: '2px 6px', borderRadius: 4 }}>{order.sku}</span></td>
      <td style={{ padding: '8px 12px' }}><span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 500, color: order.courier === 'Bluedart' ? '#2563eb' : '#7c3aed', background: order.courier === 'Bluedart' ? '#eff6ff' : '#f5f3ff', padding: '2px 7px', borderRadius: 4, border: `1px solid ${order.courier === 'Bluedart' ? '#bfdbfe' : '#e9d5ff'}` }}>{order.courier === 'Bluedart' ? 'BD' : 'DL'}</span></td>
      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text)' }}>{order.pincode}</span>
        {order.city && <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 6 }}>{order.city}</span>}
      </td>
      <td style={{ padding: '8px 12px' }}>{order.oda === 'ODA' && <span style={{ fontSize: 10, fontFamily: 'DM Mono', color: 'var(--today)', background: 'var(--today-bg)', padding: '1px 5px', borderRadius: 3, border: '1px solid #fed7aa' }}>ODA</span>}</td>
      <td style={{ padding: '8px 12px' }}>
        {order.tracking_number
          ? <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--dispatched)', background: 'var(--dispatched-bg)', padding: '2px 6px', borderRadius: 4, border: '1px solid #bbf7d0' }}>{order.tracking_number}</span>
          : <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>—</span>
        }
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'center' as const }}><span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text3)' }}>{order.transit_days}d</span></td>
      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}><span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text2)' }}>{order.promise_date ? new Date(order.promise_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}</span></td>
      <td style={{ padding: '8px 12px', textAlign: 'center' as const }}><span style={{ fontFamily: 'DM Mono', fontSize: 14, fontWeight: 600, color: uc.color }}>{daysLeftDisplay !== null ? daysLeftDisplay : '—'}</span></td>
      <td style={{ padding: '6px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {/* Date picker — sets scheduled */}
          <div style={{ position: 'relative' as const }}>
            <input
              type="date"
              value={order.scheduled_date || ''}
              onChange={e => onSchedule(order.id, e.target.value)}
              style={{
                padding: '4px 8px',
                borderRadius: 5, fontSize: 11,
                border: `1px solid ${order.plan_decision === 'scheduled' ? '#bbf7d0' : 'var(--border)'}`,
                background: order.plan_decision === 'scheduled' ? 'var(--dispatched-bg)' : 'var(--surface)',
                color: order.plan_decision === 'scheduled' ? 'var(--dispatched)' : 'var(--text3)',
                cursor: 'pointer', fontFamily: 'DM Mono',
                width: 130,
              }}
            />
            {order.plan_decision === 'scheduled' && order.scheduled_date && (
              <button
                onClick={() => onSchedule(order.id, '')}
                title="Clear date"
                style={{ position: 'absolute' as const, right: 4, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 10, padding: '0 2px', lineHeight: 1 }}
              >✕</button>
            )}
          </div>
          {/* Hold */}
          <button onClick={() => onDecision(order.id, 'hold')} style={{
            padding: '4px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
            fontFamily: 'DM Sans', fontWeight: 500,
            background: order.plan_decision === 'hold' ? 'var(--hold-bg)' : 'var(--surface)',
            border: `1px solid ${order.plan_decision === 'hold' ? '#bfdbfe' : 'var(--border)'}`,
            color: order.plan_decision === 'hold' ? 'var(--hold)' : 'var(--text3)',
            whiteSpace: 'nowrap' as const,
          }}>Hold</button>
          {/* Unfulfillable */}
          <button onClick={() => onDecision(order.id, 'unfulfillable')} style={{
            padding: '4px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
            fontFamily: 'DM Sans', fontWeight: 500,
            background: order.plan_decision === 'unfulfillable' ? 'var(--critical-bg)' : 'var(--surface)',
            border: `1px solid ${order.plan_decision === 'unfulfillable' ? '#fecaca' : 'var(--border)'}`,
            color: order.plan_decision === 'unfulfillable' ? 'var(--critical)' : 'var(--text3)',
            whiteSpace: 'nowrap' as const,
          }}>Unfulfil.</button>
        </div>
      </td>
      <td style={{ padding: '8px 12px' }}>
        <button onClick={() => onCancel(order.id)} title="Cancel order" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 2, display: 'flex', alignItems: 'center', borderRadius: 4, transition: 'color 0.15s' }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--critical)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
        >
          <Ban size={13} />
        </button>
      </td>
    </tr>
  )
}
