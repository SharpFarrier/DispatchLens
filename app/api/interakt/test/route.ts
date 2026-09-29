import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'

// Connectivity check: calls Interakt's Get Users API with the stored Secret Key to confirm the
// key authenticates. Requires a logged-in user (owner/admin), never exposes the key to the client.
export async function GET() {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const key = process.env.INTERAKT_SECRET_KEY
  if (!key) return NextResponse.json({ connected: false, error: 'INTERAKT_SECRET_KEY not set' }, { status: 200 })

  try {
    // Get Users API — a light authenticated call; a 200 means the key works.
    const res = await fetch('https://api.interakt.ai/v1/public/track/users/', {
      method: 'GET',
      headers: { Authorization: `Basic ${key}`, 'Content-Type': 'application/json' },
    })
    const ok = res.status >= 200 && res.status < 300
    return NextResponse.json({ connected: ok, status: res.status }, { status: 200 })
  } catch (e) {
    return NextResponse.json({ connected: false, error: (e as Error).message }, { status: 200 })
  }
}
