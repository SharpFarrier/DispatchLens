import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { fetchSheetSkus, normSku } from '@/lib/masterSheet'

// Snapshot the sheet's current New Price per SKU into the dated recon_prices history,
// so reconciliation always has the base price that was in effect on each order's date
// (a sheet edit must not rebase past orders). For each sheet SKU:
//   - no open (current) price row  -> insert a baseline row effective from today
//   - open price differs           -> close it (effective_to = yesterday) + insert new
//   - open price equal             -> no-op (so a daily run is idempotent)
// Runs daily via Vercel cron (GET) and on demand from Price Master (POST).

export const dynamic = 'force-dynamic'

const IST = 'Asia/Kolkata'
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const istToday = () => ymd(new Date())
const prevDay = (day: string) => { const d = new Date(day + 'T00:00:00+05:30'); d.setDate(d.getDate() - 1); return ymd(d) }

function adminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

interface OpenRow { id: string; sku: string; price: number }

async function syncPrices() {
  const db = adminClient()
  const skus = await fetchSheetSkus()
  const today = istToday(), yday = prevDay(today)

  // Current (open) price per normalised sku.
  const { data: openRows, error } = await db.from('recon_prices').select('id, sku, price').is('effective_to', null)
  if (error) throw new Error(error.message)
  const openByKey = new Map<string, OpenRow>()
  for (const r of (openRows || []) as { id: string; sku: string; price: number }[]) {
    openByKey.set(normSku(r.sku), { id: r.id, sku: r.sku, price: Number(r.price) || 0 })
  }

  const created: string[] = []
  const updated: { sku: string; old: number; new: number }[] = []
  const toClose: string[] = []
  const toInsert: { sku: string; price: number; effective_from: string; effective_to: null }[] = []

  for (const [key, prod] of Object.entries(skus)) {
    if (prod.newPrice == null) continue
    const np = prod.newPrice
    const cur = openByKey.get(key)
    if (!cur) {
      toInsert.push({ sku: key, price: np, effective_from: today, effective_to: null })
      created.push(key)
    } else if (Math.round(cur.price) !== Math.round(np)) {
      toClose.push(cur.id)
      toInsert.push({ sku: key, price: np, effective_from: today, effective_to: null })
      updated.push({ sku: key, old: cur.price, new: np })
    }
  }

  // Close changed current rows first, then insert the new/baseline rows.
  if (toClose.length) {
    const { error: cErr } = await db.from('recon_prices').update({ effective_to: yday }).in('id', toClose)
    if (cErr) throw new Error(cErr.message)
  }
  if (toInsert.length) {
    const { error: iErr } = await db.from('recon_prices').insert(toInsert)
    if (iErr) throw new Error(iErr.message)
  }

  return {
    ok: true,
    date: today,
    created: created.length,
    changed: updated.length,
    updated: updated.slice(0, 50),
    scanned: Object.keys(skus).length,
  }
}

function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (secret) return req.headers.get('authorization') === `Bearer ${secret}`
  return req.headers.get('x-vercel-cron') != null   // Vercel cron infra header
}

// GET = scheduled (Vercel cron).
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try { return NextResponse.json(await syncPrices()) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 502 }) }
}

// POST = manual "Sync prices from sheet" button (any signed-in user).
export async function POST() {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try { return NextResponse.json(await syncPrices()) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 502 }) }
}
