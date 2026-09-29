import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Interakt "messages received from user" webhook receiver (v1a: capture raw).
// Security: Interakt calls a URL WE choose. We require a shared secret in the path/query
// (?token=...) that matches INTERAKT_WEBHOOK_TOKEN, so random POSTs can't write to the table.
// It stores the ENTIRE raw payload untouched, plus best-effort from_phone / event_type, and
// always returns 200 quickly so Interakt doesn't retry.

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })
}

// best-effort extraction — we do NOT rely on these shapes; the raw payload is the source of truth
function guessPhone(p: unknown): string | null {
  try {
    const o = p as Record<string, unknown>
    const d = (o.data ?? o) as Record<string, unknown>
    const cust = (d.customer ?? d.user ?? {}) as Record<string, unknown>
    const cc = (cust.country_code ?? cust.countryCode ?? '') as string
    const pn = (cust.phone_number ?? cust.phoneNumber ?? cust.phone ?? d.phone_number ?? d.from ?? '') as string
    const joined = `${cc || ''}${pn || ''}`.trim()
    return joined || null
  } catch { return null }
}
function guessEvent(p: unknown): string | null {
  try { const o = p as Record<string, unknown>; return (o.type ?? o.event ?? o.event_type ?? null) as string | null } catch { return null }
}

export async function POST(request: Request) {
  const url = new URL(request.url)
  const token = url.searchParams.get('token')
  const expected = process.env.INTERAKT_WEBHOOK_TOKEN
  if (!expected || token !== expected) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })
  }
  let body: unknown = null
  try { body = await request.json() } catch { body = { _unparsed: await request.text().catch(() => '') } }
  try {
    await admin().from('wa_inbound_raw').insert({
      payload: body as object,
      from_phone: guessPhone(body),
      event_type: guessEvent(body),
    })
  } catch {
    // never fail the webhook on our storage error — Interakt would just retry/mark failed
  }
  return NextResponse.json({ ok: true })
}

// Interakt may send a GET to verify the endpoint is reachable.
export async function GET(request: Request) {
  const url = new URL(request.url)
  if (process.env.INTERAKT_WEBHOOK_TOKEN && url.searchParams.get('token') === process.env.INTERAKT_WEBHOOK_TOKEN) {
    return NextResponse.json({ ok: true, ready: true })
  }
  return NextResponse.json({ ok: true })
}
