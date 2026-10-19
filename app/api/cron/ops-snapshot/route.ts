import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { istDateString, istDayStartUtcISO, rangeStartUtcISO, trackingBucket } from '@/lib/overviewMetrics'

export const dynamic = 'force-dynamic'

// Daily snapshot writer — scheduled by Vercel cron at 23:55 IST (18:25 UTC).
// Writes one ops_daily_snapshot row for today (IST). Uses the service-role key so
// it can write regardless of RLS. The 14-day chart reads only from this table.

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (secret) return req.headers.get('authorization') === `Bearer ${secret}`
  return req.headers.get('x-vercel-cron') != null   // Vercel cron infra header
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const now = new Date()
  const snapDate = istDateString(now)
  const istStart = istDayStartUtcISO(now)
  const win7 = rangeStartUtcISO('7d', now)
  const rpc = (fn: string, args?: Record<string, unknown>) => admin.rpc(fn, args as never)

  const [oc, pc, kc, rf, prod, low, ship, delayed, returnsPending] = await Promise.all([
    rpc('ov_order_counts'), rpc('ov_piece_counts'), rpc('ov_packed_counts'),
    rpc('ov_raw_frames'), rpc('ov_production_today'), rpc('ov_low_packed_skus', { p_threshold: 5 }),
    admin.from('dispatch_orders').select('tracking_status').eq('is_dispatched', true).eq('is_cancelled', false).gte('dispatched_at', win7),
    admin.from('dispatch_orders').select('order_id', { count: 'exact', head: true })
      .eq('is_dispatched', true).eq('is_cancelled', false)
      .not('tracking_status', 'in', '("delivered","rto","returned")')
      .lte('dispatched_at', (() => { const d = new Date(`${snapDate}T00:00:00+05:30`); d.setDate(d.getDate() - 7); return d.toISOString() })()),
    admin.from('returns').select('refund_amount').eq('refund_status', 'pending'),
  ])

  const o = (oc.data || {}) as Record<string, unknown>
  const p = (pc.data || {}) as Record<string, unknown>
  const k = (kc.data || {}) as Record<string, unknown>
  const r = (rf.data || {}) as Record<string, unknown>
  const pr = (prod.data || {}) as Record<string, unknown>
  const shipRows = (ship.data || []) as { tracking_status: string | null }[]
  let delivered = 0, unknown = 0
  for (const row of shipRows) { const b = trackingBucket(row.tracking_status); if (b === 'delivered') delivered++; else if (b === 'unknown') unknown++ }
  const refRows = (returnsPending.data || []) as { refund_amount: number | null }[]

  const dispatchedToday = num(o.dispatched_today)
  const roww = {
    snap_date: snapDate,
    dispatched: dispatchedToday,
    going: dispatchedToday + num(o.scheduled_today_todo),
    critical: num(o.critical),
    undecided: num(o.undecided),
    picked_not_dispatched: num(k.picked_on_floor),
    on_hold: num(o.on_hold),
    raw_frames: num(r.raw_frames),
    coated: num(p.coated),
    picked: num(p.picked),
    packed_stock: num(k.stocked),
    scheduled: num(o.scheduled_total),
    delivered_7d: delivered,
    inward_today: num(pr.inward_total),
    coated_today: num(p.coated_today),
    picked_today: num(p.picked_today),
    packed_today: num(k.packed_today),
    dispatched_today: dispatchedToday,
    delayed: num(delayed.count),
    refunds_pending_cnt: refRows.length,
    refunds_pending_amt: refRows.reduce((s, x) => s + (x.refund_amount || 0), 0),
    otdr: null,
    packed_low_skus: num(low.data),
    unknown_tracking: unknown,
  }

  const { error } = await admin.from('ops_daily_snapshot').upsert(roww, { onConflict: 'snap_date' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, snap_date: snapDate })
}
