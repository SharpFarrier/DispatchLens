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

// SimpleJWT convention. If Cargo namespaces it differently, pass `endpoint` in the body
// (grab the exact URL from the Cargo dashboard's Network tab).
const DEFAULT_REFRESH_URL = 'https://api-cargo.shiprocket.in/api/token/refresh/'

// POST — TEST ONLY. Exchanges a Cargo refresh token for a new access token and reports
// what happened. Saves nothing. Admin only. Purpose: prove whether the refresh flow can
// replace the 24h manual token paste, and measure how long the refresh token itself lasts.
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: access } = await supabase.from('dispatch_user_access').select('can_users').eq('email', user.email).maybeSingle()
  if (!access?.can_users) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const body = await request.json().catch(() => ({})) as { refreshToken?: string; endpoint?: string; refreshField?: string }
  let refreshToken = (body.refreshToken || '').trim()
  if (!refreshToken) {
    const { data } = await supabase.from('app_config').select('value').eq('key', 'cargo_refresh_token').maybeSingle()
    refreshToken = ((data?.value as string) || '').trim()
  }
  if (!refreshToken) return NextResponse.json({ ok: false, message: 'No refresh token provided in body, and none saved under app_config.cargo_refresh_token.' })

  const endpoint = (body.endpoint || '').trim() || DEFAULT_REFRESH_URL
  const refreshField = (body.refreshField || '').trim() || 'refresh'
  const refreshExp = decodeExp(refreshToken)

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ [refreshField]: refreshToken }),
    })
    const txt = await res.text()
    let parsed: Record<string, unknown> = {}
    try { parsed = JSON.parse(txt) } catch { /* non-JSON response */ }

    // Which field carries the new access token? (Different backends name it differently.)
    const candidates = ['access', 'access_token', 'token', 'accessToken']
    const accessField = candidates.find(f => typeof parsed[f] === 'string')
    const newAccess = accessField ? String(parsed[accessField]) : ''
    const newExp = newAccess ? decodeExp(newAccess) : null
    // Some backends rotate the refresh token on each use — if so, automation must save the new one.
    const rotatedRefresh = typeof parsed['refresh'] === 'string' && parsed['refresh'] !== refreshToken

    const ok = res.ok && !!newAccess
    return NextResponse.json({
      ok,
      status: res.status,
      endpoint,
      refreshField,
      refreshTokenExpiresAt: refreshExp ? new Date(refreshExp * 1000).toISOString() : null,
      gotNewAccessToken: !!newAccess,
      newAccessTokenField: accessField || null,
      newAccessTokenExpiresAt: newExp ? new Date(newExp * 1000).toISOString() : null,
      refreshTokenWasRotated: rotatedRefresh,
      // Surface the body ONLY on failure (so we can read the real error / field names).
      // Success is not echoed, to avoid returning the new token to the browser.
      responsePreview: ok ? undefined : txt.slice(0, 300),
      message: ok
        ? 'Refresh works — Cargo issued a new access token. Compare newAccessTokenExpiresAt vs refreshTokenExpiresAt to see the automation window.'
        : res.status === 404
          ? 'Endpoint returned 404 — the refresh URL is wrong. Copy the exact URL from the Cargo dashboard Network tab and pass it as "endpoint".'
          : `No access token returned (HTTP ${res.status}). Check responsePreview; the token field or "refreshField" may differ.`,
    })
  } catch (e) {
    return NextResponse.json({ ok: false, endpoint, message: String(e) })
  }
}
