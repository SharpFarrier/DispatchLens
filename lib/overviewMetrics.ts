// Shared types + pure helpers for the Owner Overview.
// The heavy counts come from SQL RPCs (see overview-migration.sql); this module
// holds the payload contract, IST helpers, and light derivations that both the
// API route and the client use, so numbers are defined in exactly one place.

export type OvRange = 'today' | '7d' | '30d'

export interface OvStage {
  step: string
  name: string
  count: number | null
  today: string
  tab: string            // sidebar key to link to
  flag?: boolean         // red "Data gap" pill
}

export interface OvIssue {
  sev: 'Critical' | 'Today' | 'Watch' | 'Info'
  tone: 'red' | 'amb' | 'grn' | 'neu'
  title: string
  sub: string
  tab: string
  count: number          // used only to hide zero-count rows
}

export interface OvShortfallRow { sku: string; product: string; needed: number; inStock: number; toPack: number }
export interface OvSnapshotDay {
  snap_date: string
  inward_today: number; coated_today: number; packed_today: number; dispatched_today: number
}

export interface OverviewPayload {
  generatedAt: string          // ISO
  range: OvRange
  istDate: string              // YYYY-MM-DD (IST)
  dispatch: {
    dispatchedToday: number
    goingToday: number
    couriers: { name: string; dispatched: number; planned: number }[]
    critical: number
    undecided: number
    pickedNotDispatched: number
    onHold: number
    slipped: number
    unmapped: number
  }
  pipeline: OvStage[]
  issues: OvIssue[]
  shortfall: { pcs: number; skus: number; rows: OvShortfallRow[] }
  production: {
    inwardToday: number; inwardBySupplier: Record<string, number>
    coatedToday: number; coatedByShape: Record<string, number>
    pickedToday: number; pickedByShape: Record<string, number>
  }
  chart: OvSnapshotDay[]        // last 14 days from ops_daily_snapshot
  afterShip: {
    shipped: number
    buckets: { label: string; count: number; color: string }[]   // in transit / delivered / unknown / other
    otdr: number | null
    delayed: number
    delayedOldestDays: number | null
    remindersSent: number
    refundsPendingAmt: number
    refundsPendingCnt: number
  }
  team: {
    picksByPicker: { name: string; count: number }[]
    callsToday: number
    dispatchScansToday: number
    packedStock: number
    packedStockSkus: number
    packedLowSkus: number
    packedAwaitingStockIn: number
  }
  notes: { trackingUnknownPct: number | null }
}

// ── IST helpers (Asia/Kolkata, UTC+5:30, no DST) ───────────────────────────
export function istDateString(now: Date = new Date()): string {
  // shift to IST then take the calendar date
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000)
  return ist.toISOString().slice(0, 10)
}
export function istDayStartUtcISO(now: Date = new Date()): string {
  const d = istDateString(now)
  // IST midnight expressed in UTC = date 00:00 IST = previous 18:30 UTC
  return new Date(`${d}T00:00:00+05:30`).toISOString()
}
// Range window start (UTC ISO) for 'today' | '7d' | '30d', aligned to IST midnight.
export function rangeStartUtcISO(range: OvRange, now: Date = new Date()): string {
  const days = range === 'today' ? 0 : range === '7d' ? 6 : 29
  const startIst = new Date(`${istDateString(now)}T00:00:00+05:30`)
  startIst.setDate(startIst.getDate() - days)
  return startIst.toISOString()
}

// ── Tracking-status buckets (pairs with lib/tracking.ts vocabulary) ────────
// in_transit/booked/picked_up/ofd → "In transit"; delivered → "Delivered";
// unknown/null → "Unknown"; rto/ndr/lost/undelivered → "Other".
export function trackingBucket(status: string | null | undefined): 'in_transit' | 'delivered' | 'unknown' | 'other' {
  const s = (status || '').toLowerCase()
  if (s === 'delivered') return 'delivered'
  if (['in_transit', 'booked', 'picked_up', 'ofd', 'out_for_delivery', 'pickup_scheduled', 'manifested'].includes(s)) return 'in_transit'
  if (s === '' || s === 'unknown' || s === '__none' || s === 'none') return 'unknown'
  return 'other'
}

// ── Build the ranked "Needs you" list from counts; zero-count rows dropped ──
export function buildIssues(p: {
  critical: number; shortfallPcs: number; shortfallSkus: number; shortfallTop: string
  delayed: number; delayedOldest: number | null; remindersSent: number
  undecided: number; pickedNotDispatched: number; packedLowSkus: number
  trackingUnknown: number; trackingUnknownPct: number | null
  returnsUnmapped: number; refundsPendingCnt: number; refundsPendingAmt: number
  handlingPending: number; inventoryIssues: number; unfulfillable: number
}): OvIssue[] {
  const rows: OvIssue[] = [
    { sev: 'Critical', tone: 'red', title: `${p.critical} orders at or past dispatch-by`, sub: 'Plan › Critical bucket', tab: 'plan', count: p.critical },
    { sev: 'Critical', tone: 'red', title: `${p.shortfallSkus} SKUs short for today (${p.shortfallPcs} pcs)`, sub: p.shortfallTop || 'Picking › today shortfall', tab: 'picklist', count: p.shortfallPcs },
    { sev: 'Critical', tone: 'red', title: `${p.delayed} delayed shipments, ${p.remindersSent} reminders sent`, sub: p.delayedOldest != null ? `Oldest ${p.delayedOldest} days` : 'Delays queue', tab: 'delays', count: p.delayed },
    { sev: 'Today', tone: 'amb', title: `${p.undecided} orders still undecided`, sub: 'EOD is blocked until Plan is done', tab: 'plan', count: p.undecided },
    { sev: 'Today', tone: 'amb', title: `${p.pickedNotDispatched} picked pieces not dispatched`, sub: 'Return unused picks to stock', tab: 'eod', count: p.pickedNotDispatched },
    { sev: 'Watch', tone: 'amb', title: `${p.packedLowSkus} SKUs low on packed stock`, sub: 'Below cover target', tab: 'wh:packing', count: p.packedLowSkus },
    { sev: 'Watch', tone: 'amb', title: `${p.trackingUnknown} shipments with Unknown tracking`, sub: p.trackingUnknownPct != null ? `${p.trackingUnknownPct}% of last 7 days` : 'Last 7 days', tab: 'dispatched', count: p.trackingUnknown },
    { sev: 'Watch', tone: 'amb', title: `${p.returnsUnmapped} returns received, not mapped`, sub: 'Need the forward AWB', tab: 'returns', count: p.returnsUnmapped },
    { sev: 'Info', tone: 'neu', title: `${p.refundsPendingCnt} refunds pending · ₹${p.refundsPendingAmt.toLocaleString('en-IN')}`, sub: 'Returns › refunds', tab: 'returns', count: p.refundsPendingCnt },
    { sev: 'Info', tone: 'neu', title: `${p.handlingPending} handling-time requests`, sub: 'Awaiting review', tab: 'handling', count: p.handlingPending },
    { sev: 'Info', tone: 'neu', title: `${p.inventoryIssues} inventory items need attention`, sub: 'Negative raw / coated left', tab: 'wh:inventory', count: p.inventoryIssues },
    { sev: 'Info', tone: 'neu', title: `${p.unfulfillable} SKUs flagged unfulfillable`, sub: 'Plan › unfulfillable', tab: 'plan', count: p.unfulfillable },
  ]
  return rows.filter(r => r.count > 0)
}

export function topN(rec: Record<string, number>, n: number): string {
  return Object.entries(rec).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(' · ')
}
