// Pure helpers for the Price Master "apply a sheet column across a date window" feature.
// Given a SKU's existing dated price rows and a new [from, to] window that will carry the
// column's price, work out how the EXISTING rows must change so the window is clean
// (bauFor picks the latest effective_from among covering rows, so overlaps must be removed).
// The caller inserts the era row itself (with the sheet price); this only adjusts neighbours.

export const prevDay = (iso: string) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10) }
export const nextDay = (iso: string) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) }

export interface DRow { id: string; price: number; from: string; to: string | null }
export interface Plan {
  deleteIds: string[]
  updates: { id: string; from: string; to: string | null }[]
  inserts: { price: number; from: string; to: string | null }[]   // split continuations (keep original price)
}

const INF = '9999-12-31'

// to === null means an open (current) window with no end.
export function planWindowOverwrite(existing: DRow[], from: string, to: string | null): Plan {
  const deleteIds: string[] = []
  const updates: Plan['updates'] = []
  const inserts: Plan['inserts'] = []
  const wToEff = to ?? INF
  for (const r of existing) {
    const rtEff = r.to ?? INF
    const overlaps = r.from <= wToEff && rtEff >= from
    if (!overlaps) continue
    const leftPart = r.from < from                               // keep a slice before the window
    const rightPart = to !== null && (r.to === null || r.to > to) // keep a slice after the window
    if (leftPart && rightPart) {
      updates.push({ id: r.id, from: r.from, to: prevDay(from) })
      inserts.push({ price: r.price, from: nextDay(to as string), to: r.to })
    } else if (leftPart) {
      updates.push({ id: r.id, from: r.from, to: prevDay(from) })
    } else if (rightPart) {
      updates.push({ id: r.id, from: nextDay(to as string), to: r.to })
    } else {
      deleteIds.push(r.id)
    }
  }
  return { deleteIds, updates, inserts }
}
