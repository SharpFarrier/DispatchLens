import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { fetchSheetSkus, type SheetProd } from '@/lib/masterSheet'

// Live read of the Honey Touch master database Google Sheet. Returns a SKU →
// { category, newPrice, productName } lookup keyed by EVERY sku alias (Master /
// Amazon / Flipkart / Website), so recon can resolve an order's SKU to its category
// (for the rate card) and listing price (BAU). Cached in-process for 10 min so it
// stays current without hammering the sheet. The fetch/parse lives in lib/masterSheet
// (shared with /api/recon/price-sync).

export const dynamic = 'force-dynamic'

const TTL = 10 * 60 * 1000
let cache: { at: number; skus: Record<string, SheetProd> } | null = null

export async function GET() {
  // Light gate: any signed-in user. Data is non-sensitive catalogue info; the
  // client degrades gracefully if this fails (category/BAU just come back empty).
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    if (!cache || Date.now() - cache.at > TTL) cache = { at: Date.now(), skus: await fetchSheetSkus() }
    return NextResponse.json({ skus: cache.skus, cachedAt: cache.at, count: Object.keys(cache.skus).length })
  } catch (e) {
    if (cache) return NextResponse.json({ skus: cache.skus, cachedAt: cache.at, stale: true })
    return NextResponse.json({ error: (e as Error).message, skus: {} }, { status: 502 })
  }
}
