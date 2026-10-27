import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'

// Live read of the Honey Touch master database Google Sheet (shared "anyone with
// the link"). Returns a SKU → { category, newPrice, productName } lookup keyed by
// EVERY sku alias (Master / Amazon / Flipkart / Website), so recon can resolve an
// order's SKU to its category (for the rate card) and listing price (BAU).
// Cached in-process for 10 min so it stays current without hammering the sheet.

export const dynamic = 'force-dynamic'

const SHEET_ID = '11UPpzvWyFdMYOasRFevpS4-rP6e8a0pOWKdW1g5vTwU'
const GID = '0'
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${GID}`
const TTL = 10 * 60 * 1000

interface Prod { category: string; newPrice: number | null; productName: string; masterSku: string }
let cache: { at: number; skus: Record<string, Prod> } | null = null

// Normalise a sku to a match key: strip all whitespace, uppercase. Order SKUs
// sometimes carry stray spaces (e.g. "L1-B-BL-RX- 3"); sheet SKUs are clean.
const norm = (s: string) => (s || '').replace(/\s+/g, '').toUpperCase()
const num = (v: string): number | null => { const n = parseFloat((v || '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n }

// Minimal quote-aware CSV parser (handles quoted commas like "₹14,699.00").
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false }
      else field += c
    } else if (c === '"') inQ = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

async function build(): Promise<Record<string, Prod>> {
  const res = await fetch(CSV_URL, { cache: 'no-store' })
  if (!res.ok) throw new Error(`sheet fetch failed: ${res.status}`)
  const rows = parseCsv(await res.text())
  if (rows.length < 2) return {}
  const header = rows[0].map(h => h.trim().toLowerCase())
  const col = (names: string[]) => { for (let i = 0; i < header.length; i++) if (names.includes(header[i])) return i; return -1 }
  const ci = col(['catogory', 'category']), mi = col(['master sku']), ai = col(['amazon sku'])
  const fi = col(['flipkart sku']), wi = col(['website sku']), pi = col(['new price']), ni = col(['product name'])
  const skus: Record<string, Prod> = {}
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row.some(c => (c || '').trim())) continue
    const get = (i: number) => (i >= 0 && i < row.length) ? (row[i] || '').trim() : ''
    const prod: Prod = { category: get(ci), newPrice: num(get(pi)), productName: get(ni), masterSku: get(mi) }
    for (const s of [get(mi), get(ai), get(fi), get(wi)]) { const k = norm(s); if (k) skus[k] = prod }
  }
  return skus
}

export async function GET() {
  // Light gate: any signed-in user. Data is non-sensitive catalogue info; the
  // client degrades gracefully if this fails (category/BAU just come back empty).
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    if (!cache || Date.now() - cache.at > TTL) cache = { at: Date.now(), skus: await build() }
    return NextResponse.json({ skus: cache.skus, cachedAt: cache.at, count: Object.keys(cache.skus).length })
  } catch (e) {
    if (cache) return NextResponse.json({ skus: cache.skus, cachedAt: cache.at, stale: true })
    return NextResponse.json({ error: (e as Error).message, skus: {} }, { status: 502 })
  }
}
