import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Decode a JWT's exp claim (unix seconds) without any library.
function decodeExp(token: string): number | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    return typeof json.exp === 'number' ? json.exp : null
  } catch { return null }
}

// GET — token metadata only (never returns the raw token to the client)
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data } = await supabase.from('app_config').select('value, updated_at, updated_by').eq('key', 'cargo_token').maybeSingle()
  const dbToken = (data?.value as string) || ''
  const token = dbToken || process.env.CARGO_TOKEN || ''
  const exp = token ? decodeExp(token) : null

  return NextResponse.json({
    hasToken: !!token,
    source: dbToken ? 'db' : (process.env.CARGO_TOKEN ? 'env' : 'none'),
    expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
    setAt: data?.updated_at || null,
    updatedBy: data?.updated_by || null,
  })
}

// POST — save a fresh token (admin only)
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: access } = await supabase.from('dispatch_user_access').select('can_users').eq('email', user.email).maybeSingle()
  if (!access?.can_users) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const body = await request.json().catch(() => ({})) as { token?: string }
  const clean = (body.token || '').trim()
  if (!clean) return NextResponse.json({ error: 'Token is empty' }, { status: 400 })

  const exp = decodeExp(clean)
  const { error } = await supabase.from('app_config').upsert(
    { key: 'cargo_token', value: clean, updated_at: new Date().toISOString(), updated_by: user.email },
    { onConflict: 'key' }
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, expiresAt: exp ? new Date(exp * 1000).toISOString() : null })
}
