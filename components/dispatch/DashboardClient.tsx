'use client'
import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { parseOrders } from '@/lib/parser'
import { DBOrder, DispatchSession, PlanDecision, UrgencyTier, Courier, UnfulfillableReason, SkuMap } from '@/types'
import UsersTab from './UsersTab'
import SkuMapTab from './SkuMapTab'
import CargoTokenPanel from './CargoTokenPanel'
import OrderHistoryPanel from './OrderHistoryPanel'
import InventoryTab from './InventoryTab'
import { buildSkuLookup, resolveBarcodeSku } from '@/lib/skuResolver'
import { User } from '@supabase/supabase-js'
import {
  Star, Printer, CheckCircle, ChevronDown, ChevronUp,
  Upload, LogOut, Package, Truck, AlertTriangle, Clock,
  RefreshCw, Plus, ArrowRight, X, AlertCircle, Calendar,
  Ban, History, Search, Pencil, Filter, ExternalLink, ScanLine, Download
} from 'lucide-react'

type Tab = 'import' | 'plan' | 'review' | 'picklist' | 'eod' | 'dispatched' | 'skumap' | 'users' | 'inventory'
type ActiveFilter = 'ALL' | UrgencyTier | 'scheduled' | 'scheduled_today' | 'slipped' | 'hold' | 'unfulfillable' | 'undecided' | 'unmapped'

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
  const [skuMaps, setSkuMaps] = useState<SkuMap[]>([])

  // Scan-out verification (EOD)
  const [scanAwb, setScanAwb] = useState('')
  const [scanItem, setScanItem] = useState('')
  const [scanOrder, setScanOrder] = useState<DBOrder | null>(null)
  const [scanResult, setScanResult] = useState<{ ok: boolean; expected: string; scanned: string } | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanCourier, setScanCourier] = useState<Courier | null>(null)
  const awbInputRef = useRef<HTMLInputElement>(null)
  const itemInputRef = useRef<HTMLInputElement>(null)

  // Import
  const [delhiveryText, setDelhiveryText] = useState('')
  const [bluedartText, setBluedartText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ added: number; updated: number; skipped: number; unmapped: number; unmappedSkus: { sku: string; count: number }[] } | null>(null)

  // Plan
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('ALL')
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [dispatchedSortCol, setDispatchedSortCol] = useState<string | null>('dispatched_at')
  const [dispatchedSortDir, setDispatchedSortDir] = useState<'asc' | 'desc'>('desc')
  const [dispatchedSearch, setDispatchedSearch] = useState('')
  const [dispatchedDateFilter, setDispatchedDateFilter] = useState<Set<string>>(new Set())
  const [showDispatchedDatePopover, setShowDispatchedDatePopover] = useState(false)
  const [dispatchedDatePopoverPos, setDispatchedDatePopoverPos] = useState({ top: 0, left: 0 })
  const [dispatchedStatusFilter, setDispatchedStatusFilter] = useState<Set<string>>(new Set())
  const [showDispatchedStatusPopover, setShowDispatchedStatusPopover] = useState(false)
  const [dispatchedStatusPopoverPos, setDispatchedStatusPopoverPos] = useState({ top: 0, left: 0 })
  const [dispatchedCourierFilter, setDispatchedCourierFilter] = useState<Set<string>>(new Set())
  const [showDispatchedCourierPopover, setShowDispatchedCourierPopover] = useState(false)
  const [dispatchedCourierPopoverPos, setDispatchedCourierPopoverPos] = useState({ top: 0, left: 0 })
  // Tracking
  const [trackingData, setTrackingData] = useState<Record<string, { status: string; label: string; lastUpdate: string }>>({})
  const [trackingLoading, setTrackingLoading] = useState(false)
  const [trackingProgress, setTrackingProgress] = useState<{ done: number; total: number } | null>(null)
  const [trackingLastSync, setTrackingLastSync] = useState<Date | null>(null)
  const [daysFilter, setDaysFilter] = useState<Set<number>>(new Set())
  const [showDaysPopover, setShowDaysPopover] = useState(false)
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 })
  const [courierFilter, setCourierFilter] = useState<Set<string>>(new Set())
  const [showCourierPopover, setShowCourierPopover] = useState(false)
  const [courierPopoverPos, setCourierPopoverPos] = useState({ top: 0, left: 0 })
  const [skuFilter, setSkuFilter] = useState<Set<string>>(new Set())
  const [showSkuPopover, setShowSkuPopover] = useState(false)
  const [skuPopoverPos, setSkuPopoverPos] = useState({ top: 0, left: 0 })
  const [skuSearch, setSkuSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDecision, setBulkDecision] = useState<PlanDecision | ''>('')
  const [showBulkConfirm, setShowBulkConfirm] = useState(false)
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set())
  const [showCancelled, setShowCancelled] = useState(false)
  const [showDispatched, setShowDispatched] = useState(false)

  // Manual cancel modal
  const [cancelOrderId, setCancelOrderId] = useState<string | null>(null)
  // History panel
  const [historyOrder, setHistoryOrder] = useState<DBOrder | null>(null)
  // Manual dispatch
  const [manualDispatchOrder, setManualDispatchOrder] = useState<DBOrder | null>(null)
  // AWB editing
  const [editingAwbId, setEditingAwbId] = useState<string | null>(null)
  const [editingAwbValue, setEditingAwbValue] = useState('')
  const [manualDispatchSku, setManualDispatchSku] = useState('')
  const [manualDispatching, setManualDispatching] = useState(false)
  // Global search
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  // Picklist print selection
  const [selectedPrintDates, setSelectedPrintDates] = useState<Set<string>>(new Set())
  // Upcoming demand expanded weeks
  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set())
  // Dispatch date filter (Plan tab)
  const [dispatchDateFilter, setDispatchDateFilter] = useState<Set<string>>(new Set())
  const [showDispatchDatePopover, setShowDispatchDatePopover] = useState(false)
  const [dispatchDatePopoverPos, setDispatchDatePopoverPos] = useState({ top: 0, left: 0 })

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
    matched: Array<{ orderId: string; platformOrderId: string; sku: string; awb: string; customerName: string }>
    unmatched: Array<{ orderId: string; sku: string; customerName: string; storedAwb?: string | null }>
  } | null>(null)
  const [showEodConfirm, setShowEodConfirm] = useState(false)
  const [eodDone, setEodDone] = useState(false)

  const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

  // ── Data ──
  // ── Log event ──
  const logEvent = async (orderId: string, eventType: string, title: string, note?: string) => {
    await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId, event_type: eventType, title, note }),
    })
  }

  const loadOrders = useCallback(async () => {
    setLoadingOrders(true)
    const { data } = await supabase.from('dispatch_orders').select('*').order('created_at', { ascending: false })
    setOrders((data as DBOrder[]) || [])
    setLoadingOrders(false)
    setSelectedIds(new Set())
  }, [supabase])

  // Silent refresh — re-pull orders without a loading flash or clearing selections.
  // Used to keep the End-of-Day batch/courier counts live while another device dispatches.
  const silentRefreshOrders = useCallback(async () => {
    const { data } = await supabase.from('dispatch_orders').select('*').order('created_at', { ascending: false })
    if (data) setOrders(data as DBOrder[])
  }, [supabase])

  // Auto-load on mount if initialOrders is empty

  useEffect(() => {
    // Always load fresh from DB to ensure all columns (incl. scheduled_date) are present
    loadOrders()
    // Load SKU map for import-time barcode resolution + scan-out verification
    supabase.from('dispatch_sku_map').select('*').then(({ data }) => {
      if (data) setSkuMaps(data as SkuMap[])
    })
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
    // Separate into: truly new orders, and updates to existing orders (tracking number changed)
    const existingMap = new Map(orders.map(o => [o.order_id, o]))
    const newOrders = allParsed.filter(o => !existingMap.has(o.order_id))
    const updatedOrders = allParsed.filter(o => {
      const existing = existingMap.get(o.order_id)
      if (!existing) return false
      // Update if new import has a tracking number that differs from stored value
      return o.tracking_number && o.tracking_number !== existing.tracking_number
    })

    // Apply tracking number updates to existing orders
    if (updatedOrders.length > 0) {
      await Promise.all(updatedOrders.map(async o => {
        const existing = existingMap.get(o.order_id)!
        await supabase.from('dispatch_orders').update({
          tracking_number: o.tracking_number,
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id)
        logEvent(o.order_id, 'note', `Tracking number updated via re-import: ${o.tracking_number}`)
      }))
      setOrders(prev => prev.map(o => {
        const updated = updatedOrders.find(u => u.order_id === o.order_id)
        return updated ? { ...o, tracking_number: updated.tracking_number } : o
      }))
    }

    if (newOrders.length > 0) {
      // Use a placeholder session_id (create a batch record for tracking)
      const batchLabel = `Import ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
      const { data: session } = await supabase.from('dispatch_sessions')
        .insert({ created_by: user.id, session_date: new Date().toISOString().split('T')[0], label: batchLabel, total_orders: newOrders.length })
        .select().single()
      if (session) {
        // Resolve each order's platform SKU to the canonical barcode (Master) SKU
        const lookup = buildSkuLookup(skuMaps)
        const rows = newOrders.map(o => {
          const barcode = resolveBarcodeSku(o.order_id, o.sku, lookup)
          return {
            session_id: session.id, ...o,
            barcode_sku: barcode,
            sku_mapped: !!barcode,
            plan_decision: o.is_dispatched ? 'scheduled' : 'undecided',
          }
        })
        await supabase.from('dispatch_orders').insert(rows)
        await loadOrders()
        // Log import events
        for (const o of newOrders) {
          logEvent(o.order_id, 'import', `Imported · ${o.courier} · ${o.sku}`)
        }
      }
    }
    const lookupForCount = buildSkuLookup(skuMaps)
    const unmappedOrders = newOrders.filter(o => !resolveBarcodeSku(o.order_id, o.sku, lookupForCount))
    const unmappedBySku = new Map<string, number>()
    unmappedOrders.forEach(o => unmappedBySku.set(o.sku || '(blank)', (unmappedBySku.get(o.sku || '(blank)') || 0) + 1))
    const unmappedSkuList = Array.from(unmappedBySku.entries()).map(([sku, count]) => ({ sku, count })).sort((a, b) => b.count - a.count)
    setImportResult({ added: newOrders.length, updated: updatedOrders.length, skipped: allParsed.length - newOrders.length - updatedOrders.length, unmapped: unmappedOrders.length, unmappedSkus: unmappedSkuList })
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
    const order = orders.find(o => o.id === orderId)
    if (order) {
      if (decision === 'hold') logEvent(order.order_id, 'hold', 'Marked On Hold')
      if (decision === 'unfulfillable') logEvent(order.order_id, 'unfulfillable', 'Marked Unfulfillable')
      if (decision === 'undecided') logEvent(order.order_id, 'hold', 'Decision cleared')
    }
    setOrders(prev => prev.map(o => o.id === orderId ? {
      ...o, plan_decision: decision,
      scheduled_date: update.scheduled_date !== undefined ? update.scheduled_date : o.scheduled_date
    } : o))
    setUpdatingIds(prev => { const n = new Set(prev); n.delete(orderId); return n })
  }

  // ── Schedule with date (called from row date picker) ──
  const scheduleOrder = async (orderId: string, date: string) => {
    const order = orders.find(o => o.id === orderId)
    if (!date) {
      await updateDecision(orderId, 'undecided')
      return
    }
    const wasScheduled = order?.plan_decision === 'scheduled' && order?.scheduled_date
    const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    await updateDecision(orderId, 'scheduled', date)
    if (order) {
      const eventType = wasScheduled ? 'rescheduled' : 'scheduled'
      const title = wasScheduled ? `Rescheduled to ${dateLabel}` : `Scheduled for ${dateLabel}`
      logEvent(order.order_id, eventType, title)
    }
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
    // Log bulk events
    const bulkOrders = orders.filter(o => selectedIds.has(o.id))
    for (const o of bulkOrders) {
      if (bulkDecision === 'scheduled') {
        const dateLabel = bulkScheduleDate ? new Date(bulkScheduleDate + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''
        logEvent(o.order_id, 'scheduled', `Scheduled for ${dateLabel} (bulk)`)
      } else if (bulkDecision === 'hold') {
        logEvent(o.order_id, 'hold', 'Marked On Hold (bulk)')
      } else if (bulkDecision === 'unfulfillable') {
        logEvent(o.order_id, 'unfulfillable', 'Marked Unfulfillable (bulk)')
      }
    }
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
    const order = orders.find(o => o.id === cancelOrderId)
    await supabase.from('dispatch_orders').update({
      is_cancelled: true, manual_cancelled: true, manual_cancelled_at: now,
      plan_decision: 'undecided', updated_at: now,
    }).eq('id', cancelOrderId)
    if (order) logEvent(order.order_id, 'cancelled', 'Order cancelled manually')
    setOrders(prev => prev.map(o => o.id === cancelOrderId ? { ...o, is_cancelled: true, manual_cancelled: true } : o))
    setCancelOrderId(null)
  }

  // ── Compute allocation preview ──
  const computeAllocation = (sku: string, available: number) => {
    const tierOrder: Record<string, number> = { CRITICAL: 0, TODAY: 1, PLAN: 2, HOLD: 3 }
    const skuOrders = orders
      .filter(o => o.sku === sku && o.plan_decision === 'scheduled' && !o.is_cancelled && !o.is_dispatched)
      .sort((a, b) => {
        const ta = tierOrder[liveUrgency(a) || 'HOLD'] ?? 3
        const tb = tierOrder[liveUrgency(b) || 'HOLD'] ?? 3
        if (ta !== tb) return ta - tb
        return (displayDaysLeft(a) ?? 99) - (displayDaysLeft(b) ?? 99)
      })
    return {
      dispatch: skuOrders.slice(0, available),
      unfulfillable: skuOrders.slice(available),
    }
  }

  // ── Manual dispatch ──
  const handleManualDispatch = async () => {
    if (!manualDispatchOrder) return
    setManualDispatching(true)
    const now = new Date().toISOString()
    await supabase.from('dispatch_orders').update({
      is_dispatched: true,
      dispatched_at: now,
      updated_at: now,
    }).eq('id', manualDispatchOrder.id)
    logEvent(manualDispatchOrder.order_id, 'dispatched', `Manually dispatched · Barcode SKU: ${manualDispatchSku.trim()}`)
    setOrders(prev => prev.map(o => o.id === manualDispatchOrder.id ? {
      ...o, is_dispatched: true, dispatched_at: now,
    } : o))
    setManualDispatchOrder(null)
    setManualDispatchSku('')
    setManualDispatching(false)
  }

  // ── Save AWB edit ──
  const saveCourier = async (orderId: string, newCourier: Courier) => {
    await supabase.from('dispatch_orders').update({ courier: newCourier, updated_at: new Date().toISOString() }).eq('id', orderId)
    const order = orders.find(o => o.id === orderId)
    if (order && order.courier !== newCourier) logEvent(order.order_id, 'note', `Courier changed from ${order.courier} to ${newCourier}`)
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, courier: newCourier } : o))
  }

  const saveAwb = async (orderId: string) => {
    const val = editingAwbValue.trim()
    await supabase.from('dispatch_orders').update({ tracking_number: val || null, updated_at: new Date().toISOString() }).eq('id', orderId)
    const order = orders.find(o => o.id === orderId)
    if (order) logEvent(order.order_id, 'note', `Tracking number updated to: ${val || '(cleared)'}`)
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, tracking_number: val || null } : o))
    setEditingAwbId(null)
    setEditingAwbValue('')
  }

  // ── Scan-out verification ──
  // Failure tone (Web Audio, no asset) — low buzz on rejected scans.
  const beepError = () => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctx()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = 220
      gain.gain.setValueAtTime(0.18, ctx.currentTime)
      osc.connect(gain); gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.28)
      osc.onended = () => ctx.close()
    } catch { /* audio not available */ }
  }

  // Keyboard-only flow: focus item when an order is pulled, AWB when cleared.
  useEffect(() => {
    if (!scanCourier) return
    if (scanOrder) itemInputRef.current?.focus()
    else awbInputRef.current?.focus()
  }, [scanOrder, scanCourier])

  // Keep End-of-Day & Dispatched live: refresh on entry + poll every 15s (so another
  // device's dispatches show up in the counts/rows without a manual reload).
  // Pauses polling mid-scan to avoid disrupting an in-progress AWB lookup.
  useEffect(() => {
    if (tab !== 'eod' && tab !== 'dispatched') return
    silentRefreshOrders()
    const iv = setInterval(() => {
      if (!scanOrder) silentRefreshOrders()
    }, 15000)
    return () => clearInterval(iv)
  }, [tab, scanOrder, silentRefreshOrders])

  const handleScanAwb = (awbRaw: string) => {
    const awb = awbRaw.trim().replace(/\.0+$/, '')
    if (!awb) return
    setScanError(null)
    setScanResult(null)

    const allMatches = orders.filter(o =>
      o.tracking_number?.trim().replace(/\.0+$/, '') === awb &&
      !o.is_cancelled && !o.is_dispatched
    )
    if (!allMatches.length) {
      // Distinguish "already dispatched" from "never existed"
      const dispatched = orders.find(o => o.tracking_number?.trim().replace(/\.0+$/, '') === awb && o.is_dispatched && !o.is_cancelled)
      beepError()
      setScanError(dispatched ? `AWB ${awb} is already dispatched.` : `No pending order found for AWB ${awb}`)
      setScanOrder(null)
      return
    }
    // Scope to the courier currently being loaded
    const match = scanCourier ? allMatches.find(o => o.courier === scanCourier) : allMatches[0]
    if (!match) {
      const other = allMatches[0].courier
      beepError()
      setScanError(`AWB ${awb} is a ${other} order, but you're loading ${scanCourier}. Switch courier or set this one aside.`)
      setScanOrder(null)
      return
    }
    setScanOrder(match)
    setScanItem('')
  }

  const handleScanItem = async (itemRaw: string) => {
    if (!scanOrder) return
    const scanned = itemRaw.trim()
    if (!scanned) return
    const expected = (scanOrder.barcode_sku || '').trim()

    if (!expected) {
      beepError()
      setScanError(`Order ${scanOrder.order_id} has no mapped barcode SKU. Map it in the SKU Map tab, or use the paste fallback below.`)
      return
    }

    // Item barcode = Master SKU + "-" + sequence number (e.g. "(4)-D-B-WH-DU-1").
    // Master SKU contains hyphens/parens, so escape it and anchor a trailing -<digits>.
    const esc = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const seqMatch = scanned.match(new RegExp(`^${esc}-(\\d+)$`, 'i'))
    const isExact = scanned.toLowerCase() === expected.toLowerCase()
    const isMatch = !!seqMatch || isExact
    const seq = seqMatch ? seqMatch[1] : null

    if (!isMatch) {
      // Wrong SKU — block, beep, keep order loaded for a retry.
      beepError()
      setScanResult({ ok: false, expected, scanned })
      return
    }

    // Match — dispatch with a DB-level guard so an already-dispatched row can't be re-marked.
    const now = new Date().toISOString()
    const { data: updated, error } = await supabase.from('dispatch_orders').update({
      is_dispatched: true,
      dispatched_at: now,
      scan_verified: true,
      scan_verified_at: now,
      scanned_barcode: scanned,
    }).eq('id', scanOrder.id).eq('is_dispatched', false).select()

    if (error || !updated || updated.length === 0) {
      // Someone/something already dispatched this order — refuse to double-dispatch.
      beepError()
      setScanResult(null)
      setScanError(`That order was already dispatched — not counting it again.`)
      return
    }

    logEvent(scanOrder.order_id, 'dispatched', `Scan-verified dispatch · ${scanned}${seq ? ` (piece #${seq})` : ''} · AWB ${scanOrder.tracking_number}`)
    setOrders(prev => prev.map(o => o.id === scanOrder.id ? { ...o, is_dispatched: true, dispatched_at: now, scan_verified: true, scan_verified_at: now, scanned_barcode: scanned } : o))

    // Move past instantly — clear and refocus AWB for the next box (effect handles focus).
    setScanOrder(null)
    setScanAwb('')
    setScanItem('')
    setScanResult(null)
    setScanError(null)
  }

  const resetScan = () => {
    setScanOrder(null)
    setScanAwb('')
    setScanItem('')
    setScanResult(null)
    setScanError(null)
  }

  // ── Courier dispatch-day stats (for scan-out selector) ──
  const courierDayStats = (c: Courier) => {
    const eodToday = new Date().toISOString().split('T')[0]
    const plannedList = orders.filter(o => o.courier === c && o.plan_decision === 'scheduled' && o.scheduled_date === eodToday && !o.is_cancelled)
    const planned = plannedList.length
    const dispatched = plannedList.filter(o => o.is_dispatched && o.dispatched_at && o.dispatched_at.startsWith(eodToday)).length
    return { planned, dispatched }
  }

  // ── Current open batch for a courier (derived from DB-backed orders) ──
  // Batch = scan-verified, dispatched, NOT-yet-manifested pieces for the courier.
  // Survives reload (rebuilt from orders) and courier-switching (per-courier).
  const currentBatch = (c: Courier | null) => {
    if (!c) return []
    return orders
      .filter(o => o.courier === c && o.is_dispatched && o.scan_verified && !o.manifested_at && !o.is_cancelled)
      .sort((a, b) => (b.scan_verified_at || '').localeCompare(a.scan_verified_at || ''))
  }

  // ── Generate + print dispatch manifest, then stamp manifested_at to close the batch ──
  const generateManifest = async (c: Courier) => {
    const list = [...currentBatch(c)].sort((a, b) => (a.tracking_number || '').localeCompare(b.tracking_number || ''))
    if (!list.length) return
    const now = new Date()
    const dateStr = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    const totalPcs = list.reduce((s, o) => s + (o.qty || 1), 0)
    const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const rows = list.map((o, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td class="mono">${esc(o.tracking_number)}</td>
      <td class="mono">${esc(o.barcode_sku || o.sku)}</td>
    </tr>`).join('')

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Dispatch Manifest — ${esc(c)} — ${dateStr}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; color: #111; margin: 32px; font-size: 12px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 12px; margin-bottom: 4px; }
  .brand { font-size: 18px; font-weight: 700; }
  .brand small { display: block; font-size: 11px; font-weight: 400; color: #555; margin-top: 3px; line-height: 1.4; }
  .meta { text-align: right; font-size: 12px; line-height: 1.6; }
  .meta .courier { font-size: 16px; font-weight: 700; }
  h1 { font-size: 14px; margin: 18px 0 10px; letter-spacing: 0.04em; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f3f3f3; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
  td.num { text-align: center; width: 34px; color: #666; }
  td.mono, th.mono { font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 11px; }
  tfoot td { font-weight: 700; background: #fafafa; }
  .sign { display: flex; gap: 40px; margin-top: 48px; }
  .sign .box { flex: 1; }
  .sign .line { border-top: 1px solid #111; margin-top: 44px; padding-top: 6px; font-size: 11px; color: #555; }
  .sign .field { font-size: 11px; color: #555; margin-top: 10px; }
  @media print { body { margin: 12mm; } button { display: none; } }
  .printbtn { position: fixed; top: 12px; right: 12px; padding: 8px 16px; background: #111; color: #fff; border: none; border-radius: 6px; font-size: 13px; cursor: pointer; }
</style></head>
<body>
  <button class="printbtn" onclick="window.print()">Print</button>
  <div class="head">
    <div class="brand">Honey Touch · Sabi Wabi Innovations LLP
      <small>Pickup: Sabi Wabi Ventures, Survey No. 72, Kalyan, 421301 · 8999198256</small>
    </div>
    <div class="meta">
      <div class="courier">${esc(c)}</div>
      <div>${dateStr}</div>
      <div>Generated ${timeStr}</div>
    </div>
  </div>
  <h1>DISPATCH MANIFEST</h1>
  <table>
    <thead><tr><th class="num">#</th><th>AWB / Tracking ID</th><th>Barcode SKU</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="3">Total shipments: ${list.length} &nbsp;·&nbsp; Total pieces: ${totalPcs}</td></tr></tfoot>
  </table>
  <div class="sign">
    <div class="box"><div class="line">Handed over by (Warehouse)</div><div class="field">Name &amp; Signature</div></div>
    <div class="box"><div class="line">Received by (${esc(c)} Pickup Executive)</div><div class="field">Name · Signature · Date &amp; Time</div></div>
  </div>
</body></html>`

    const w = window.open('', '_blank')
    if (!w) { alert('Allow pop-ups to print the manifest.'); return }
    w.document.write(html)
    w.document.close()
    w.focus()
    // Close the batch: stamp manifested_at so these pieces leave the open batch.
    const manifestedNow = new Date().toISOString()
    const ids = list.map(o => o.id)
    await supabase.from('dispatch_orders').update({ manifested_at: manifestedNow }).in('id', ids)
    setOrders(prev => prev.map(o => ids.includes(o.id) ? { ...o, manifested_at: manifestedNow } : o))
  }

  // ── Sync tracking (called directly from browser) ──
  const WORKER = 'https://tracklens-proxy.adityaramnani91581.workers.dev'
  const BD_API_KEY = 'WxObKDF1pSM0GWYCBBjnemimMH7Ed3Gp'
  const BD_API_SECRET = 'j2FGlGEWnGcgVYDs'
  const BD_LOGIN_ID = 'BOM41184'
  const BD_LICENCE_KEY = 'hkfoiszukslp0umqriqgn2bolmgovtge'

  const normalizeBD = (code: string, desc: string) => {
    const s = (code + ' ' + desc).toLowerCase()
    if (s.includes('delivered')) return { status: 'delivered', label: 'Delivered' }
    if (s.includes('out for delivery') || s.includes('ofd')) return { status: 'ofd', label: 'Out for Delivery' }
    if (s.includes('ndr') || s.includes('delivery attempt') || s.includes('undelivered')) return { status: 'ndr', label: 'NDR' }
    if (s.includes('rto') || s.includes('return')) return { status: 'rto', label: 'RTO' }
    if (s.includes('picked up') || s.includes('pickup')) return { status: 'picked_up', label: 'Picked Up' }
    if (s.includes('transit') || s.includes('arrived') || s.includes('departed')) return { status: 'in_transit', label: 'In Transit' }
    if (s.includes('booked') || s.includes('manifested')) return { status: 'booked', label: 'Booked' }
    return { status: 'unknown', label: desc || code || 'Unknown' }
  }

  const normalizeDL = (status: string) => {
    const s = (status || '').toLowerCase()
    if (s.includes('delivered')) return { status: 'delivered', label: 'Delivered' }
    if (s.includes('out for delivery')) return { status: 'ofd', label: 'Out for Delivery' }
    if (s.includes('failed delivery') || s.includes('undelivered')) return { status: 'ndr', label: 'NDR' }
    if (s.includes('rto') || s.includes('return')) return { status: 'rto', label: 'RTO' }
    if (s.includes('transit')) return { status: 'in_transit', label: 'In Transit' }
    if (s.includes('picked up') || s.includes('pickup')) return { status: 'picked_up', label: 'Picked Up' }
    return { status: 'booked', label: status || 'Booked' }
  }

  const syncTracking = async () => {
    // Skip orders already delivered (status never changes after delivery)
    const toTrack = dispatchedOrders.filter(o => o.tracking_number && o.tracking_status !== 'delivered' && o.tracking_status !== 'rto')
    if (!toTrack.length) { setTrackingLastSync(new Date()); return }
    setTrackingLoading(true)
    setTrackingProgress({ done: 0, total: toTrack.length })
    const results: Record<string, { status: string; label: string; lastUpdate: string }> = {}

    try {
      // 1. Get Bluedart JWT
      const bdOrders = toTrack.filter(o => o.courier === 'Bluedart')
      const dlOrders = toTrack.filter(o => o.courier === 'Delhivery')

      if (bdOrders.length) {
        let bdToken: string | null = null
        try {
          const tokenRes = await fetch(`${WORKER}/bluedart/in/transportation/token/v1/login`, {
            method: 'GET',
            headers: { 'ClientID': BD_API_KEY, 'ClientSecret': BD_API_SECRET },
          })
          const tokenData = await tokenRes.json()
          bdToken = tokenData?.JWTToken || null
        } catch { /* token failed */ }

        if (bdToken) {
          // Throttled: 3 concurrent, 350ms gap between batches to avoid 429
          // Endpoint format from TrackLens: query params + XML response
          const CONCURRENCY = 6
          for (let i = 0; i < bdOrders.length; i += CONCURRENCY) {
            const batch = bdOrders.slice(i, i + CONCURRENCY)
            await Promise.all(batch.map(async o => {
              try {
                const params = new URLSearchParams({
                  handler: 'tnt',
                  action: 'custawbquery',
                  loginid: BD_LOGIN_ID,
                  awb: 'awb',
                  numbers: o.tracking_number!.trim(),
                  format: 'xml',
                  lickey: BD_LICENCE_KEY,
                  verno: '1.3',
                  scan: '1',
                })
                const res = await fetch(`${WORKER}/bluedart/in/transportation/tracking/v1?${params}`, {
                  method: 'GET',
                  headers: { 'JWTToken': bdToken },
                })
                if (res.status === 429) return // rate limited, will retry next sync
                const xmlText = await res.text()
                const doc = new DOMParser().parseFromString(xmlText, 'text/xml')
                const shipment = doc.querySelector('Shipment')
                if (shipment) {
                  const statusEl = shipment.querySelector('Status')
                  const firstScan = shipment.querySelector('Scans Scan, Scans > ScanDetail')
                  const scanText = firstScan?.querySelector('Scan')?.textContent || firstScan?.textContent || ''
                  const scanDate = firstScan?.querySelector('ScanDate')?.textContent || ''
                  const statusText = statusEl?.textContent || scanText || ''
                  if (statusText) {
                    results[o.tracking_number!] = {
                      ...normalizeBD('', statusText),
                      lastUpdate: scanDate,
                    }
                  }
                }
              } catch { /* skip */ }
            }))
            setTrackingProgress(p => p ? { ...p, done: Math.min(p.done + batch.length, p.total) } : p)
            if (i + CONCURRENCY < bdOrders.length) await new Promise(r => setTimeout(r, 200))
          }
        }
      }

      // 2. Delhivery — server route, chunked to stay under serverless timeout
      if (dlOrders.length) {
        const CHUNK = 25
        for (let i = 0; i < dlOrders.length; i += CHUNK) {
          const chunk = dlOrders.slice(i, i + CHUNK)
          try {
            const res = await fetch('/api/tracking', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                orders: chunk.map(o => ({ id: o.id, awb: o.tracking_number!, courier: o.courier }))
              }),
            })
            if (res.ok) {
              const data = await res.json()
              Object.assign(results, data)
            }
          } catch { /* skip chunk */ }
          setTrackingProgress(p => p ? { ...p, done: Math.min(p.done + chunk.length, p.total) } : p)
        }
      }
    } catch (e) { console.error('Tracking sync failed:', e) }

    // Persist results to DB so status survives page reloads
    const syncedAt = new Date().toISOString()
    const updates = Object.entries(results)
    if (updates.length) {
      await Promise.all(updates.map(async ([awb, t]) => {
        const order = dispatchedOrders.find(o => o.tracking_number === awb)
        if (!order) return
        await supabase.from('dispatch_orders').update({
          tracking_status: t.status,
          tracking_label: t.label,
          tracking_last_update: t.lastUpdate,
          tracking_synced_at: syncedAt,
        }).eq('id', order.id)
      }))
      setOrders(prev => prev.map(o => {
        const t = o.tracking_number ? results[o.tracking_number] : undefined
        return t ? { ...o, tracking_status: t.status, tracking_label: t.label, tracking_last_update: t.lastUpdate, tracking_synced_at: syncedAt } : o
      }))
    }
    setTrackingData(results)
    setTrackingLastSync(new Date())
    setTrackingLoading(false)
    setTrackingProgress(null)
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

    // Log events for unfulfillable orders
    if (allocationPreview && allocationPreview.unfulfillable.length > 0) {
      for (const o of allocationPreview.unfulfillable) {
        logEvent(o.order_id, 'unfulfillable', `Marked Unfulfillable · ${unfulfillableReason}`, unfulfillableNote.trim() || undefined)
      }
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
    // Only update target_dispatch_date — keep plan_decision as unfulfillable
    // scheduled_date is set separately when manager approves for dispatch
    await supabase.from('dispatch_orders').update({
      target_dispatch_date: date,
      updated_at: new Date().toISOString()
    }).eq('id', orderId)
    const order = orders.find(o => o.id === orderId)
    if (order) {
      const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
      logEvent(order.order_id, 'target_set', `Target dispatch date set to ${dateLabel}`)
    }
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, target_dispatch_date: date } : o))
    setSavingReview(null)
    await loadOrders()
  }

  // ── Review: approve unfulfillable for dispatch on target date ──
  const approveForDispatch = async (orderId: string) => {
    const order = orders.find(o => o.id === orderId)
    if (!order?.target_dispatch_date) return
    await supabase.from('dispatch_orders').update({
      plan_decision: 'scheduled',
      scheduled_date: order.target_dispatch_date,
      updated_at: new Date().toISOString(),
    }).eq('id', orderId)
    const dateLabel = new Date(order.target_dispatch_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    logEvent(order.order_id, 'scheduled', `Approved for dispatch on ${dateLabel} from Review`)
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, plan_decision: 'scheduled', scheduled_date: order.target_dispatch_date } : o))
  }

  // ── Review: cancel from review ──
  const cancelFromReview = async (orderId: string) => {
    const now = new Date().toISOString()
    const order = orders.find(o => o.id === orderId)
    await supabase.from('dispatch_orders').update({ is_cancelled: true, manual_cancelled: true, manual_cancelled_at: now, updated_at: now }).eq('id', orderId)
    if (order) logEvent(order.order_id, 'cancelled', 'Order cancelled from Review tab')
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, is_cancelled: true, manual_cancelled: true } : o))
  }

  // ── EOD ──
  const parseShypassist = () => {
    const lines = shypassistText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) return

    // Build AWB -> SKU map from Shypassist — normalise: strip .0 decimals, trim whitespace
    const shypassistAwbs = new Map<string, string>() // awb -> sku
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t')
      if (cols.length < 3) continue
      const sku = cols[0].trim()
      const awb = cols[2].trim().replace(/\.0+$/, '')
      if (awb) shypassistAwbs.set(awb, sku)
    }

    // Today's scheduled orders
    const eodToday = new Date().toISOString().split('T')[0]
    const toDispatch = orders.filter(o =>
      o.plan_decision === 'scheduled' &&
      o.scheduled_date === eodToday &&
      !o.is_cancelled &&
      !o.is_dispatched
    )

    const matched: Array<{ orderId: string; platformOrderId: string; sku: string; awb: string; customerName: string }> = []
    const unmatched: Array<{ orderId: string; sku: string; customerName: string; storedAwb: string | null }> = []

    toDispatch.forEach(order => {
      // Normalise stored tracking number the same way
      const storedAwb = order.tracking_number?.trim().replace(/\.0+$/, '') || null
      if (storedAwb && shypassistAwbs.has(storedAwb)) {
        const shypassistSku = shypassistAwbs.get(storedAwb) || order.sku
        matched.push({ orderId: order.id, platformOrderId: order.order_id, sku: shypassistSku, awb: storedAwb, customerName: order.customer_name })
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
      await supabase.from('dispatch_orders').update({
        is_dispatched: true,
        dispatched_at: now,
        tracking_number: m.awb,
        sku: m.sku,
        scanned_barcode: m.sku,
      }).eq('id', m.orderId)
      logEvent(m.platformOrderId, 'dispatched', `Dispatched · AWB ${m.awb}`)
    }
    await loadOrders()
    setShowEodConfirm(false)
    setEodDone(true)
  }

  const handleSignOut = async () => { await supabase.auth.signOut(); window.location.href = '/login' }



  // ── Search results ──
  const searchResults = useMemo(() => {
    if (!searchQuery.trim() || searchQuery.length < 3) return []
    const q = searchQuery.toLowerCase().trim()
    return orders.filter(o =>
      o.order_id.toLowerCase().includes(q) ||
      o.customer_name.toLowerCase().includes(q) ||
      o.sku.toLowerCase().includes(q) ||
      (o.tracking_number && o.tracking_number.toLowerCase().includes(q))
    ).slice(0, 8)
  }, [orders, searchQuery])

  // ── Computed ──
  const today = new Date().toISOString().split('T')[0]
  const activeOrders = useMemo(() => orders.filter(o => !o.is_cancelled && !o.is_dispatched), [orders])
  const cancelledOrders = useMemo(() => orders.filter(o => o.is_cancelled), [orders])

  // Unique scheduled dates for dispatch date filter
  // Live days-left to the effective dispatch deadline:
  //   (promise_date − today) − transit_days − 1-day buffer.
  // Computed every render from today's date, so it counts down daily.
  // Falls back to the stored days_left column only if promise_date is missing.
  const displayDaysLeft = (o: { promise_date?: string | null; transit_days?: number; days_left?: number | null }): number | null => {
    if (o.promise_date) {
      const promise = new Date(o.promise_date + 'T00:00:00')
      const now = new Date(today + 'T00:00:00')
      const daysToPromise = Math.round((promise.getTime() - now.getTime()) / 86400000)
      return daysToPromise - (o.transit_days ?? 0) - 1
    }
    return o.days_left === null || o.days_left === undefined ? null : o.days_left - 1
  }

  // Live urgency tier, derived from live days-left (same thresholds as the importer).
  // Falls back to the stored urgency if no promise date / days-left is available.
  const liveUrgency = (o: { promise_date?: string | null; transit_days?: number; days_left?: number | null; urgency?: UrgencyTier | null }): UrgencyTier | null => {
    const d = displayDaysLeft(o)
    if (d === null) return o.urgency ?? null
    if (d <= 0) return 'CRITICAL'
    if (d <= 2) return 'TODAY'
    if (d === 3) return 'PLAN'
    return 'HOLD'
  }

  const uniqueDispatchDates = useMemo(() => {
    const vals = new Set<string>()
    let base = [...activeOrders]
    if (activeFilter === 'scheduled_today') base = base.filter(o => o.plan_decision === 'scheduled' && o.scheduled_date === today)
    else if (activeFilter === 'scheduled') base = base.filter(o => o.plan_decision === 'scheduled')
    else if (activeFilter === 'hold') base = base.filter(o => o.plan_decision === 'hold')
    else if (activeFilter === 'unfulfillable') base = base.filter(o => o.plan_decision === 'unfulfillable')
    else if (activeFilter === 'undecided') base = base.filter(o => o.plan_decision === 'undecided')
    else if (activeFilter !== 'ALL') base = base.filter(o => liveUrgency(o) === (activeFilter as string))
    if (courierFilter.size > 0) base = base.filter(o => courierFilter.has(o.courier))
    if (daysFilter.size > 0) base = base.filter(o => daysFilter.has(displayDaysLeft(o) ?? -999))
    base.forEach(o => vals.add(o.scheduled_date || 'none'))
    return Array.from(vals).sort()
  }, [activeOrders, activeFilter, courierFilter, daysFilter, today])
  const dispatchedOrders = useMemo(() => orders.filter(o => o.is_dispatched && !o.is_cancelled), [orders])

  const uniqueDispatchedDates = useMemo(() => {
    const dates = new Set<string>()
    dispatchedOrders.forEach(o => {
      if (o.dispatched_at) dates.add(o.dispatched_at.slice(0, 10))
    })
    return Array.from(dates).sort().reverse() // newest first
  }, [dispatchedOrders])

  const filteredDispatched = useMemo(() => {
    let list = [...dispatchedOrders]
    if (dispatchedSearch.trim().length >= 2) {
      const q = dispatchedSearch.toLowerCase()
      list = list.filter(o =>
        o.order_id.toLowerCase().includes(q) ||
        o.customer_name.toLowerCase().includes(q) ||
        o.sku.toLowerCase().includes(q) ||
        (o.tracking_number && o.tracking_number.toLowerCase().includes(q))
      )
    }
    if (dispatchedDateFilter.size > 0) {
      list = list.filter(o => {
        const dateKey = o.dispatched_at ? o.dispatched_at.slice(0, 10) : 'unknown'
        return dispatchedDateFilter.has(dateKey)
      })
    }
    if (dispatchedStatusFilter.size > 0) {
      list = list.filter(o => {
        const liveStatus = (o.tracking_number && trackingData[o.tracking_number]?.status) || o.tracking_status || 'none'
        return dispatchedStatusFilter.has(liveStatus)
      })
    }
    if (dispatchedCourierFilter.size > 0) {
      list = list.filter(o => dispatchedCourierFilter.has(o.courier))
    }
    if (dispatchedSortCol) {
      list.sort((a, b) => {
        const av = (a as unknown as Record<string, unknown>)[dispatchedSortCol] ?? ''
        const bv = (b as unknown as Record<string, unknown>)[dispatchedSortCol] ?? ''
        const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
        return dispatchedSortDir === 'asc' ? cmp : -cmp
      })
    }
    return list
  }, [dispatchedOrders, dispatchedSearch, dispatchedSortCol, dispatchedSortDir, dispatchedDateFilter, dispatchedStatusFilter, dispatchedCourierFilter, trackingData])
  const unfulfillableOrders = useMemo(() => activeOrders.filter(o => o.plan_decision === 'unfulfillable'), [activeOrders])

  const scheduledCount = useMemo(() => orders.filter(o => o.plan_decision === 'scheduled' && !o.is_cancelled && !o.is_dispatched).length, [orders])
  const dispatchTodayCount = useMemo(() => orders.filter(o => o.plan_decision === 'scheduled' && o.scheduled_date === today && !o.is_cancelled && !o.is_dispatched).length, [orders, today])
  const slippedCount = useMemo(() => orders.filter(o => o.plan_decision === 'scheduled' && o.scheduled_date && o.scheduled_date < today && !o.is_cancelled && !o.is_dispatched).length, [orders, today])
  const unmappedCount = useMemo(() => activeOrders.filter(o => !o.barcode_sku).length, [activeOrders])
  const holdCount = useMemo(() => orders.filter(o => o.plan_decision === 'hold' && !o.is_cancelled).length, [orders])
  const unfulfillableCount = useMemo(() => unfulfillableOrders.length, [unfulfillableOrders])
  const undecidedCount = useMemo(() => activeOrders.filter(o => o.plan_decision === 'undecided').length, [activeOrders])

  const tierCounts = useMemo(() => {
    const c: Record<string, number> = {}
    activeOrders.forEach(o => { const u = liveUrgency(o); if (u) c[u] = (c[u] || 0) + 1 })
    return c
  }, [activeOrders])

  // Display days left = raw - 1 (buffer)

  // ── Upcoming demand matrix (undecided orders: SKU rows × day columns) ──
  const [demandView, setDemandView] = useState<'weekly' | 'daily'>('weekly')
  const [demandSkuFilter, setDemandSkuFilter] = useState<Set<string>>(new Set())
  const [showDemandSkuPopover, setShowDemandSkuPopover] = useState(false)
  const [demandSkuSearch, setDemandSkuSearch] = useState('')

  // ISO week number helper
  const getISOWeek = (dateStr: string): number => {
    const d = new Date(dateStr + 'T00:00:00')
    const jan4 = new Date(d.getFullYear(), 0, 4)
    return Math.ceil(((d.getTime() - jan4.getTime()) / 86400000 + jan4.getDay() + 1) / 7)
  }

  const daysLeftToDate = (daysLeft: number): string => {
    const d = new Date()
    d.setDate(d.getDate() + daysLeft)
    return d.toISOString().split('T')[0]
  }

  const upcomingDemand = useMemo(() => {
    const undecided = orders.filter(o => o.plan_decision === 'undecided' && !o.is_cancelled && !o.is_dispatched)

    const dateSkuQty: Record<string, Record<string, number>> = {}
    const dateSkuOrders: Record<string, Record<string, number>> = {}
    undecided.forEach(o => {
      // Always compute dispatch deadline from days_left + today
      const dl = displayDaysLeft(o) ?? 999
      const dateKey = daysLeftToDate(dl)
      if (!dateSkuQty[dateKey]) { dateSkuQty[dateKey] = {}; dateSkuOrders[dateKey] = {} }
      dateSkuQty[dateKey][o.sku] = (dateSkuQty[dateKey][o.sku] || 0) + o.qty
      dateSkuOrders[dateKey][o.sku] = (dateSkuOrders[dateKey][o.sku] || 0) + 1
    })

    const allDates = Object.keys(dateSkuQty).sort()

    // Group into ISO weeks
    const weekBuckets: Record<string, string[]> = {}
    const weekMeta: Record<string, { weekNum: number; startDate: string; endDate: string; label: string }> = {}
    allDates.forEach(date => {
      const wNum = getISOWeek(date)
      const d = new Date(date + 'T00:00:00')
      const dayOfWeek = d.getDay() === 0 ? 6 : d.getDay() - 1
      const weekStart = new Date(d); weekStart.setDate(d.getDate() - dayOfWeek)
      const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6)
      // Use week number as the unique key — prevents duplicate week entries
      const wKey = `W${String(wNum).padStart(2, '0')}`
      const startFmt = weekStart.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
      const endFmt = weekEnd.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
      const wLabel = `${wKey}·${startFmt}–${endFmt}`
      if (!weekBuckets[wKey]) { weekBuckets[wKey] = []; weekMeta[wKey] = { weekNum: wNum, startDate: weekStart.toISOString().split('T')[0], endDate: weekEnd.toISOString().split('T')[0], label: wLabel } }
      weekBuckets[wKey].push(date)
    })

    const weekSkuQty: Record<string, Record<string, number>> = {}
    const weekSkuOrders: Record<string, Record<string, number>> = {}
    Object.entries(weekBuckets).forEach(([wKey, dates]) => {
      weekSkuQty[wKey] = {}; weekSkuOrders[wKey] = {}
      dates.forEach(date => {
        Object.entries(dateSkuQty[date] || {}).forEach(([sku, qty]) => {
          weekSkuQty[wKey][sku] = (weekSkuQty[wKey][sku] || 0) + qty
          weekSkuOrders[wKey][sku] = (weekSkuOrders[wKey][sku] || 0) + (dateSkuOrders[date][sku] || 0)
        })
      })
    })

    const sortedWeekLabels = Object.keys(weekBuckets).sort((a, b) => weekMeta[a].weekNum - weekMeta[b].weekNum)

    const allSkus = Array.from(new Set(undecided.map(o => o.sku)))
    const skuTotals: Record<string, number> = {}
    undecided.forEach(o => { skuTotals[o.sku] = (skuTotals[o.sku] || 0) + o.qty })
    allSkus.sort((a, b) => (skuTotals[b] || 0) - (skuTotals[a] || 0))

    const weeklyCols = sortedWeekLabels.map(wKey => {
      const meta = weekMeta[wKey]
      const parts = meta.label.split('·')
      const isThisWeek = today >= meta.startDate && today <= meta.endDate
      const isPast = meta.endDate < today
      return { key: wKey, label: parts[0].trim(), sublabel: parts[1]?.trim() || '', isUrgent: isThisWeek, isOverdue: isPast, startDate: meta.startDate }
    })

    const todayPlus2 = new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0]
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0]
    const dailyCols = allDates.map(date => {
      const isPast = date < today
      const isToday = date === today
      const daysDiff = Math.round((new Date(date).getTime() - new Date(today).getTime()) / 86400000)
      // Always show actual date as primary label
      const dateLabel = isToday ? 'Today'
        : date === tomorrow ? 'Tomorrow'
        : new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
      // Sub-label shows overdue indicator
      const sublabel = isPast ? `${Math.abs(daysDiff)}d late` : undefined
      return { key: date, label: dateLabel, sublabel, isUrgent: date <= todayPlus2 && !isPast, isOverdue: isPast }
    })

    const totalOrders = undecided.length
    const totalQty = undecided.reduce((s, o) => s + o.qty, 0)

    return { allSkus, dailyCols, weeklyCols, dateSkuQty, dateSkuOrders, weekSkuQty, weekSkuOrders, skuTotals, totalOrders, totalQty }
  }, [orders, displayDaysLeft, today])


  const filteredActive = useMemo(() => {
    let list = [...activeOrders]
    // Decision/urgency filter
    if (activeFilter === 'scheduled') list = list.filter(o => o.plan_decision === 'scheduled')
    else if (activeFilter === 'scheduled_today') list = list.filter(o => o.plan_decision === 'scheduled' && o.scheduled_date === today)
    else if (activeFilter === 'slipped') list = list.filter(o => o.plan_decision === 'scheduled' && o.scheduled_date && o.scheduled_date < today)
    else if (activeFilter === 'hold') list = list.filter(o => o.plan_decision === 'hold')
    else if (activeFilter === 'unfulfillable') list = list.filter(o => o.plan_decision === 'unfulfillable')
    else if (activeFilter === 'undecided') list = list.filter(o => o.plan_decision === 'undecided')
    else if (activeFilter === 'unmapped') list = list.filter(o => !o.barcode_sku)
    else if (activeFilter !== 'ALL') list = list.filter(o => liveUrgency(o) === activeFilter)
    // Days left filter (applied to display value = raw - 1)
    if (daysFilter.size > 0) list = list.filter(o => daysFilter.has(displayDaysLeft(o) ?? -999))
    // Undecided view: oldest imports first so stale decisions surface (unless user sorted manually)
    if (activeFilter === 'undecided' && !sortCol) {
      list.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    }
    if (courierFilter.size > 0) list = list.filter(o => courierFilter.has(o.courier))
    if (skuFilter.size > 0) list = list.filter(o => skuFilter.has(o.sku))
    if (dispatchDateFilter.size > 0) list = list.filter(o => dispatchDateFilter.has(o.scheduled_date || 'none'))
    // Sort
    const to: Record<string, number> = { CRITICAL: 0, TODAY: 1, PLAN: 2, HOLD: 3 }
    if (sortCol) {
      list.sort((a, b) => {
        let av: any, bv: any
        if (sortCol === 'urgency') { av = to[liveUrgency(a) || 'HOLD'] ?? 3; bv = to[liveUrgency(b) || 'HOLD'] ?? 3 }
        else if (sortCol === 'days_left') { av = displayDaysLeft(a) ?? 999; bv = displayDaysLeft(b) ?? 999 }
        else if (sortCol === 'customer') { av = a.customer_name.toLowerCase(); bv = b.customer_name.toLowerCase() }
        else if (sortCol === 'sku') { av = a.sku.toLowerCase(); bv = b.sku.toLowerCase() }
        else if (sortCol === 'courier') { av = a.courier; bv = b.courier }
        else if (sortCol === 'promise') { av = a.promise_date || ''; bv = b.promise_date || '' }
        else if (sortCol === 'dispatch_by') { av = a.dispatch_by_date || ''; bv = b.dispatch_by_date || '' }
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
        return (to[liveUrgency(a) || 'HOLD'] ?? 3) - (to[liveUrgency(b) || 'HOLD'] ?? 3) || (displayDaysLeft(a) ?? 99) - (displayDaysLeft(b) ?? 99)
      })
    }
    return list
  }, [activeOrders, activeFilter, daysFilter, courierFilter, skuFilter, dispatchDateFilter, sortCol, sortDir])

  // Orders matching ONLY the active KPI/urgency card (no courier/days/sku sub-filters).
  // Used so sub-filter dropdowns (courier, days) show counts scoped to the selected card.
  const activeFilterBase = useMemo(() => {
    let list = [...activeOrders]
    if (activeFilter === 'scheduled') list = list.filter(o => o.plan_decision === 'scheduled')
    else if (activeFilter === 'scheduled_today') list = list.filter(o => o.plan_decision === 'scheduled' && o.scheduled_date === today)
    else if (activeFilter === 'slipped') list = list.filter(o => o.plan_decision === 'scheduled' && o.scheduled_date && o.scheduled_date < today)
    else if (activeFilter === 'hold') list = list.filter(o => o.plan_decision === 'hold')
    else if (activeFilter === 'unfulfillable') list = list.filter(o => o.plan_decision === 'unfulfillable')
    else if (activeFilter === 'undecided') list = list.filter(o => o.plan_decision === 'undecided')
    else if (activeFilter === 'unmapped') list = list.filter(o => !o.barcode_sku)
    else if (activeFilter !== 'ALL') list = list.filter(o => liveUrgency(o) === activeFilter)
    return list
  }, [activeOrders, activeFilter, today])

  // Unique display days left values — based on currently filtered list (respects active KPI/urgency filter)
  const uniqueDaysLeft = useMemo(() => {
    const vals = new Set<number>()
    // Use filteredActive but without the daysFilter applied to avoid circular dependency
    let baseList = [...activeOrders]
    if (activeFilter === 'scheduled_today') baseList = baseList.filter(o => o.plan_decision === 'scheduled' && o.scheduled_date === today)
    else if (activeFilter === 'scheduled') baseList = baseList.filter(o => o.plan_decision === 'scheduled')
    else if (activeFilter === 'hold') baseList = baseList.filter(o => o.plan_decision === 'hold')
    else if (activeFilter === 'unfulfillable') baseList = baseList.filter(o => o.plan_decision === 'unfulfillable')
    else if (activeFilter === 'undecided') baseList = baseList.filter(o => o.plan_decision === 'undecided')
    else if (activeFilter !== 'ALL') baseList = baseList.filter(o => liveUrgency(o) === activeFilter)
    if (courierFilter.size > 0) baseList = baseList.filter(o => courierFilter.has(o.courier))
    baseList.forEach(o => { const d = displayDaysLeft(o); if (d !== null) vals.add(d) })
    return Array.from(vals).sort((a, b) => a - b)
  }, [activeOrders, activeFilter, courierFilter, today])

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
    // Include scheduled orders AND unfulfillable orders that have been given a target date by manager
    const scheduled = orders.filter(o =>
      !o.is_cancelled && !o.is_dispatched && (
        o.plan_decision === 'scheduled' ||
        (o.plan_decision === 'unfulfillable' && o.target_dispatch_date)
      )
    )
    // Use target_dispatch_date for unfulfillable orders, scheduled_date for scheduled
    scheduled.forEach(o => {
      if (o.plan_decision === 'unfulfillable' && o.target_dispatch_date && !o.scheduled_date) {
        o = { ...o, scheduled_date: o.target_dispatch_date }
      }
    })
    // Group by date -> courier -> sku
    const dateMap: Record<string, Record<string, Record<string, { sku: string; courier: Courier; qty: number; count: number; orders: DBOrder[] }>>> = {}
    scheduled.forEach(o => {
      const date = (o.plan_decision === 'unfulfillable' ? o.target_dispatch_date : o.scheduled_date) || 'Unscheduled'
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

  // ── Export Plan orders to Excel (.xlsx via SpreadsheetML, no dependency) ──
  const exportPlanXlsx = () => {
    const rowsData = filteredActive
    const decisionLabel = (o: DBOrder) =>
      o.plan_decision === 'scheduled' ? (o.scheduled_date ? `Scheduled ${o.scheduled_date}` : 'Scheduled')
      : o.plan_decision === 'hold' ? 'On Hold'
      : o.plan_decision === 'unfulfillable' ? 'Unfulfillable'
      : 'Undecided'
    const headers = ['Urgency', 'Order ID', 'Customer', 'SKU', 'Barcode SKU', 'Courier', 'Pincode', 'City', 'ODA', 'AWB', 'Transit (d)', 'Promise', 'Dispatch By', 'Days Left', 'Decision', 'Scheduled Date']
    const rows = rowsData.map(o => [
      liveUrgency(o) || '',
      o.order_id,
      o.customer_name,
      o.sku,
      o.barcode_sku || '',
      o.courier,
      o.pincode,
      o.city || '',
      o.oda === 'ODA' ? 'ODA' : '',
      o.tracking_number || '',
      o.transit_days,
      o.promise_date || '',
      o.dispatch_by_date || '',
      displayDaysLeft(o) ?? '',
      decisionLabel(o),
      o.scheduled_date || '',
    ])

    const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const cell = (v: unknown) => {
      if (typeof v === 'number') return `<Cell><Data ss:Type="Number">${v}</Data></Cell>`
      return `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`
    }
    const headerRow = `<Row>${headers.map(h => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${esc(h)}</Data></Cell>`).join('')}</Row>`
    const bodyRows = rows.map(r => `<Row>${r.map(cell).join('')}</Row>`).join('')

    const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="hdr"><Font ss:Bold="1"/><Interior ss:Color="#F0F0F0" ss:Pattern="Solid"/></Style>
 </Styles>
 <Worksheet ss:Name="Plan">
  <Table>${headerRow}${bodyRows}</Table>
 </Worksheet>
</Workbook>`

    const blob = new Blob([xml], { type: 'application/vnd.ms-excel' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 10)
    const scope = activeFilter === 'ALL' ? 'all' : activeFilter
    a.href = url
    a.download = `dispatch-plan-${scope}-${stamp}.xls`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const reviewCount = unfulfillableOrders.filter(o => !o.target_dispatch_date).length

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' as const }} onClick={() => { setShowDaysPopover(false); setShowCourierPopover(false); setShowDispatchDatePopover(false); setShowDispatchedDatePopover(false); setShowSkuPopover(false); setShowDispatchedStatusPopover(false); setShowDispatchedCourierPopover(false) }}>

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
      {/* Manual dispatch modal */}
      {manualDispatchOrder && (
        <Modal title="Mark as Dispatched" onClose={() => { setManualDispatchOrder(null); setManualDispatchSku('') }}>
          <div style={{ marginBottom: 4 }}>
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7, padding: '12px 14px', fontFamily: 'DM Mono', fontSize: 12, marginBottom: 16, display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
              <span style={{ color: 'var(--text)', fontWeight: 500 }}>{manualDispatchOrder.customer_name}</span>
              <span style={{ color: 'var(--text2)' }}>{manualDispatchOrder.sku}</span>
              <span style={{ color: 'var(--text3)' }}>{manualDispatchOrder.order_id}</span>
            </div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text2)', marginBottom: 6, fontWeight: 500 }}>
              Barcode SKU from Shypassist
            </label>
            <input
              type="text"
              value={manualDispatchSku}
              onChange={e => setManualDispatchSku(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleManualDispatch() }}
              placeholder="Scan or type barcode SKU…"
              autoFocus
              style={{
                width: '100%', padding: '9px 12px',
                borderRadius: 7, border: '1px solid var(--border)',
                background: 'var(--bg)', color: 'var(--text)',
                fontSize: 13, fontFamily: 'DM Mono', outline: 'none',
              }}
              onFocus={e => e.target.style.borderColor = 'var(--dispatched)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'}
            />
            <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
              This will be stored in the order history for reference.
            </p>
          </div>
          <ModalActions
            onCancel={() => { setManualDispatchOrder(null); setManualDispatchSku('') }}
            onConfirm={handleManualDispatch}
            confirmLabel={manualDispatching ? 'Marking…' : 'Mark as Dispatched'}
            confirmColor="var(--dispatched)"
            disabled={manualDispatching || !manualDispatchSku.trim()}
          />
        </Modal>
      )}

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
                    }[liveUrgency(o) as string] || 'var(--text3)'
                    return (
                      <div key={o.id} style={{
                        padding: '8px 12px',
                        borderBottom: '1px solid var(--border)',
                        background: '#f0fdf4',
                        display: 'flex', alignItems: 'center', gap: 10,
                      }}>
                        <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--dispatched)', background: 'var(--dispatched-bg)', padding: '2px 6px', borderRadius: 4, border: '1px solid #bbf7d0', whiteSpace: 'nowrap' as const }}>DISPATCH</span>
                        <span style={{ fontSize: 11, fontFamily: 'DM Mono', fontWeight: 600, color: uc, minWidth: 60 }}>{liveUrgency(o)}</span>
                        <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>{o.customer_name}</span>
                        <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'DM Mono' }}>d{displayDaysLeft(o) ?? '?'}</span>
                      </div>
                    )
                  })}
                  {/* Unfulfillable rows */}
                  {allocationPreview.unfulfillable.map((o, i) => {
                    const uc = {
                      CRITICAL: 'var(--critical)', TODAY: 'var(--today)',
                      PLAN: 'var(--plan)', HOLD: 'var(--hold)',
                    }[liveUrgency(o) as string] || 'var(--text3)'
                    return (
                      <div key={o.id} style={{
                        padding: '8px 12px',
                        borderBottom: i < allocationPreview.unfulfillable.length - 1 ? '1px solid var(--border)' : 'none',
                        background: '#fef2f2',
                        display: 'flex', alignItems: 'center', gap: 10,
                      }}>
                        <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--critical)', background: 'var(--critical-bg)', padding: '2px 6px', borderRadius: 4, border: '1px solid #fecaca', whiteSpace: 'nowrap' as const }}>UNFULFIL.</span>
                        <span style={{ fontSize: 11, fontFamily: 'DM Mono', fontWeight: 600, color: uc, minWidth: 60 }}>{liveUrgency(o)}</span>
                        <span style={{ fontSize: 12, color: 'var(--text)', flex: 1, fontFamily: 'DM Mono' }}>{o.tracking_number || '— no AWB —'}</span>
                        <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'DM Mono' }}>d{displayDaysLeft(o) ?? '?'}</span>
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
            { key: 'dispatched', label: dispatchedOrders.length ? `Dispatched (${dispatchedOrders.length})` : 'Dispatched', show: access.can_dispatched },
            { key: 'eod', label: 'End of Day', show: access.can_eod },
            { key: 'inventory', label: 'Inventory', show: access.can_warehouse },
            { key: 'skumap', label: 'SKU Map', show: access.can_users },
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Global search */}
          <div style={{ position: 'relative' as const }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'var(--bg2)', border: '1px solid var(--border)',
              borderRadius: 7, padding: '5px 12px',
              transition: 'width 0.2s, border-color 0.15s',
              width: showSearch ? 240 : 160,
            }}>
              <Search size={13} style={{ color: 'var(--text3)', flexShrink: 0 }} />
              <input
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setShowSearch(true) }}
                onFocus={() => setShowSearch(true)}
                onBlur={() => setTimeout(() => setShowSearch(false), 200)}
                placeholder="Search orders…"
                style={{
                  border: 'none', background: 'transparent',
                  color: 'var(--text)', fontSize: 13, outline: 'none',
                  width: '100%', fontFamily: 'DM Sans',
                }}
              />
              {searchQuery && (
                <button onClick={() => { setSearchQuery(''); setShowSearch(false) }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 0, lineHeight: 1 }}>
                  <X size={12} />
                </button>
              )}
            </div>
            {/* Search results dropdown */}
            {showSearch && searchResults.length > 0 && (
              <div style={{
                position: 'fixed' as const,
                top: 56, right: 156,
                width: 360, zIndex: 300,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                overflow: 'hidden',
              }}>
                <div style={{ padding: '8px 12px 6px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text3)', fontFamily: 'DM Mono' }}>
                  {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
                </div>
                {searchResults.map(order => {
                  const lu = liveUrgency(order); const uc = { CRITICAL: 'var(--critical)', TODAY: 'var(--today)', PLAN: 'var(--plan)', HOLD: 'var(--hold)' }[lu as string] || 'var(--text3)'
                  return (
                    <button key={order.id}
                      onMouseDown={() => { setHistoryOrder(order); setSearchQuery(''); setShowSearch(false) }}
                      style={{
                        width: '100%', padding: '10px 14px',
                        background: 'none', border: 'none', borderBottom: '1px solid var(--border)',
                        cursor: 'pointer', textAlign: 'left' as const,
                        display: 'flex', alignItems: 'center', gap: 10,
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg2)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                          <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{order.order_id}</span>
                          {lu && <span style={{ fontSize: 9, fontFamily: 'DM Mono', fontWeight: 600, color: uc, flexShrink: 0 }}>{lu}</span>}
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontSize: 12, color: 'var(--text)', fontWeight: 500 }}>{order.customer_name}</span>
                          <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{order.sku}</span>
                        </div>
                      </div>
                      <div style={{ flexShrink: 0, fontSize: 10, color: 'var(--text3)', fontFamily: 'DM Mono' }}>
                        {order.is_dispatched ? '✓ dispatched' : order.is_cancelled ? 'cancelled' : order.plan_decision === 'scheduled' ? `📅 ${order.scheduled_date ? new Date(order.scheduled_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''}` : order.plan_decision}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
            {showSearch && searchQuery.length >= 3 && searchResults.length === 0 && (
              <div style={{
                position: 'fixed' as const, top: 56, right: 156,
                width: 280, zIndex: 300,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                padding: '16px', textAlign: 'center' as const,
                color: 'var(--text3)', fontSize: 13,
              }}>
                No orders found
              </div>
            )}
          </div>

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
                      {importResult.unmapped > 0 && <span style={{ color: 'var(--today)', display: 'flex', alignItems: 'center', gap: 4 }}>· <AlertTriangle size={13} /> {importResult.unmapped} unmapped SKU{importResult.unmapped !== 1 ? 's' : ''}</span>}
                    </div>
                  )}
                  {orders.length > 0 && (
                    <button onClick={() => setTab('plan')} style={{ marginLeft: 'auto', padding: '9px 18px', borderRadius: 7, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
                      Go to Plan <ArrowRight size={14} />
                    </button>
                  )}
                </div>
                {importResult && importResult.unmapped > 0 && (
                  <div style={{ padding: '12px 16px', background: 'var(--today-bg)', border: '1px solid #fed7aa', borderRadius: 8, color: 'var(--today)', fontSize: 13, display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <AlertTriangle size={15} />
                      {importResult.unmapped} order{importResult.unmapped !== 1 ? 's' : ''} across {importResult.unmappedSkus.length} SKU{importResult.unmappedSkus.length !== 1 ? 's' : ''} couldn&apos;t resolve a barcode. Map these in the SKU Map tab — they can&apos;t be scan-verified until mapped (paste fallback still works).
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6 }}>
                      {importResult.unmappedSkus.map(u => (
                        <span key={u.sku} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', background: 'var(--surface)', border: '1px solid #fed7aa', borderRadius: 5, fontSize: 12, fontFamily: 'DM Mono', color: 'var(--text)' }}>
                          {u.sku} <span style={{ color: 'var(--text3)' }}>×{u.count}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
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
                { key: 'slipped' as ActiveFilter, label: 'Slipped', value: slippedCount, color: '#dc2626', bg: '#fef2f2', border: '#fca5a5' },
                { key: 'hold' as ActiveFilter, label: 'On Hold', value: holdCount, color: 'var(--hold)', bg: 'var(--hold-bg)', border: '#bfdbfe' },
                { key: 'unfulfillable' as ActiveFilter, label: 'Unfulfillable', value: unfulfillableCount, color: 'var(--critical)', bg: 'var(--critical-bg)', border: '#fecaca' },
                { key: 'unmapped' as ActiveFilter, label: 'Unmapped SKU', value: unmappedCount, color: '#9333ea', bg: '#faf5ff', border: '#e9d5ff' },
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
                    <span style={{ color: kpi.color, fontFamily: 'DM Mono', fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{kpi.value}</span>
                    <span style={{ color: 'var(--text2)', fontSize: 11, fontWeight: 600, marginTop: 2 }}>{kpi.label}</span>
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
                <button onClick={exportPlanXlsx} disabled={filteredActive.length === 0} title="Download current view as Excel" style={{ background: filteredActive.length === 0 ? 'var(--bg2)' : 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: filteredActive.length === 0 ? 'var(--text3)' : 'var(--text2)', cursor: filteredActive.length === 0 ? 'not-allowed' : 'pointer', padding: '5px 12px', display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 500 }}>
                  <Download size={12} /> Export
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
            ) : activeOrders.length === 0 ? (
              <div style={{ ...card, padding: 60, textAlign: 'center' as const, color: 'var(--text2)' }}>
                No orders imported yet. Go to Import tab.
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
                          { label: 'SKU_FILTER_SPECIAL', col: 'sku' },
                          { label: 'COURIER_SPECIAL', col: 'courier' },
                          { label: 'Pincode · City', col: 'pincode' },
                          { label: 'ODA', col: null },
                          { label: 'AWB', col: null },
                          { label: 'Transit', col: 'transit' },
                          { label: 'Promise', col: 'promise' },
                          { label: 'Dispatch By', col: 'dispatch_by' },
                        ] as { label: string; col: string | null }[]).map(({ label, col }) => {
                          // Special SKU header with filter
                          if (label === 'SKU_FILTER_SPECIAL') return (
                            <th key="sku" style={{ padding: '9px 12px', whiteSpace: 'nowrap' as const }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <span onClick={() => handleColSort('sku')} style={{ color: sortCol === 'sku' ? 'var(--accent)' : 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, cursor: 'pointer', userSelect: 'none' as const }}>
                                  SKU{sortCol === 'sku' ? <span style={{ marginLeft: 3 }}>{sortDir === 'asc' ? '↑' : '↓'}</span> : <span style={{ marginLeft: 3, opacity: 0.3 }}>↕</span>}
                                </span>
                                <button onClick={e => {
                                  e.stopPropagation()
                                  const rect = e.currentTarget.getBoundingClientRect()
                                  setSkuPopoverPos({ top: rect.bottom + 6, left: rect.left })
                                  setShowSkuPopover(v => !v)
                                  setShowDaysPopover(false); setShowCourierPopover(false)
                                }} style={{
                                  background: skuFilter.size > 0 ? 'var(--accent-bg)' : 'none',
                                  border: skuFilter.size > 0 ? '1px solid var(--accent)' : '1px solid var(--border)',
                                  borderRadius: 4, cursor: 'pointer', padding: '1px 5px',
                                  color: skuFilter.size > 0 ? 'var(--accent)' : 'var(--text3)',
                                  fontSize: 10, fontFamily: 'DM Mono', lineHeight: 1.4,
                                }}>
                                  {skuFilter.size > 0 ? `${skuFilter.size} ▾` : '▾'}
                                </button>
                                {skuFilter.size > 0 && <button onClick={() => setSkuFilter(new Set())} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 10, padding: '0 2px' }}>✕</button>}
                              </div>
                              {showSkuPopover && (
                                <div style={{ position: 'fixed' as const, top: skuPopoverPos.top, left: skuPopoverPos.left, zIndex: 500, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, minWidth: 220, boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }} onClick={e => e.stopPropagation()}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                    <span style={{ fontSize: 11, color: 'var(--text2)', fontFamily: 'DM Mono', fontWeight: 500 }}>SKU</span>
                                    <button onClick={() => { setSkuFilter(new Set()); setShowSkuPopover(false) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 11 }}>Clear</button>
                                  </div>
                                  <input value={skuSearch} onChange={e => setSkuSearch(e.target.value)} placeholder="Search SKUs…"
                                    style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 11, outline: 'none', marginBottom: 6, fontFamily: 'DM Mono' }} />
                                  <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column' as const, gap: 2 }}>
                                    {Array.from(new Set(activeOrders.map(o => o.sku))).filter(s => !skuSearch || s.toLowerCase().includes(skuSearch.toLowerCase())).sort().map(sku => {
                                      const isSelected = skuFilter.has(sku)
                                      const count = activeFilterBase.filter(o => o.sku === sku).length
                                      return (
                                        <button key={sku} onClick={() => setSkuFilter(prev => { const n = new Set(prev); n.has(sku) ? n.delete(sku) : n.add(sku); return n })}
                                          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 5, border: 'none', background: isSelected ? 'var(--accent-bg)' : 'transparent', cursor: 'pointer', textAlign: 'left' as const, width: '100%' }}>
                                          <span style={{ width: 13, height: 13, borderRadius: 3, border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--border2)'}`, background: isSelected ? 'var(--accent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                            {isSelected && <span style={{ color: '#fff', fontSize: 8 }}>✓</span>}
                                          </span>
                                          <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text)', flex: 1 }}>{sku}</span>
                                          <span style={{ fontSize: 10, color: 'var(--text3)' }}>{count}</span>
                                        </button>
                                      )
                                    })}
                                  </div>
                                  <button onClick={() => setShowSkuPopover(false)} style={{ marginTop: 8, width: '100%', padding: '5px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12 }}>Done</button>
                                </div>
                              )}
                            </th>
                          )

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
                                      const count = activeFilterBase.filter(o => o.courier === courier).length
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
                                        {(() => {
                                        let base = [...activeOrders]
                                        if (activeFilter === 'scheduled') base = base.filter(o => o.plan_decision === 'scheduled')
                                        else if (activeFilter === 'hold') base = base.filter(o => o.plan_decision === 'hold')
                                        else if (activeFilter === 'unfulfillable') base = base.filter(o => o.plan_decision === 'unfulfillable')
                                        else if (activeFilter === 'undecided') base = base.filter(o => o.plan_decision === 'undecided')
                                        else if (activeFilter !== 'ALL' && activeFilter !== 'scheduled_today') base = base.filter(o => liveUrgency(o) === activeFilter)
                                        if (courierFilter.size > 0) base = base.filter(o => courierFilter.has(o.courier))
                                        return base.filter(o => displayDaysLeft(o) === d).length
                                      })()}
                                      </span>
                                    </button>
                                  )
                                })}
                              </div>
                              <button onClick={() => setShowDaysPopover(false)} style={{ marginTop: 10, width: '100%', padding: '6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12 }}>Done</button>
                            </div>
                          )}
                        </th>
                        <th style={{ padding: '9px 12px', whiteSpace: 'nowrap' as const }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500 }}>Decision</span>
                            <button
                              onClick={e => {
                                e.stopPropagation()
                                const rect = e.currentTarget.getBoundingClientRect()
                                setDispatchDatePopoverPos({ top: rect.bottom + 6, left: rect.left })
                                setShowDispatchDatePopover(v => !v)
                                setShowDaysPopover(false)
                                setShowCourierPopover(false)
                              }}
                              style={{
                                background: dispatchDateFilter.size > 0 ? 'var(--accent-bg)' : 'none',
                                border: dispatchDateFilter.size > 0 ? '1px solid var(--accent)' : '1px solid var(--border)',
                                borderRadius: 4, cursor: 'pointer', padding: '1px 5px',
                                color: dispatchDateFilter.size > 0 ? 'var(--accent)' : 'var(--text3)',
                                fontSize: 10, fontFamily: 'DM Mono', lineHeight: 1.4,
                              }}
                            >
                              {dispatchDateFilter.size > 0 ? `${dispatchDateFilter.size} ▾` : '▾'}
                            </button>
                            {dispatchDateFilter.size > 0 && (
                              <button onClick={() => setDispatchDateFilter(new Set())} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 10, padding: '0 2px' }}>✕</button>
                            )}
                          </div>
                          {/* Dispatch date popover */}
                          {showDispatchDatePopover && (
                            <div
                              style={{
                                position: 'fixed' as const,
                                top: dispatchDatePopoverPos.top,
                                left: dispatchDatePopoverPos.left,
                                zIndex: 500,
                                background: 'var(--surface)', border: '1px solid var(--border)',
                                borderRadius: 8, padding: 12, minWidth: 200,
                                boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                              }}
                              onClick={e => e.stopPropagation()}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                <span style={{ fontSize: 11, color: 'var(--text2)', fontFamily: 'DM Mono', fontWeight: 500 }}>DISPATCH DATE</span>
                                <button onClick={() => { setDispatchDateFilter(new Set()); setShowDispatchDatePopover(false) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 11 }}>Clear</button>
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2, maxHeight: 240, overflowY: 'auto' }}>
                                {uniqueDispatchDates.map(date => {
                                  const isSelected = dispatchDateFilter.has(date)
                                  const isToday = date === today
                                  const label = date === 'none' ? 'No date set'
                                    : new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
                                  const color = date === 'none' ? 'var(--text3)' : isToday ? '#059669' : 'var(--hold)'
                                  const count = activeOrders.filter(o => (o.scheduled_date || 'none') === date).length
                                  return (
                                    <button key={date} onClick={() => {
                                      setDispatchDateFilter(prev => {
                                        const n = new Set(prev)
                                        n.has(date) ? n.delete(date) : n.add(date)
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
                                      <span style={{ fontFamily: 'DM Mono', fontSize: 12, fontWeight: 500, color, flex: 1 }}>
                                        {label}{isToday && ' (Today)'}
                                      </span>
                                      <span style={{ fontSize: 11, color: 'var(--text3)' }}>{count}</span>
                                    </button>
                                  )
                                })}
                              </div>
                              <button onClick={() => setShowDispatchDatePopover(false)} style={{ marginTop: 10, width: '100%', padding: '6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12 }}>Done</button>
                            </div>
                          )}
                        </th>
                        <th style={{ padding: '9px 12px', width: 32 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {filteredActive.length === 0 && (
                        <tr><td colSpan={16} style={{ padding: 40, textAlign: 'center' as const, color: 'var(--text3)' }}>No orders match this filter. Adjust or clear the filters above.</td></tr>
                      )}
                      {filteredActive.map(order => (
                        <OrderRow key={order.id} order={order}
                          selected={selectedIds.has(order.id)}
                          updating={updatingIds.has(order.id)}
                          daysLeftDisplay={displayDaysLeft(order)}
                          liveUrgencyTier={liveUrgency(order)}
                          onSelect={toggleSelect}
                          onDecision={updateDecision}
                          onSchedule={scheduleOrder}
                          onPriority={togglePriority}
                          onCancel={id => setCancelOrderId(id)}
                          onHistory={order => setHistoryOrder(order)}
                          onManualDispatch={order => setManualDispatchOrder(order)}
                          onSaveCourier={saveCourier}
                          editingAwbId={editingAwbId}
                          editingAwbValue={editingAwbValue}
                          onEditAwb={(id, val) => { setEditingAwbId(id); setEditingAwbValue(val) }}
                          onSaveAwb={saveAwb}
                          onCancelAwb={() => { setEditingAwbId(null); setEditingAwbValue('') }}
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
                            const uc = urgencyStyle(liveUrgency(order))
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
                                  <span style={{ fontFamily: 'DM Mono', fontSize: 14, fontWeight: 600, color: uc.color }}>{displayDaysLeft(order) ?? '—'}</span>
                                </td>
                                <td style={{ padding: '10px 16px' }}>
                                  <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontFamily: 'DM Mono', fontWeight: 500, color: uc.color, background: uc.bg, border: `1px solid ${uc.border}` }}>
                                    {liveUrgency(order) || '—'}
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
                                  <div style={{ display: 'flex', gap: 6 }}>
                                    {order.target_dispatch_date && (
                                      <button onClick={() => approveForDispatch(order.id)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #bbf7d0', background: 'var(--dispatched-bg)', color: 'var(--dispatched)', fontSize: 11, cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
                                        <CheckCircle size={11} /> Approve
                                      </button>
                                    )}
                                    <button onClick={() => cancelFromReview(order.id)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #fecaca', background: 'var(--critical-bg)', color: 'var(--critical)', fontSize: 11, cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
                                      <Ban size={11} /> Cancel
                                    </button>
                                  </div>
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
                            const uc = urgencyStyle(liveUrgency(order))
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
                                <td style={{ padding: '10px 16px', textAlign: 'center' as const }}><span style={{ fontFamily: 'DM Mono', fontSize: 14, fontWeight: 600, color: uc.color }}>{displayDaysLeft(order) ?? '—'}</span></td>
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
                                  <div style={{ display: 'flex', gap: 6 }}>
                                    {order.target_dispatch_date && (
                                      <button onClick={() => approveForDispatch(order.id)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #bbf7d0', background: 'var(--dispatched-bg)', color: 'var(--dispatched)', fontSize: 11, cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
                                        <CheckCircle size={11} /> Approve
                                      </button>
                                    )}
                                    <button onClick={() => cancelFromReview(order.id)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #fecaca', background: 'var(--critical-bg)', color: 'var(--critical)', fontSize: 11, cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
                                      <Ban size={11} /> Cancel
                                    </button>
                                  </div>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' as const }}>
              <h1 style={{ fontSize: 18, fontWeight: 600 }}>Picklist</h1>
              <span style={{ color: 'var(--text3)', fontSize: 14 }}>
                {scheduledCount} orders scheduled · {picklist.reduce((s, g) => s + g.couriers.reduce((cs, c) => cs + c.items.reduce((is, i) => is + i.qty, 0), 0), 0)} pieces
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                {selectedPrintDates.size > 0 && (
                  <button onClick={() => {
                    // Store selected dates and trigger print
                    window.dispatchEvent(new CustomEvent('printSelectedDates', { detail: Array.from(selectedPrintDates) }))
                    window.print()
                  }} style={{
                    padding: '8px 16px', borderRadius: 7,
                    background: 'var(--accent)', border: 'none',
                    color: '#fff', fontSize: 13, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600,
                  }}>
                    <Printer size={14} /> Print Selected ({selectedPrintDates.size})
                  </button>
                )}
                <button onClick={() => {
                  setSelectedPrintDates(new Set())
                  window.print()
                }} style={{
                  padding: '8px 16px', borderRadius: 7,
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  color: 'var(--text)', fontSize: 13, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500,
                }}>
                  <Printer size={14} /> Print All
                </button>
              </div>
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
                  <div key={date} style={{ display: selectedPrintDates.size > 0 && !selectedPrintDates.has(date) ? 'none' : 'block' }}
                    className={selectedPrintDates.size > 0 && !selectedPrintDates.has(date) ? 'print-hide' : ''}>
                    {/* Date header */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }} className={`print-date-${date}`}>
                      <input
                        type="checkbox"
                        checked={selectedPrintDates.has(date)}
                        onChange={() => setSelectedPrintDates(prev => {
                          const n = new Set(prev)
                          n.has(date) ? n.delete(date) : n.add(date)
                          return n
                        })}
                        style={{ width: 15, height: 15, cursor: 'pointer', accentColor: 'var(--accent)', flexShrink: 0 }}
                        className="no-print"
                      />
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
                      <button
                        onClick={() => {
                          setSelectedPrintDates(new Set([date]))
                          setTimeout(() => window.print(), 100)
                        }}
                        className="no-print"
                        style={{
                          marginLeft: 'auto',
                          padding: '5px 12px', borderRadius: 6,
                          background: 'var(--surface)', border: '1px solid var(--border)',
                          color: 'var(--text2)', fontSize: 12, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', gap: 5,
                        }}
                      >
                        <Printer size={12} /> Print this date
                      </button>
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
          {/* ════ UPCOMING DEMAND MATRIX ════ */}
          {upcomingDemand.totalOrders > 0 && (
            <div style={{ marginTop: 8 }}>
              {/* Header row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' as const }}>
                <h2 style={{ fontSize: 16, fontWeight: 600 }}>Upcoming Demand</h2>
                {[
                  { label: 'Undecided', value: upcomingDemand.totalOrders, color: 'var(--text)', bg: 'var(--bg2)', border: 'var(--border)' },
                  { label: 'Total pieces', value: upcomingDemand.totalQty, color: 'var(--hold)', bg: 'var(--hold-bg)', border: '#bfdbfe' },
                  { label: 'SKUs', value: upcomingDemand.allSkus.length, color: 'var(--accent)', bg: 'var(--accent-bg)', border: 'var(--accent)' },
                ].map(k => (
                  <div key={k.label} style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '5px 14px', background: k.bg, border: `1px solid ${k.border}`, borderRadius: 20 }}>
                    <span style={{ fontFamily: 'DM Mono', fontSize: 15, fontWeight: 700, color: k.color }}>{k.value}</span>
                    <span style={{ fontSize: 11, color: 'var(--text3)' }}>{k.label}</span>
                  </div>
                ))}
                {/* SKU filter */}
                <div style={{ position: 'relative' as const }}>
                  <button onClick={() => setShowDemandSkuPopover(v => !v)} style={{
                    padding: '5px 14px', borderRadius: 20, cursor: 'pointer', fontSize: 12, fontWeight: 500,
                    background: demandSkuFilter.size > 0 ? 'var(--accent-bg)' : 'var(--bg2)',
                    border: `1px solid ${demandSkuFilter.size > 0 ? 'var(--accent)' : 'var(--border)'}`,
                    color: demandSkuFilter.size > 0 ? 'var(--accent)' : 'var(--text3)',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    <Filter size={11} />
                    {demandSkuFilter.size > 0 ? `${demandSkuFilter.size} SKUs selected` : 'Filter SKUs'}
                  </button>
                  {showDemandSkuPopover && (
                    <div style={{
                      position: 'absolute' as const, top: '100%', left: 0, zIndex: 300, marginTop: 4,
                      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.12)', width: 260, padding: 12,
                    }} onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span style={{ fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, color: 'var(--text2)' }}>FILTER SKUs</span>
                        <button onClick={() => setDemandSkuFilter(new Set())} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 11 }}>Clear all</button>
                      </div>
                      <input value={demandSkuSearch} onChange={e => setDemandSkuSearch(e.target.value)}
                        placeholder="Search SKUs…"
                        style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, outline: 'none', marginBottom: 8, fontFamily: 'DM Mono' }}
                      />
                      <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column' as const, gap: 2 }}>
                        {upcomingDemand.allSkus.filter(s => !demandSkuSearch || s.toLowerCase().includes(demandSkuSearch.toLowerCase())).map(sku => (
                          <button key={sku} onClick={() => setDemandSkuFilter(prev => { const n = new Set(prev); n.has(sku) ? n.delete(sku) : n.add(sku); return n })}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 5, border: 'none', background: demandSkuFilter.has(sku) ? 'var(--accent-bg)' : 'transparent', cursor: 'pointer', textAlign: 'left' as const }}>
                            <span style={{ width: 13, height: 13, borderRadius: 3, border: `2px solid ${demandSkuFilter.has(sku) ? 'var(--accent)' : 'var(--border2)'}`, background: demandSkuFilter.has(sku) ? 'var(--accent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              {demandSkuFilter.has(sku) && <span style={{ color: '#fff', fontSize: 8 }}>✓</span>}
                            </span>
                            <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text)', flex: 1 }}>{sku}</span>
                            <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{upcomingDemand.skuTotals[sku]}</span>
                          </button>
                        ))}
                      </div>
                      <button onClick={() => setShowDemandSkuPopover(false)} style={{ marginTop: 10, width: '100%', padding: '6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12 }}>Done</button>
                    </div>
                  )}
                </div>
                {demandSkuFilter.size > 0 && (
                  <button onClick={() => setDemandSkuFilter(new Set())} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 11, padding: '2px 4px' }}>✕ clear</button>
                )}
                {/* Toggle */}
                <div style={{ marginLeft: 'auto', display: 'flex', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden' }}>
                  {(['weekly', 'daily'] as const).map(v => (
                    <button key={v} onClick={() => setDemandView(v)} style={{
                      padding: '5px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500,
                      background: demandView === v ? 'var(--accent)' : 'transparent',
                      color: demandView === v ? '#fff' : 'var(--text3)',
                    }}>{v.charAt(0).toUpperCase() + v.slice(1)}</button>
                  ))}
                </div>
              </div>

              {/* Matrix table */}
              {(() => {
                const cols = demandView === 'weekly' ? upcomingDemand.weeklyCols : upcomingDemand.dailyCols
                const visibleSkus = demandSkuFilter.size > 0 ? upcomingDemand.allSkus.filter(s => demandSkuFilter.has(s)) : upcomingDemand.allSkus
                const getQty = (sku: string, colKey: string) => demandView === 'weekly'
                  ? upcomingDemand.weekSkuQty[colKey]?.[sku] || 0
                  : upcomingDemand.dateSkuQty[colKey]?.[sku] || 0
                const getOrders = (sku: string, colKey: string) => demandView === 'weekly'
                  ? upcomingDemand.weekSkuOrders[colKey]?.[sku] || 0
                  : upcomingDemand.dateSkuOrders[colKey]?.[sku] || 0
                const colTotal = (colKey: string) => visibleSkus.reduce((s, sku) => s + getQty(sku, colKey), 0)

                return (
                  <div style={{ ...card, overflow: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: 'var(--bg2)', borderBottom: '2px solid var(--border2)' }}>
                          <th style={{ padding: '9px 16px', textAlign: 'left' as const, fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)', fontWeight: 500, whiteSpace: 'nowrap' as const, position: 'sticky' as const, left: 0, background: 'var(--bg2)', zIndex: 1, minWidth: 160 }}>SKU</th>
                          <th style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)', fontWeight: 500, whiteSpace: 'nowrap' as const }}>Total</th>
                          {cols.map(col => (
                            <th key={col.key} style={{
                              padding: '9px 12px', textAlign: 'center' as const,
                              fontFamily: 'DM Mono', fontSize: 11, fontWeight: 600,
                              whiteSpace: 'nowrap' as const, minWidth: 80,
                              color: col.isOverdue ? '#dc2626' : col.isUrgent ? '#059669' : 'var(--text2)',
                              background: col.isOverdue ? '#fef2f2' : col.isUrgent ? '#ecfdf5' : 'transparent',
                            }}>
                              {col.label}
                              {'sublabel' in col && (col as {sublabel: string}).sublabel && (
                                <div style={{ fontSize: 9, fontWeight: 400, color: 'var(--text3)', marginTop: 1 }}>
                                  {(col as {sublabel: string}).sublabel}
                                </div>
                              )}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {visibleSkus.map((sku, i) => {
                          const rowTotal = upcomingDemand.skuTotals[sku] || 0
                          return (
                            <tr key={sku} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
                              <td style={{ padding: '8px 16px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text)', fontWeight: 500, position: 'sticky' as const, left: 0, background: i % 2 === 0 ? 'var(--surface)' : 'var(--bg2)', zIndex: 1, whiteSpace: 'nowrap' as const }}>{sku}</td>
                              <td style={{ padding: '8px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--text)', fontSize: 13 }}>{rowTotal}</td>
                              {cols.map(col => {
                                const qty = getQty(sku, col.key)
                                const orderCount = getOrders(sku, col.key)
                                return (
                                  <td key={col.key} style={{
                                    padding: '8px 12px', textAlign: 'center' as const,
                                    fontFamily: 'DM Mono',
                                    background: qty > 0 ? (col.isOverdue ? '#fef2f2' : col.isUrgent ? 'var(--today-bg)' : 'transparent') : 'transparent',
                                  }}>
                                    {qty > 0 ? (
                                      <div>
                                        <div style={{ fontWeight: 700, fontSize: 13, color: col.isOverdue ? '#dc2626' : col.isUrgent ? 'var(--today)' : 'var(--text)' }}>{qty}</div>
                                        <div style={{ fontSize: 9, color: 'var(--text3)', marginTop: 1 }}>{orderCount}o</div>
                                      </div>
                                    ) : (
                                      <span style={{ color: 'var(--border2)', fontSize: 11 }}>—</span>
                                    )}
                                  </td>
                                )
                              })}
                            </tr>
                          )
                        })}
                      </tbody>
                      <tfoot>
                        <tr style={{ borderTop: '2px solid var(--border2)', background: 'var(--bg2)' }}>
                          <td style={{ padding: '9px 16px', fontFamily: 'DM Mono', fontSize: 11, fontWeight: 600, color: 'var(--text2)', position: 'sticky' as const, left: 0, background: 'var(--bg2)' }}>Total pcs</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>{upcomingDemand.totalQty}</td>
                          {cols.map(col => (
                            <td key={col.key} style={{ padding: '9px 12px', textAlign: 'center' as const, fontFamily: 'DM Mono', fontWeight: 700, fontSize: 13, color: col.isOverdue ? '#dc2626' : col.isUrgent ? 'var(--today)' : 'var(--text)' }}>
                              {colTotal(col.key) || '—'}
                            </td>
                          ))}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )
              })()}
            </div>
          )}
          </div>
        )}

        {/* ════ DISPATCHED ════ */}
        {tab === 'dispatched' && access.can_dispatched && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <h1 style={{ fontSize: 18, fontWeight: 600 }}>Dispatched Orders</h1>
              <span style={{ fontSize: 13, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{filteredDispatched.length} of {dispatchedOrders.length}</span>
              {/* Sync tracking */}
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
                {trackingLastSync && (
                  <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'DM Mono' }}>
                    Synced {trackingLastSync.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
                <button onClick={syncTracking} disabled={trackingLoading} style={{
                  padding: '7px 16px', borderRadius: 7, border: 'none', cursor: trackingLoading ? 'default' : 'pointer',
                  background: trackingLoading ? 'var(--bg2)' : 'var(--accent)', color: trackingLoading ? 'var(--text3)' : '#fff',
                  fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <RefreshCw size={13} style={{ animation: trackingLoading ? 'spin 1s linear infinite' : 'none' }} />
                  {trackingLoading ? (trackingProgress ? `Syncing ${trackingProgress.done}/${trackingProgress.total}` : 'Syncing…') : 'Sync Tracking'}
                </button>
              </div>
              {/* Search */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 12px' }}>
                <Search size={13} style={{ color: 'var(--text3)' }} />
                <input
                  value={dispatchedSearch}
                  onChange={e => setDispatchedSearch(e.target.value)}
                  placeholder="Search dispatched…"
                  style={{ border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: 'DM Sans', width: 200 }}
                />
                {dispatchedSearch && <button onClick={() => setDispatchedSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 0 }}><X size={12} /></button>}
              </div>
            </div>

            {access.can_users && <CargoTokenPanel />}

            <div style={{ ...card, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' as const }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' as const, minWidth: 900 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--border2)', background: 'var(--bg2)' }}>
                      {([
                        { label: 'DISPATCHED_DATE_SPECIAL', col: 'dispatched_at' },
                        { label: 'Order ID', col: 'order_id' },
                        { label: 'Customer', col: 'customer_name' },
                        { label: 'SKU', col: 'sku' },
                        { label: 'Dispatched Barcode', col: 'scanned_barcode' },
                        { label: 'COURIER_FILTER_SPECIAL', col: null },
                        { label: 'AWB', col: 'tracking_number' },
                        { label: 'Pincode · City', col: 'pincode' },
                        { label: 'Promise', col: 'promise_date' },
                        { label: 'STATUS_FILTER_SPECIAL', col: null },
                        { label: '', col: null },
                      ] as { label: string; col: string | null }[]).map(({ label, col }) => {
                        if (label === 'COURIER_FILTER_SPECIAL') {
                          const COURIER_OPTS = ['Bluedart', 'Delhivery']
                          const courierCount = (c: string) => dispatchedOrders.filter(o => o.courier === c).length
                          return (
                            <th key="courier" style={{ padding: '9px 12px', whiteSpace: 'nowrap' as const }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <span style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500 }}>Cour.</span>
                                <button onClick={e => {
                                  e.stopPropagation()
                                  const rect = e.currentTarget.getBoundingClientRect()
                                  setDispatchedCourierPopoverPos({ top: rect.bottom + 6, left: Math.max(8, rect.left - 80) })
                                  setShowDispatchedCourierPopover(v => !v)
                                }} style={{
                                  background: dispatchedCourierFilter.size > 0 ? 'var(--accent-bg)' : 'none',
                                  border: dispatchedCourierFilter.size > 0 ? '1px solid var(--accent)' : '1px solid var(--border)',
                                  borderRadius: 4, cursor: 'pointer', padding: '1px 5px',
                                  color: dispatchedCourierFilter.size > 0 ? 'var(--accent)' : 'var(--text3)',
                                  fontSize: 10, fontFamily: 'DM Mono', lineHeight: 1.4,
                                }}>
                                  {dispatchedCourierFilter.size > 0 ? `${dispatchedCourierFilter.size} ▾` : '▾'}
                                </button>
                                {dispatchedCourierFilter.size > 0 && <button onClick={() => setDispatchedCourierFilter(new Set())} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 10, padding: '0 2px' }}>✕</button>}
                              </div>
                              {showDispatchedCourierPopover && (
                                <div style={{ position: 'fixed' as const, top: dispatchedCourierPopoverPos.top, left: dispatchedCourierPopoverPos.left, zIndex: 500, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, minWidth: 180, boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }} onClick={e => e.stopPropagation()}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                    <span style={{ fontSize: 11, color: 'var(--text2)', fontFamily: 'DM Mono', fontWeight: 500 }}>COURIER</span>
                                    <button onClick={() => { setDispatchedCourierFilter(new Set()); setShowDispatchedCourierPopover(false) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 11 }}>Clear</button>
                                  </div>
                                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2 }}>
                                    {COURIER_OPTS.map(opt => {
                                      const isSelected = dispatchedCourierFilter.has(opt)
                                      return (
                                        <button key={opt} onClick={() => setDispatchedCourierFilter(prev => { const n = new Set(prev); n.has(opt) ? n.delete(opt) : n.add(opt); return n })}
                                          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 5, border: 'none', background: isSelected ? 'var(--accent-bg)' : 'transparent', cursor: 'pointer', textAlign: 'left' as const, width: '100%' }}>
                                          <span style={{ width: 14, height: 14, borderRadius: 3, border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--border2)'}`, background: isSelected ? 'var(--accent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                            {isSelected && <span style={{ color: '#fff', fontSize: 9, lineHeight: 1 }}>✓</span>}
                                          </span>
                                          <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>{opt}</span>
                                          <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{courierCount(opt)}</span>
                                        </button>
                                      )
                                    })}
                                  </div>
                                  <button onClick={() => setShowDispatchedCourierPopover(false)} style={{ marginTop: 10, width: '100%', padding: '6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12 }}>Done</button>
                                </div>
                              )}
                            </th>
                          )
                        }

                        if (label === 'STATUS_FILTER_SPECIAL') {
                          const STATUS_OPTS: { key: string; label: string }[] = [
                            { key: 'delivered', label: 'Delivered' },
                            { key: 'ofd', label: 'Out for Delivery' },
                            { key: 'in_transit', label: 'In Transit' },
                            { key: 'picked_up', label: 'Picked Up' },
                            { key: 'booked', label: 'Pickup Scheduled' },
                            { key: 'ndr', label: 'NDR' },
                            { key: 'rto', label: 'RTO' },
                            { key: 'unknown', label: 'Unknown' },
                            { key: 'none', label: 'Not Synced' },
                          ]
                          const statusCount = (key: string) => dispatchedOrders.filter(o => {
                            const ls = (o.tracking_number && trackingData[o.tracking_number]?.status) || o.tracking_status || 'none'
                            return ls === key
                          }).length
                          return (
                            <th key="status" style={{ padding: '9px 12px', whiteSpace: 'nowrap' as const }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <span style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500 }}>Status</span>
                                <button onClick={e => {
                                  e.stopPropagation()
                                  const rect = e.currentTarget.getBoundingClientRect()
                                  setDispatchedStatusPopoverPos({ top: rect.bottom + 6, left: Math.max(8, rect.left - 80) })
                                  setShowDispatchedStatusPopover(v => !v)
                                }} style={{
                                  background: dispatchedStatusFilter.size > 0 ? 'var(--accent-bg)' : 'none',
                                  border: dispatchedStatusFilter.size > 0 ? '1px solid var(--accent)' : '1px solid var(--border)',
                                  borderRadius: 4, cursor: 'pointer', padding: '1px 5px',
                                  color: dispatchedStatusFilter.size > 0 ? 'var(--accent)' : 'var(--text3)',
                                  fontSize: 10, fontFamily: 'DM Mono', lineHeight: 1.4,
                                }}>
                                  {dispatchedStatusFilter.size > 0 ? `${dispatchedStatusFilter.size} ▾` : '▾'}
                                </button>
                                {dispatchedStatusFilter.size > 0 && <button onClick={() => setDispatchedStatusFilter(new Set())} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 10, padding: '0 2px' }}>✕</button>}
                              </div>
                              {showDispatchedStatusPopover && (
                                <div style={{ position: 'fixed' as const, top: dispatchedStatusPopoverPos.top, left: dispatchedStatusPopoverPos.left, zIndex: 500, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, minWidth: 190, boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }} onClick={e => e.stopPropagation()}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                    <span style={{ fontSize: 11, color: 'var(--text2)', fontFamily: 'DM Mono', fontWeight: 500 }}>STATUS</span>
                                    <button onClick={() => { setDispatchedStatusFilter(new Set()); setShowDispatchedStatusPopover(false) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 11 }}>Clear</button>
                                  </div>
                                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2, maxHeight: 280, overflowY: 'auto' }}>
                                    {STATUS_OPTS.filter(opt => statusCount(opt.key) > 0).map(opt => {
                                      const isSelected = dispatchedStatusFilter.has(opt.key)
                                      return (
                                        <button key={opt.key} onClick={() => setDispatchedStatusFilter(prev => { const n = new Set(prev); n.has(opt.key) ? n.delete(opt.key) : n.add(opt.key); return n })}
                                          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 5, border: 'none', background: isSelected ? 'var(--accent-bg)' : 'transparent', cursor: 'pointer', textAlign: 'left' as const, width: '100%' }}>
                                          <span style={{ width: 14, height: 14, borderRadius: 3, border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--border2)'}`, background: isSelected ? 'var(--accent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                            {isSelected && <span style={{ color: '#fff', fontSize: 9, lineHeight: 1 }}>✓</span>}
                                          </span>
                                          <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>{opt.label}</span>
                                          <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{statusCount(opt.key)}</span>
                                        </button>
                                      )
                                    })}
                                  </div>
                                  <button onClick={() => setShowDispatchedStatusPopover(false)} style={{ marginTop: 10, width: '100%', padding: '6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12 }}>Done</button>
                                </div>
                              )}
                            </th>
                          )
                        }

                        if (label === 'DISPATCHED_DATE_SPECIAL') return (
                          <th key="dispatched_at" style={{ padding: '9px 12px', whiteSpace: 'nowrap' as const }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <span
                                onClick={() => {
                                  if (dispatchedSortCol === 'dispatched_at') setDispatchedSortDir(d => d === 'asc' ? 'desc' : 'asc')
                                  else { setDispatchedSortCol('dispatched_at'); setDispatchedSortDir('desc') }
                                }}
                                style={{ color: dispatchedSortCol === 'dispatched_at' ? 'var(--accent)' : 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, cursor: 'pointer', userSelect: 'none' as const }}
                              >
                                Dispatched{dispatchedSortCol === 'dispatched_at' ? <span style={{ marginLeft: 3 }}>{dispatchedSortDir === 'asc' ? '↑' : '↓'}</span> : <span style={{ marginLeft: 3, opacity: 0.3 }}>↕</span>}
                              </span>
                              <button
                                onClick={e => {
                                  e.stopPropagation()
                                  const rect = e.currentTarget.getBoundingClientRect()
                                  setDispatchedDatePopoverPos({ top: rect.bottom + 6, left: rect.left })
                                  setShowDispatchedDatePopover(v => !v)
                                }}
                                style={{
                                  background: dispatchedDateFilter.size > 0 ? 'var(--accent-bg)' : 'none',
                                  border: dispatchedDateFilter.size > 0 ? '1px solid var(--accent)' : '1px solid var(--border)',
                                  borderRadius: 4, cursor: 'pointer', padding: '1px 5px',
                                  color: dispatchedDateFilter.size > 0 ? 'var(--accent)' : 'var(--text3)',
                                  fontSize: 10, fontFamily: 'DM Mono', lineHeight: 1.4,
                                }}
                              >
                                {dispatchedDateFilter.size > 0 ? `${dispatchedDateFilter.size} ▾` : '▾'}
                              </button>
                              {dispatchedDateFilter.size > 0 && (
                                <button onClick={() => setDispatchedDateFilter(new Set())} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 10, padding: '0 2px' }}>✕</button>
                              )}
                            </div>
                            {showDispatchedDatePopover && (
                              <div
                                style={{
                                  position: 'fixed' as const,
                                  top: dispatchedDatePopoverPos.top,
                                  left: dispatchedDatePopoverPos.left,
                                  zIndex: 500,
                                  background: 'var(--surface)', border: '1px solid var(--border)',
                                  borderRadius: 8, padding: 12, minWidth: 200,
                                  boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                                }}
                                onClick={e => e.stopPropagation()}
                              >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                  <span style={{ fontSize: 11, color: 'var(--text2)', fontFamily: 'DM Mono', fontWeight: 500 }}>DISPATCH DATE</span>
                                  <button onClick={() => { setDispatchedDateFilter(new Set()); setShowDispatchedDatePopover(false) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 11 }}>Clear</button>
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2, maxHeight: 240, overflowY: 'auto' }}>
                                  {uniqueDispatchedDates.map(date => {
                                    const isSelected = dispatchedDateFilter.has(date)
                                    const label = new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
                                    const count = dispatchedOrders.filter(o => o.dispatched_at?.startsWith(date)).length
                                    return (
                                      <button key={date} onClick={() => setDispatchedDateFilter(prev => { const n = new Set(prev); n.has(date) ? n.delete(date) : n.add(date); return n })}
                                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 5, border: 'none', background: isSelected ? 'var(--accent-bg)' : 'transparent', cursor: 'pointer', textAlign: 'left' as const, width: '100%' }}>
                                        <span style={{ width: 14, height: 14, borderRadius: 3, border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--border2)'}`, background: isSelected ? 'var(--accent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                          {isSelected && <span style={{ color: '#fff', fontSize: 9, lineHeight: 1 }}>✓</span>}
                                        </span>
                                        <span style={{ fontSize: 12, fontFamily: 'DM Mono', color: 'var(--text)', flex: 1 }}>{label}</span>
                                        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{count}</span>
                                      </button>
                                    )
                                  })}
                                </div>
                                <button onClick={() => setShowDispatchedDatePopover(false)} style={{ marginTop: 10, width: '100%', padding: '6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12 }}>Done</button>
                              </div>
                            )}
                          </th>
                        )
                        return (
                        <th key={label || 'action'}
                          onClick={() => {
                            if (!col) return
                            if (dispatchedSortCol === col) setDispatchedSortDir(d => d === 'asc' ? 'desc' : 'asc')
                            else { setDispatchedSortCol(col); setDispatchedSortDir('asc') }
                          }}
                          style={{
                            padding: '9px 12px', textAlign: 'left' as const,
                            color: dispatchedSortCol === col ? 'var(--accent)' : 'var(--text3)',
                            fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500,
                            whiteSpace: 'nowrap' as const,
                            cursor: col ? 'pointer' : 'default',
                            userSelect: 'none' as const,
                          }}>
                          {label}
                          {col && dispatchedSortCol === col && <span style={{ marginLeft: 4 }}>{dispatchedSortDir === 'asc' ? '↑' : '↓'}</span>}
                          {col && dispatchedSortCol !== col && <span style={{ marginLeft: 4, opacity: 0.3 }}>↕</span>}
                        </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDispatched.length === 0 ? (
                      <tr><td colSpan={10} style={{ padding: 40, textAlign: 'center' as const, color: 'var(--text3)' }}>No dispatched orders yet</td></tr>
                    ) : filteredDispatched.map((order, i) => {
                      const cc = order.courier === 'Bluedart' ? '#2563eb' : '#7c3aed'
                      const dispDate = order.dispatched_at ? new Date(order.dispatched_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
                      return (
                        <tr key={order.id} style={{ borderBottom: i < filteredDispatched.length - 1 ? '1px solid var(--border)' : 'none', background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
                          <td style={{ padding: '9px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--dispatched)', whiteSpace: 'nowrap' as const }}>{dispDate}</td>
                          <td style={{ padding: '9px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{order.order_id.length > 18 ? order.order_id.slice(0, 18) + '…' : order.order_id}</td>
                          <td style={{ padding: '9px 12px', fontSize: 13, color: 'var(--text)', fontWeight: 500, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{order.customer_name}</td>
                          <td style={{ padding: '9px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text)' }}>{order.sku}</td>
                          <td style={{ padding: '9px 12px', fontFamily: 'DM Mono', fontSize: 11, color: order.scanned_barcode ? 'var(--text2)' : 'var(--text3)' }}>{order.scanned_barcode || '—'}</td>
                          <td style={{ padding: '9px 12px' }}>
                            <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: cc, background: order.courier === 'Bluedart' ? '#eff6ff' : '#f5f3ff', padding: '2px 7px', borderRadius: 4 }}>
                              {order.courier === 'Bluedart' ? 'BD' : 'DL'}
                            </span>
                          </td>
                          <td style={{ padding: '9px 12px' }}>
                            {order.tracking_number ? (
                              <a
                                href={order.courier === 'Bluedart'
                                  ? `https://www.bluedart.com/trackdartresultthirdparty?trackFor=0&trackNo=${order.tracking_number}`
                                  : `https://www.delhivery.com/track/package/${order.tracking_number}`
                                }
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{
                                  fontFamily: 'DM Mono', fontSize: 11,
                                  color: 'var(--dispatched)',
                                  background: 'var(--dispatched-bg)',
                                  padding: '2px 7px', borderRadius: 4,
                                  border: '1px solid #bbf7d0',
                                  textDecoration: 'none',
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                }}
                                onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                                onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                              >
                                {order.tracking_number}
                                <ExternalLink size={9} />
                              </a>
                            ) : (
                              <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>
                            )}
                          </td>
                          <td style={{ padding: '9px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{order.pincode}{order.city ? ` · ${order.city}` : ''}</td>
                          <td style={{ padding: '9px 12px', fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' as const }}>{order.promise_date ? new Date(order.promise_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}</td>
                          <td style={{ padding: '9px 12px' }}>
                            {order.tracking_number && (trackingData[order.tracking_number] || order.tracking_status) ? (() => {
                              const t = trackingData[order.tracking_number] || { status: order.tracking_status!, label: order.tracking_label || order.tracking_status!, lastUpdate: order.tracking_last_update || '' }
                              const colors: Record<string, { color: string; bg: string; border: string }> = {
                                delivered:   { color: 'var(--dispatched)', bg: 'var(--dispatched-bg)', border: '#bbf7d0' },
                                ofd:         { color: '#059669', bg: '#ecfdf5', border: '#6ee7b7' },
                                in_transit:  { color: 'var(--hold)', bg: 'var(--hold-bg)', border: '#bfdbfe' },
                                picked_up:   { color: 'var(--plan)', bg: 'var(--bg2)', border: 'var(--border)' },
                                ndr:         { color: 'var(--today)', bg: 'var(--today-bg)', border: '#fed7aa' },
                                rto:         { color: 'var(--critical)', bg: 'var(--critical-bg)', border: '#fecaca' },
                                booked:      { color: 'var(--text3)', bg: 'var(--bg2)', border: 'var(--border)' },
                                unknown:     { color: 'var(--text3)', bg: 'var(--bg2)', border: 'var(--border)' },
                              }
                              const c = colors[t.status] || colors.unknown
                              return (
                                <a
                                  href={order.courier === 'Bluedart'
                                    ? `https://www.bluedart.com/trackdartresultthirdparty?trackFor=0&trackNo=${order.tracking_number}`
                                    : `https://www.delhivery.com/track/package/${order.tracking_number}`}
                                  target="_blank" rel="noopener noreferrer"
                                  style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 4, border: `1px solid ${c.border}`, background: c.bg, color: c.color, fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap' as const }}
                                  onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                                  onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                                >
                                  {t.label} <ExternalLink size={9} />
                                </a>
                              )
                            })() : (
                              <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                                {order.tracking_number ? '—' : 'No AWB'}
                              </span>
                            )}
                          </td>
                          <td style={{ padding: '9px 12px' }}>
                            <button onClick={() => setHistoryOrder(order)} title="View history"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 2, display: 'flex', alignItems: 'center', borderRadius: 4, transition: 'color 0.15s' }}
                              onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
                              onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
                            >
                              <History size={13} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ════ EOD ════ */}
        {tab === 'eod' && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 24, maxWidth: 700 }}>
            <h1 style={{ fontSize: 18, fontWeight: 600 }}>End of Day — {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</h1>

            {/* Dispatch performance strip */}
            {(() => {
              const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]
              const dispatchedToday = orders.filter(o => o.is_dispatched && o.dispatched_at && o.dispatched_at.startsWith(today)).length
              const scheduledTodayTotal = dispatchedToday + dispatchTodayCount
              const dispatched7d = orders.filter(o => o.is_dispatched && o.dispatched_at && o.dispatched_at.slice(0, 10) >= sevenDaysAgo)
              // Avg days late: dispatched date minus scheduled date, only when both known and positive
              const lateDiffs = dispatched7d
                .filter(o => o.scheduled_date)
                .map(o => Math.round((new Date(o.dispatched_at!.slice(0, 10)).getTime() - new Date(o.scheduled_date!).getTime()) / 86400000))
              const avgLate = lateDiffs.length > 0 ? (lateDiffs.reduce((s, d) => s + d, 0) / lateDiffs.length) : null
              return (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' as const }}>
                  {[
                    { label: 'Dispatched today', value: scheduledTodayTotal > 0 ? `${dispatchedToday}/${scheduledTodayTotal}` : '—' },
                    { label: 'Last 7 days', value: `${dispatched7d.length} dispatched` },
                    { label: 'Avg delay (7d)', value: avgLate === null ? '—' : avgLate <= 0 ? 'on time' : `${avgLate.toFixed(1)}d late` },
                  ].map(s => (
                    <div key={s.label} style={{ display: 'flex', alignItems: 'baseline', gap: 7, padding: '7px 14px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 20 }}>
                      <span style={{ fontFamily: 'DM Mono', fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{s.value}</span>
                      <span style={{ fontSize: 11, color: 'var(--text3)' }}>{s.label}</span>
                    </div>
                  ))}
                </div>
              )
            })()}
            {eodDone ? (
              (() => {
                const dispatchedToday = orders.filter(o => o.is_dispatched && o.dispatched_at && o.dispatched_at.startsWith(today))
                const missedToday = orders.filter(o => o.plan_decision === 'scheduled' && o.scheduled_date === today && !o.is_cancelled && !o.is_dispatched)
                const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0]
                const tomorrowLabel = new Date(tomorrow + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
                return (
                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
                    {/* Reconciliation summary */}
                    <div style={{ ...card, padding: 28, border: missedToday.length > 0 ? '1px solid #fed7aa' : '1px solid #bbf7d0', background: missedToday.length > 0 ? '#fffbeb' : 'var(--dispatched-bg)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: missedToday.length > 0 ? 'var(--today)' : 'var(--dispatched)', marginBottom: 20 }}>
                        {missedToday.length > 0 ? <AlertCircle size={22} /> : <CheckCircle size={22} />}
                        <span style={{ fontWeight: 700, fontSize: 16 }}>
                          {missedToday.length > 0 ? `Batch confirmed — ${missedToday.length} still pending today` : 'All of today\'s orders dispatched'}
                        </span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
                        {[
                          { label: 'Scheduled Today', value: dispatchedToday.length + missedToday.length, color: 'var(--text)' },
                          { label: 'Dispatched', value: dispatchedToday.length, color: 'var(--dispatched)' },
                          { label: 'Missed', value: missedToday.length, color: missedToday.length > 0 ? '#dc2626' : 'var(--text3)' },
                        ].map(s => (
                          <div key={s.label} style={{ textAlign: 'center' as const }}>
                            <div style={{ fontSize: 32, fontFamily: 'DM Mono', fontWeight: 500, color: s.color }}>{s.value}</div>
                            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{s.label}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Missed orders list + reschedule */}
                    {missedToday.length > 0 && (
                      <div style={{ ...card, overflow: 'hidden' }}>
                        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Missed orders</span>
                          <button
                            onClick={async () => {
                              const ids = missedToday.map(o => o.id)
                              await supabase.from('dispatch_orders').update({ scheduled_date: tomorrow, updated_at: new Date().toISOString() }).in('id', ids)
                              for (const o of missedToday) {
                                logEvent(o.order_id, 'rescheduled', `Rescheduled to ${tomorrowLabel} (missed EOD)`)
                              }
                              setOrders(prev => prev.map(o => ids.includes(o.id) ? { ...o, scheduled_date: tomorrow } : o))
                            }}
                            style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
                          >
                            <Calendar size={12} /> Reschedule all to {tomorrowLabel}
                          </button>
                        </div>
                        {missedToday.map((o, i) => (
                          <div key={o.id} style={{ padding: '9px 20px', borderBottom: i < missedToday.length - 1 ? '1px solid var(--border)' : 'none', display: 'flex', gap: 12, alignItems: 'center', fontSize: 12, fontFamily: 'DM Mono' }}>
                            <span style={{ color: 'var(--text)', fontWeight: 500, minWidth: 140 }}>{o.customer_name}</span>
                            <span style={{ color: 'var(--text2)' }}>{o.sku}</span>
                            <span style={{ color: 'var(--text3)', marginLeft: 'auto' }}>{o.tracking_number || 'no AWB'}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Run another batch */}
                    <button onClick={() => { setEodDone(false); setShypassistText(''); setEodMatchResult(null) }}
                      style={{ alignSelf: 'flex-start', padding: '9px 18px', borderRadius: 7, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
                      <RefreshCw size={14} /> Process another batch
                    </button>
                  </div>
                )
              })()
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

                {/* ── Scan-out verification ── */}
                <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column' as const, gap: 16, border: '1px solid var(--accent)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <ScanLine size={16} style={{ color: 'var(--accent)' }} />
                    <span style={{ fontFamily: 'DM Mono', fontSize: 13, fontWeight: 600, color: 'var(--text)', letterSpacing: '0.05em' }}>SCAN-OUT VERIFICATION</span>
                    {currentBatch(scanCourier).length > 0 && (
                      <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--dispatched)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <CheckCircle size={13} /> {currentBatch(scanCourier).length} in this batch
                      </span>
                    )}
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0, lineHeight: 1.5 }}>
                    Pick the courier you&apos;re loading, scan the AWB on the box, then scan the item barcode. The item&apos;s barcode (Master SKU + piece number, e.g. <span style={{ fontFamily: 'DM Mono' }}>-1</span>) is checked against the order&apos;s mapped SKU before it&apos;s marked dispatched — catching mis-picks at the loading point.
                  </p>

                  {/* Courier selector with day counts */}
                  <div style={{ display: 'flex', gap: 12 }}>
                    {(['Bluedart', 'Delhivery'] as const).map(c => {
                      const stats = courierDayStats(c)
                      const isSel = scanCourier === c
                      const cc = c === 'Bluedart' ? '#2563eb' : '#7c3aed'
                      return (
                        <button key={c} onClick={() => { setScanCourier(c); resetScan() }} style={{
                          flex: 1, padding: '12px 16px', borderRadius: 8, cursor: 'pointer', textAlign: 'left' as const,
                          background: isSel ? (c === 'Bluedart' ? '#eff6ff' : '#f5f3ff') : 'var(--surface)',
                          border: `2px solid ${isSel ? cc : 'var(--border)'}`,
                          display: 'flex', flexDirection: 'column' as const, gap: 6,
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 9, height: 9, borderRadius: '50%', background: cc }} />
                            <span style={{ fontFamily: 'DM Mono', fontSize: 13, fontWeight: 700, color: isSel ? cc : 'var(--text)' }}>{c}</span>
                            {isSel && <span style={{ marginLeft: 'auto', fontSize: 10, color: cc, fontWeight: 600 }}>● loading</span>}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                            <span style={{ fontFamily: 'DM Mono', fontSize: 22, fontWeight: 700, color: isSel ? cc : 'var(--text)' }}>{stats.dispatched}<span style={{ fontSize: 14, color: 'var(--text3)', fontWeight: 500 }}> / {stats.planned}</span></span>
                            <span style={{ fontSize: 11, color: 'var(--text3)' }}>dispatched today</span>
                          </div>
                        </button>
                      )
                    })}
                  </div>

                  {!scanCourier ? (
                    <div style={{ padding: '14px 16px', background: 'var(--bg2)', border: '1px dashed var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text3)', textAlign: 'center' as const }}>
                      Select a courier above to start scanning.
                    </div>
                  ) : (
                  <>
                  {/* Step 1: AWB */}
                  <div>
                    <label style={{ display: 'block', fontSize: 11, color: 'var(--text2)', marginBottom: 6, fontWeight: 600, fontFamily: 'DM Mono' }}>1 · SCAN AWB <span style={{ color: 'var(--text3)', fontWeight: 400 }}>({scanCourier})</span></label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        ref={awbInputRef}
                        value={scanAwb}
                        onChange={e => setScanAwb(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleScanAwb(scanAwb) }}
                        placeholder="Scan or type AWB, press Enter…"
                        disabled={!!scanOrder}
                        autoFocus
                        style={{ flex: 1, padding: '11px 14px', borderRadius: 7, border: `1px solid ${scanOrder ? 'var(--border)' : 'var(--accent)'}`, background: scanOrder ? 'var(--bg2)' : 'var(--bg)', color: 'var(--text)', fontSize: 15, fontFamily: 'DM Mono', outline: 'none' }}
                      />
                      {(scanOrder || scanError) && (
                        <button onClick={resetScan} title="Clear and scan a new piece" style={{ flexShrink: 0, padding: '0 18px', borderRadius: 7, border: '1px solid var(--critical)', background: 'var(--critical-bg)', color: 'var(--critical)', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' as const }}>
                          <X size={15} /> Clear / New scan
                        </button>
                      )}
                    </div>
                  </div>

                  {scanError && (
                    <div style={{ padding: '10px 14px', background: 'var(--critical-bg)', border: '1px solid #fecaca', borderRadius: 7, color: 'var(--critical)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <AlertCircle size={15} style={{ flexShrink: 0 }} /> {scanError}
                    </div>
                  )}

                  {/* Step 2: order pulled + item scan */}
                  {scanOrder && (
                    <>
                      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7, padding: '12px 14px', display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{scanOrder.customer_name}</span>
                          <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: scanOrder.courier === 'Bluedart' ? '#2563eb' : '#7c3aed', background: scanOrder.courier === 'Bluedart' ? '#eff6ff' : '#f5f3ff', padding: '2px 7px', borderRadius: 4 }}>{scanOrder.courier === 'Bluedart' ? 'BD' : 'DL'}</span>
                        </div>
                        <div style={{ fontSize: 11, fontFamily: 'DM Mono', color: 'var(--text3)' }}>{scanOrder.order_id}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>Expected barcode SKU:</span>
                          <span style={{ fontFamily: 'DM Mono', fontSize: 13, fontWeight: 700, color: scanOrder.barcode_sku ? 'var(--accent)' : 'var(--critical)' }}>
                            {scanOrder.barcode_sku ? `${scanOrder.barcode_sku}-N` : 'NOT MAPPED'}
                          </span>
                        </div>
                      </div>

                      <div>
                        <label style={{ display: 'block', fontSize: 11, color: 'var(--text2)', marginBottom: 6, fontWeight: 600, fontFamily: 'DM Mono' }}>2 · SCAN ITEM BARCODE</label>
                        <input
                          ref={itemInputRef}
                          value={scanItem}
                          onChange={e => setScanItem(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleScanItem(scanItem) }}
                          placeholder="Scan the item barcode, press Enter…"
                          autoFocus
                          style={{ width: '100%', padding: '11px 14px', borderRadius: 7, border: '1px solid var(--accent)', background: 'var(--bg)', color: 'var(--text)', fontSize: 15, fontFamily: 'DM Mono', outline: 'none' }}
                        />
                      </div>
                    </>
                  )}

                  {/* Result block — only shown on a wrong-item mismatch (success is instant) */}
                  {scanResult && !scanResult.ok && (
                    <div style={{ padding: '16px 18px', background: 'var(--critical-bg)', border: '2px solid var(--critical)', borderRadius: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                        <AlertTriangle size={28} style={{ color: 'var(--critical)', flexShrink: 0 }} />
                        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--critical)' }}>WRONG ITEM — not dispatched</div>
                      </div>
                      <div style={{ display: 'flex', gap: 20, fontFamily: 'DM Mono', fontSize: 13, flexWrap: 'wrap' as const }}>
                        <div><span style={{ color: 'var(--text3)' }}>Expected: </span><span style={{ color: 'var(--dispatched)', fontWeight: 700 }}>{scanResult.expected}</span></div>
                        <div><span style={{ color: 'var(--text3)' }}>Scanned: </span><span style={{ color: 'var(--critical)', fontWeight: 700 }}>{scanResult.scanned}</span></div>
                      </div>
                      <button onClick={() => { setScanItem(''); setScanResult(null) }} style={{ marginTop: 12, padding: '7px 16px', borderRadius: 6, border: 'none', background: 'var(--critical)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Rescan item</button>
                    </div>
                  )}

                  {/* Live batch list — scanned & not yet manifested for this courier */}
                  {currentBatch(scanCourier).length > 0 && (
                    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' as const }}>
                      <div style={{ padding: '8px 14px', background: 'var(--bg2)', fontSize: 11, fontWeight: 600, fontFamily: 'DM Mono', color: 'var(--text2)', letterSpacing: '0.04em', display: 'flex', justifyContent: 'space-between' }}>
                        <span>THIS BATCH ({currentBatch(scanCourier).length})</span>
                        <span style={{ color: 'var(--text3)' }}>{scanCourier}</span>
                      </div>
                      <div style={{ maxHeight: 180, overflowY: 'auto' as const }}>
                        {currentBatch(scanCourier).slice(0, 40).map((s, i) => (
                          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', borderTop: i === 0 ? 'none' : '1px solid var(--border)', fontSize: 12 }}>
                            <CheckCircle size={13} style={{ color: 'var(--dispatched)', flexShrink: 0 }} />
                            <span style={{ fontFamily: 'DM Mono', color: 'var(--text2)' }}>{s.tracking_number}</span>
                            <span style={{ fontFamily: 'DM Mono', color: 'var(--text3)', marginLeft: 'auto' }}>{s.barcode_sku || s.sku}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Complete dispatch → manifest (this batch only) */}
                  {(() => {
                    const cc = scanCourier === 'Bluedart' ? '#2563eb' : '#7c3aed'
                    const n = currentBatch(scanCourier).length
                    return (
                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const }}>
                        <div style={{ fontSize: 13, color: 'var(--text2)' }}>
                          <strong style={{ color: cc, fontFamily: 'DM Mono' }}>{n}</strong> {scanCourier} piece{n !== 1 ? 's' : ''} in this batch
                        </div>
                        <button
                          onClick={() => generateManifest(scanCourier!)}
                          disabled={n === 0}
                          style={{
                            marginLeft: 'auto', padding: '9px 18px', borderRadius: 7, border: 'none',
                            background: n === 0 ? 'var(--bg2)' : 'var(--dispatched)',
                            color: n === 0 ? 'var(--text3)' : '#fff',
                            fontSize: 13, fontWeight: 600, cursor: n === 0 ? 'not-allowed' : 'pointer',
                            display: 'flex', alignItems: 'center', gap: 7,
                          }}
                        >
                          <Printer size={15} /> Complete Dispatch — Generate Manifest
                        </button>
                      </div>
                    )
                  })()}
                  </>
                  )}
                </div>

                {/* Fallback divider */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                  <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'DM Mono', letterSpacing: '0.05em' }}>OR USE PASTE FALLBACK</span>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                </div>

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

        {/* ════ SKU MAP ════ */}
        {tab === 'skumap' && access.can_users && (
          <SkuMapTab />
        )}

        {/* ════ USERS ════ */}
        {tab === 'users' && (
          <UsersTab ownerEmail={user.email!} />
        )}

        {tab === 'inventory' && access.can_warehouse && (
          <InventoryTab />
        )}
      </main>

      {/* History panel */}
      {historyOrder && (
        <OrderHistoryPanel
          order={historyOrder}
          currentUserEmail={user.email || ''}
          onClose={() => setHistoryOrder(null)}
        />
      )}
    </div>
  )
}

// ── Order Row ──
function OrderRow({ order, selected, updating, onSelect, onDecision, onSchedule, onPriority, onCancel, onHistory, onManualDispatch, onSaveCourier, editingAwbId, editingAwbValue, onEditAwb, onSaveAwb, onCancelAwb, daysLeftDisplay, liveUrgencyTier }: {
  order: DBOrder; selected: boolean; updating: boolean
  daysLeftDisplay: number | null
  liveUrgencyTier: UrgencyTier | null
  onSelect: (id: string) => void
  onDecision: (id: string, d: PlanDecision) => void
  onSchedule: (id: string, date: string) => void
  onPriority: (id: string, current: boolean) => void
  onCancel: (id: string) => void
  onHistory: (order: DBOrder) => void
  onManualDispatch: (order: DBOrder) => void
  onSaveCourier: (id: string, courier: Courier) => void
  editingAwbId: string | null
  editingAwbValue: string
  onEditAwb: (id: string, current: string) => void
  onSaveAwb: (id: string) => void
  onCancelAwb: () => void
}) {
  const uc = {
    CRITICAL: { color: 'var(--critical)', bg: 'var(--critical-bg)', border: '#fecaca' },
    TODAY:    { color: 'var(--today)',    bg: 'var(--today-bg)',    border: '#fed7aa' },
    PLAN:     { color: 'var(--plan)',     bg: 'var(--plan-bg)',     border: '#fde68a' },
    HOLD:     { color: 'var(--hold)',     bg: 'var(--hold-bg)',     border: '#bfdbfe' },
  }[liveUrgencyTier as string] || { color: 'var(--text3)', bg: 'var(--bg2)', border: 'var(--border)' }

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
        <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontFamily: 'DM Mono', fontWeight: 500, letterSpacing: '0.05em', color: uc.color, background: uc.bg, border: `1px solid ${uc.border}` }}>{liveUrgencyTier || '—'}</span>
      </td>
      <td style={{ padding: '8px 12px' }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2 }}>
          <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{order.order_id.length > 20 ? order.order_id.slice(0, 20) + '…' : order.order_id}</span>
          {order.plan_decision === 'undecided' && (() => {
            const ageDays = Math.floor((Date.now() - new Date(order.created_at).getTime()) / 86400000)
            if (ageDays < 1) return null
            return (
              <span style={{
                fontSize: 9, fontFamily: 'DM Mono', fontWeight: 600,
                color: ageDays >= 3 ? '#dc2626' : ageDays >= 2 ? '#d97706' : 'var(--text3)',
                background: ageDays >= 3 ? '#fef2f2' : ageDays >= 2 ? '#fffbeb' : 'var(--bg2)',
                padding: '1px 5px', borderRadius: 3, alignSelf: 'flex-start',
              }}>
                {ageDays}d undecided
              </span>
            )
          })()}
        </div>
      </td>
      <td style={{ padding: '8px 12px', maxWidth: 160 }}><span style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', maxWidth: 150 }}>{order.customer_name}</span></td>
      <td style={{ padding: '8px 12px' }}><span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text)', background: 'var(--bg2)', padding: '2px 6px', borderRadius: 4 }}>{order.sku}</span></td>
      <td style={{ padding: '8px 12px' }}>
        <select
          value={order.courier}
          onChange={e => onSaveCourier(order.id, e.target.value as Courier)}
          style={{
            fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600,
            color: order.courier === 'Bluedart' ? '#2563eb' : '#7c3aed',
            background: order.courier === 'Bluedart' ? '#eff6ff' : '#f5f3ff',
            border: `1px solid ${order.courier === 'Bluedart' ? '#bfdbfe' : '#e9d5ff'}`,
            borderRadius: 4, padding: '2px 4px', cursor: 'pointer', outline: 'none',
          }}
        >
          <option value="Bluedart">BD</option>
          <option value="Delhivery">DL</option>
        </select>
      </td>
      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text)' }}>{order.pincode}</span>
        {order.city && <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 6 }}>{order.city}</span>}
      </td>
      <td style={{ padding: '8px 12px' }}>{order.oda === 'ODA' && <span style={{ fontSize: 10, fontFamily: 'DM Mono', color: 'var(--today)', background: 'var(--today-bg)', padding: '1px 5px', borderRadius: 3, border: '1px solid #fed7aa' }}>ODA</span>}</td>
      <td style={{ padding: '6px 12px' }}>
        {editingAwbId === order.id ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              autoFocus
              value={editingAwbValue}
              onChange={e => onEditAwb(order.id, e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') onSaveAwb(order.id); if (e.key === 'Escape') onCancelAwb() }}
              style={{ width: 130, padding: '3px 7px', borderRadius: 5, border: '1px solid var(--accent)', background: 'var(--bg)', color: 'var(--text)', fontSize: 11, fontFamily: 'DM Mono', outline: 'none' }}
            />
            <button onClick={() => onSaveAwb(order.id)} style={{ background: 'var(--dispatched)', border: 'none', borderRadius: 4, cursor: 'pointer', color: '#fff', fontSize: 10, padding: '3px 7px', fontWeight: 600 }}>✓</button>
            <button onClick={onCancelAwb} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: 'var(--text3)', fontSize: 10, padding: '3px 6px' }}>✕</button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {order.tracking_number
              ? <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--dispatched)', background: 'var(--dispatched-bg)', padding: '2px 6px', borderRadius: 4, border: '1px solid #bbf7d0' }}>{order.tracking_number}</span>
              : <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>—</span>
            }
            <button
              onClick={() => onEditAwb(order.id, order.tracking_number || '')}
              title="Edit tracking number"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 2, opacity: 0.5, display: 'flex', alignItems: 'center' }}
              onMouseEnter={e => e.currentTarget.style.opacity = '1'}
              onMouseLeave={e => e.currentTarget.style.opacity = '0.5'}
            >
              <Pencil size={10} />
            </button>
          </div>
        )}
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'center' as const }}><span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text3)' }}>{order.transit_days}d</span></td>
      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}><span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text2)' }}>{order.promise_date ? new Date(order.promise_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}</span></td>
      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}><span style={{ fontFamily: 'DM Mono', fontSize: 12, color: order.dispatch_by_date ? 'var(--today)' : 'var(--text3)' }}>{order.dispatch_by_date ? new Date(order.dispatch_by_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}</span></td>
      <td style={{ padding: '8px 12px', textAlign: 'center' as const }}><span style={{ fontFamily: 'DM Mono', fontSize: 14, fontWeight: 600, color: uc.color }}>{daysLeftDisplay !== null ? daysLeftDisplay : '—'}</span></td>
      <td style={{ padding: '6px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'nowrap' as const }}>
          {/* Manual dispatch button */}
          <button onClick={() => onManualDispatch(order)} style={{
            padding: '4px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
            fontFamily: 'DM Sans', fontWeight: 600,
            background: 'var(--dispatched-bg)',
            border: '1px solid #bbf7d0',
            color: 'var(--dispatched)',
            whiteSpace: 'nowrap' as const,
            display: 'flex', alignItems: 'center', gap: 3,
          }}>
            <CheckCircle size={11} /> Dispatch
          </button>
          {/* Date picker — sets scheduled */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
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
                style={{ flexShrink: 0, width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: 'var(--text3)', fontSize: 11, lineHeight: 1 }}
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
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => onCancel(order.id)} title="Cancel order" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 2, display: 'flex', alignItems: 'center', borderRadius: 4, transition: 'color 0.15s' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--critical)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
          >
            <Ban size={13} />
          </button>
          <button onClick={() => onHistory(order)} title="View history" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 2, display: 'flex', alignItems: 'center', borderRadius: 4, transition: 'color 0.15s' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
          >
            <History size={13} />
          </button>
        </div>
      </td>
    </tr>
  )
}
