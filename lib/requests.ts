// Shared types + pure helpers for the in-app feature-request tracker.
// Everyone on DispatchLens can file a request against the tab they're on;
// owners (can_owner) triage them and clear them in a batch.

export type ReqStatus = 'open' | 'in_progress' | 'done'
export type ReqPriority = 'low' | 'med' | 'high'

export interface FeatureRequest {
  id: string
  tab_key: string
  tab_label: string
  title: string
  details: string | null
  priority: ReqPriority
  status: ReqStatus
  screenshots: string[]        // storage object paths (private bucket)
  screenshot_urls?: string[]   // signed URLs, filled in by the GET route
  created_by: string
  created_by_name: string | null
  created_at: string
  updated_at: string
  resolved_at: string | null
  resolved_by: string | null
}

export const STATUS_LABEL: Record<ReqStatus, string> = {
  open: 'Open', in_progress: 'In progress', done: 'Done',
}
export const PRIORITY_LABEL: Record<ReqPriority, string> = {
  low: 'Low', med: 'Medium', high: 'High',
}
// High first inside a group; done last when sorting by status.
export const PRIORITY_RANK: Record<ReqPriority, number> = { high: 0, med: 1, low: 2 }
export const STATUS_RANK: Record<ReqStatus, number> = { open: 0, in_progress: 1, done: 2 }

export const isStatus = (v: unknown): v is ReqStatus =>
  v === 'open' || v === 'in_progress' || v === 'done'
export const isPriority = (v: unknown): v is ReqPriority =>
  v === 'low' || v === 'med' || v === 'high'

// Single-click status cycle for the owner: open -> in progress -> done -> open.
export function nextStatus(s: ReqStatus): ReqStatus {
  return s === 'open' ? 'in_progress' : s === 'in_progress' ? 'done' : 'open'
}

// "19 Oct, 3:45 pm" in IST — the warehouse runs on IST everywhere.
export function istDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const diff = now.getTime() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return `${Math.floor(d / 7)}w ago`
}

// CSV for the owner's "export the current list" button. RFC-4180 quoting.
export function requestsToCsv(rows: FeatureRequest[]): string {
  const head = ['Status', 'Priority', 'Tab', 'Request', 'Details', 'Submitted by', 'Created (IST)', 'Resolved (IST)']
  const esc = (v: string | null | undefined) => {
    const s = (v ?? '').toString()
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = rows.map(r => [
    STATUS_LABEL[r.status], PRIORITY_LABEL[r.priority], r.tab_label, r.title,
    r.details || '', r.created_by_name || r.created_by, istDateTime(r.created_at),
    r.resolved_at ? istDateTime(r.resolved_at) : '',
  ].map(esc).join(','))
  return [head.join(','), ...lines].join('\n')
}
