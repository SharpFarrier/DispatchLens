import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  OverviewPayload, OvRange, istDateString, istDayStartUtcISO, rangeStartUtcISO,
  trackingBucket, buildIssues, OvShortfallRow,
} from '@/lib/overviewMetrics'

export const dynamic = 'force-dynamic'

type J = Record<string, unknown>
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)
const rec = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {}
  if (v && typeof v === 'object') for (const [k, val] of Object.entries(v as J)) out[k] = num(val)
  return out
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Gate: owner-overview permission.
  const { data: access } = await supabase
    .from('dispatch_user_access').select('can_owner, status').eq('email', user.email!).single()
  if (!access || access.status !== 'approved' || !access.can_owner) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const url = new URL(request.url)
  const range = (['today', '7d', '30d'].includes(url.searchParams.get('range') || '') ? url.searchParams.get('range') : 'today') as OvRange

  const now = new Date()
  const istStart = istDayStartUtcISO(now)            // IST midnight today (UTC ISO)
  const win7 = rangeStartUtcISO('7d', now)           // after-ship window is always 7d
  const delayCutoffIso = (() => { const d = new Date(`${istDateString(now)}T00:00:00+05:30`); d.setDate(d.getDate() - 7); return d.toISOString() })()

  const rpc = (fn: string, args?: J) => supabase.rpc(fn, args as never)

  const [
    orderC, pieceC, packedC, rawF, prod, lowSkus, shortfall,
    returnsPending, returnsUnmapped, handlingPending, unfulfillable, callsToday,
    shipWindow, delayed, delayRows, snapshot, picksToday, pickSessionsToday,
  ] = await Promise.all([
    rpc('ov_order_counts'),
    rpc('ov_piece_counts'),
    rpc('ov_packed_counts'),
    rpc('ov_raw_frames'),
    rpc('ov_production_today'),
    rpc('ov_low_packed_skus', { p_threshold: 5 }),
    rpc('ov_today_shortfall'),
    supabase.from('returns').select('refund_amount').eq('refund_status', 'pending'),
    supabase.from('returns').select('id', { count: 'exact', head: true }).is('order_id', null),
    supabase.from('handling_change_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('sku_unfulfillable').select('sku', { count: 'exact', head: true }).eq('active', true),
    supabase.from('call_logs').select('id', { count: 'exact', head: true }).gte('created_at', istStart),
    supabase.from('dispatch_orders').select('tracking_status').eq('is_dispatched', true).eq('is_cancelled', false).gte('dispatched_at', win7),
    supabase.from('dispatch_orders').select('order_id, dispatched_at, order_date')
      .eq('is_dispatched', true).eq('is_cancelled', false)
      .not('tracking_status', 'in', '("delivered","rto","returned")')
      .lte('dispatched_at', delayCutoffIso),
    supabase.from('order_delays').select('order_id, reminder_count'),
    supabase.from('ops_daily_snapshot').select('snap_date, inward_today, coated_today, packed_today, dispatched_today').order('snap_date', { ascending: true }).limit(14),
    supabase.from('pieces').select('pick_session_id').eq('status', 'picked').gte('picked_at', istStart),
    supabase.from('pick_sessions').select('id, created_by').gte('created_at', istStart),
  ])

  const oc = (orderC.data || {}) as J
  const pc = (pieceC.data || {}) as J
  const kc = (packedC.data || {}) as J
  const rf = (rawF.data || {}) as J
  const pr = (prod.data || {}) as J
  const sf = (shortfall.data || {}) as J

  // After-ship buckets over 7d.
  const shipRows = (shipWindow.data || []) as { tracking_status: string | null }[]
  const bucketCounts = { in_transit: 0, delivered: 0, unknown: 0, other: 0 }
  for (const r of shipRows) bucketCounts[trackingBucket(r.tracking_status)]++
  const shipped = shipRows.length
  const unknownPct = shipped ? Math.round((bucketCounts.unknown / shipped) * 1000) / 10 : null

  // Delays: count + oldest aging + reminders sent (over the delayed set).
  const dRows = (delayed.data || []) as { order_id: string; dispatched_at: string | null; order_date: string | null }[]
  const delayCount = dRows.length
  const todayIst = new Date(`${istDateString(now)}T00:00:00+05:30`).getTime()
  let oldest = 0
  for (const r of dRows) {
    const base = r.dispatched_at || r.order_date
    if (!base) continue
    const age = Math.floor((todayIst - new Date(base).getTime()) / 86400000)
    if (age > oldest) oldest = age
  }
  const delayedIds = new Set(dRows.map(r => r.order_id))
  const remMap = (delayRows.data || []) as { order_id: string; reminder_count: number }[]
  const remindersSent = remMap.filter(r => delayedIds.has(r.order_id)).reduce((s, r) => s + (r.reminder_count || 0), 0)

  // Refunds pending ₹.
  const refRows = (returnsPending.data || []) as { refund_amount: number | null }[]
  const refundsPendingAmt = refRows.reduce((s, r) => s + (r.refund_amount || 0), 0)
  const refundsPendingCnt = refRows.length

  // Team: picks per picker today.
  const sess = new Map<string, string>()
  for (const s of (pickSessionsToday.data || []) as { id: string; created_by: string | null }[]) sess.set(s.id, s.created_by || '—')
  const pickerCounts: Record<string, number> = {}
  for (const p of (picksToday.data || []) as { pick_session_id: string | null }[]) {
    const who = (p.pick_session_id && sess.get(p.pick_session_id)) || '—'
    pickerCounts[who] = (pickerCounts[who] || 0) + 1
  }
  const picksByPicker = Object.entries(pickerCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))

  const shortfallRows = ((sf.rows as OvShortfallRow[]) || [])

  const dispatchedToday = num(oc.dispatched_today)
  const goingToday = dispatchedToday + num(oc.scheduled_today_todo)
  const critical = num(oc.critical)
  const undecided = num(oc.undecided)
  const pickedNotDispatched = num(kc.picked_on_floor)
  const onHold = num(oc.on_hold)
  const unfulfillableCnt = num(unfulfillable.count)
  const lowPacked = num(lowSkus.data)

  const payload: OverviewPayload = {
    generatedAt: now.toISOString(),
    range,
    istDate: istDateString(now),
    dispatch: {
      dispatchedToday, goingToday,
      couriers: [
        { name: 'BlueDart', dispatched: num(oc.bluedart_dispatched), planned: num(oc.bluedart_planned) },
        { name: 'Delhivery', dispatched: num(oc.delhivery_dispatched), planned: num(oc.delhivery_planned) },
      ],
      critical, undecided, pickedNotDispatched, onHold,
      slipped: num(oc.slipped), unmapped: num(oc.unmapped),
    },
    pipeline: [
      { step: '1 · Stock', name: 'Raw frames', count: num(rf.raw_frames), today: `+${num(pr.inward_total)} inward today`, tab: 'wh:stock' },
      { step: '2 · Coating', name: 'Coated', count: num(pc.coated), today: `+${num(pc.coated_today)} coated today`, tab: 'wh:coating' },
      { step: '3 · Picking', name: 'Picked', count: null, today: `${num(pc.picked_today)} picked today`, tab: 'wh:picking', flag: true },
      { step: '4 · Packing', name: 'Packed stock', count: num(kc.stocked), today: `${num(kc.awaiting_stockin)} awaiting stock-in`, tab: 'wh:packing' },
      { step: '5 · Plan', name: 'Scheduled', count: num(oc.scheduled_total), today: `${undecided} undecided`, tab: 'plan' },
      { step: '6 · EOD', name: 'Dispatched', count: dispatchedToday, today: `${shipped} in last 7 days`, tab: 'eod' },
      { step: '7 · Tracking', name: 'Delivered', count: bucketCounts.delivered, today: 'last 7 days', tab: 'dispatched' },
    ],
    issues: buildIssues({
      critical, shortfallPcs: num(sf.pcs), shortfallSkus: num(sf.skus),
      shortfallTop: shortfallRows[0] ? `${shortfallRows[0].product || shortfallRows[0].sku} needs ${shortfallRows[0].toPack} more` : '',
      delayed: delayCount, delayedOldest: delayCount ? oldest : null, remindersSent,
      undecided, pickedNotDispatched, packedLowSkus: lowPacked,
      trackingUnknown: bucketCounts.unknown, trackingUnknownPct: unknownPct,
      returnsUnmapped: num(returnsUnmapped.count), refundsPendingCnt, refundsPendingAmt,
      handlingPending: num(handlingPending.count), inventoryIssues: 0, unfulfillable: unfulfillableCnt,
    }),
    shortfall: { pcs: num(sf.pcs), skus: num(sf.skus), rows: shortfallRows },
    production: {
      inwardToday: num(pr.inward_total), inwardBySupplier: rec(pr.inward_by_supplier),
      coatedToday: num(pc.coated_today), coatedByShape: rec(pr.coated_by_shape),
      pickedToday: num(pc.picked_today), pickedByShape: rec(pr.picked_by_shape),
    },
    chart: (snapshot.data || []) as OverviewPayload['chart'],
    afterShip: {
      shipped,
      buckets: [
        { label: 'In transit', count: bucketCounts.in_transit, color: '#5E5A53' },
        { label: 'Delivered', count: bucketCounts.delivered, color: '#15803D' },
        { label: 'Unknown', count: bucketCounts.unknown, color: '#D97706' },
        { label: 'Other', count: bucketCounts.other, color: '#B42318' },
      ],
      otdr: null, // v1: OTDR-tab forecast extraction pending
      delayed: delayCount, delayedOldestDays: delayCount ? oldest : null, remindersSent,
      refundsPendingAmt, refundsPendingCnt,
    },
    team: {
      picksByPicker, callsToday: num(callsToday.count), dispatchScansToday: num(oc.scans_today),
      packedStock: num(kc.stocked), packedStockSkus: num(kc.distinct_stocked_skus),
      packedLowSkus: lowPacked, packedAwaitingStockIn: num(kc.awaiting_stockin),
    },
    notes: { trackingUnknownPct: unknownPct },
  }

  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
