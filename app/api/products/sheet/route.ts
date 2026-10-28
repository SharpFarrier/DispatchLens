import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { fetchSheetRows, type SheetRow } from '@/lib/masterSheet'

// Full per-row read of the master sheet for the Product Sync (SKU Map → "Sync from
// master sheet"). Any signed-in user; cached 5 min. The client diffs these Master
// SKUs against the backend to find the ones not yet connected.

export const dynamic = 'force-dynamic'

const TTL = 5 * 60 * 1000
let cache: { at: number; rows: SheetRow[] } | null = null

export async function GET() {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    if (!cache || Date.now() - cache.at > TTL) cache = { at: Date.now(), rows: await fetchSheetRows() }
    return NextResponse.json({ rows: cache.rows, cachedAt: cache.at, count: cache.rows.length })
  } catch (e) {
    if (cache) return NextResponse.json({ rows: cache.rows, cachedAt: cache.at, stale: true })
    return NextResponse.json({ error: (e as Error).message, rows: [] }, { status: 502 })
  }
}
