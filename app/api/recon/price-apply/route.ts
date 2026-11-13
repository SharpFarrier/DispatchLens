import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { fetchSheetHeaders, fetchSheetColumnPrices, normSku } from '@/lib/masterSheet'
import { planWindowOverwrite, prevDay, nextDay, type DRow } from '@/lib/priceWindow'

// Apply a chosen master-sheet price column across a [from, to] effective window: snapshot
// that column's price per SKU into the dated recon_prices history, OVERWRITING (trim/split/
// delete) any existing rows that overlap the window so bauFor resolves cleanly. GET lists the
// sheet's columns for the picker. POST { column, from, to, dryRun } previews or applies.

export const dynamic = 'force-dynamic'

function adminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}
async function requireUser() {
  const sb = await createServerClient()
  const { data: { user } } = await sb.auth.getUser()
  return user
}
const chunk = <T,>(a: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o }

export async function GET() {
  if (!(await requireUser())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try { return NextResponse.json({ columns: await fetchSheetHeaders() }) }
  catch (e) { return NextResponse.json({ error: (e as Error).message, columns: [] }, { status: 502 }) }
}

export async function POST(req: Request) {
  if (!(await requireUser())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body: { column?: string; from?: string; to?: string | null; dryRun?: boolean }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }) }
  const column = (body.column || '').trim()
  const from = (body.from || '').trim()
  const to = body.to ? String(body.to).trim() : null
  const dryRun = !!body.dryRun
  if (!column) return NextResponse.json({ error: 'column required' }, { status: 400 })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return NextResponse.json({ error: 'from must be YYYY-MM-DD' }, { status: 400 })
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) return NextResponse.json({ error: 'to must be YYYY-MM-DD' }, { status: 400 })
  if (to && to < from) return NextResponse.json({ error: 'to is before from' }, { status: 400 })

  try {
    const db = adminClient()
    const prices = await fetchSheetColumnPrices(column)           // normSku -> price
    const keys = Object.keys(prices)
    if (!keys.length) return NextResponse.json({ error: `No priced SKUs in column "${column}"` }, { status: 400 })

    // Existing dated rows, grouped by normalised sku.
    const { data: existingRows, error } = await db.from('recon_prices').select('id, sku, price, effective_from, effective_to')
    if (error) throw new Error(error.message)
    const bySku = new Map<string, DRow[]>()
    for (const r of (existingRows || []) as { id: string; sku: string; price: number; effective_from: string; effective_to: string | null }[]) {
      const k = normSku(r.sku); if (!k) continue
      ;(bySku.get(k) ?? (bySku.set(k, []), bySku.get(k)!)).push({ id: String(r.id), price: Number(r.price) || 0, from: String(r.effective_from), to: r.effective_to ? String(r.effective_to) : null })
    }

    const setToPrev: string[] = []   // trim tail -> effective_to = prevDay(from)
    const setFromNext: string[] = [] // trim head -> effective_from = nextDay(to)
    const deleteIds: string[] = []
    const inserts: { sku: string; price: number; effective_from: string; effective_to: string | null; source: string | null }[] = []
    let splits = 0

    const prevFrom = prevDay(from)
    const nextTo = to ? nextDay(to) : null
    for (const k of keys) {
      const plan = planWindowOverwrite(bySku.get(k) || [], from, to)
      deleteIds.push(...plan.deleteIds)
      for (const u of plan.updates) {
        if (u.to === prevFrom && (bySku.get(k)!.find(r => r.id === u.id)?.from === u.from)) setToPrev.push(u.id)
        else if (nextTo && u.from === nextTo) setFromNext.push(u.id)
        else setToPrev.push(u.id) // left-trim fallback (to = prevDay(from))
      }
      for (const ins of plan.inserts) { inserts.push({ sku: k, price: ins.price, effective_from: ins.from, effective_to: ins.to, source: null }); splits++ }
      // the era row carrying the sheet column's price
      inserts.push({ sku: k, price: prices[k], effective_from: from, effective_to: to, source: `sheet:${column}` })
    }

    const summary = { ok: true, column, from, to, skusPriced: keys.length, eraInserts: keys.length, splits, trims: setToPrev.length + setFromNext.length, deletes: deleteIds.length, sample: keys.slice(0, 8).map(k => ({ sku: k, price: prices[k] })) }
    if (dryRun) return NextResponse.json(summary)

    // Apply: delete fully-covered, trim overlaps (two constant-value batches), insert eras+splits.
    for (const ids of chunk(deleteIds, 400)) { const { error: e } = await db.from('recon_prices').delete().in('id', ids); if (e) throw new Error(e.message) }
    for (const ids of chunk(setToPrev, 400)) { const { error: e } = await db.from('recon_prices').update({ effective_to: prevFrom }).in('id', ids); if (e) throw new Error(e.message) }
    if (nextTo) for (const ids of chunk(setFromNext, 400)) { const { error: e } = await db.from('recon_prices').update({ effective_from: nextTo }).in('id', ids); if (e) throw new Error(e.message) }
    for (const part of chunk(inserts, 400)) { const { error: e } = await db.from('recon_prices').insert(part); if (e) throw new Error(e.message) }

    return NextResponse.json(summary)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 })
  }
}
