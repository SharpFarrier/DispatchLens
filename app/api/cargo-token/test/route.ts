import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// POST — test a Cargo token (the one passed in body, else the saved/env one)
// against the Cargo shipment-list endpoint. Does NOT save anything.
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({})) as { token?: string }
  let token = (body.token || '').trim()
  if (!token) {
    const { data } = await supabase.from('app_config').select('value').eq('key', 'cargo_token').maybeSingle()
    token = ((data?.value as string) || process.env.CARGO_TOKEN || '').trim()
  }
  if (!token) return NextResponse.json({ ok: false, message: 'No token available to test.' })

  try {
    const qs = new URLSearchParams({ page: '1', page_size: '1', entity: 'shipment' })
    const res = await fetch(`https://api-cargo.shiprocket.in/api/shipment-list/?${qs}`, {
      headers: {
        'Authorization': token.startsWith('eyJ') ? `Bearer ${token}` : `token ${token}`,
        'Accept': 'application/json',
      },
    })
    const txt = await res.text()
    if (res.ok) return NextResponse.json({ ok: true, status: res.status, message: 'Valid — Cargo accepted the token.' })
    if (res.status === 403) return NextResponse.json({ ok: false, status: 403, message: 'Rejected (403) — token is invalid or expired.' })
    return NextResponse.json({ ok: false, status: res.status, message: `HTTP ${res.status}: ${txt.slice(0, 140)}` })
  } catch (e) {
    return NextResponse.json({ ok: false, message: String(e) })
  }
}
