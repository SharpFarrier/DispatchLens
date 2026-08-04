import type { createClient } from '@/lib/supabase/server'

type SupabaseServer = Awaited<ReturnType<typeof createClient>>

const CARGO_REFRESH_URL = 'https://api-cargo.shiprocket.in/api/token/refresh/'
const EXPIRY_SKEW_MS = 10 * 60 * 1000 // refresh when under 10 minutes of life remain

// Decode a JWT's exp claim, returned in milliseconds. No library.
function decodeExpMs(token: string): number | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    return typeof json.exp === 'number' ? json.exp * 1000 : null
  } catch { return null }
}

async function readConfig(supabase: SupabaseServer, key: string): Promise<string> {
  const { data } = await supabase.from('app_config').select('value').eq('key', key).maybeSingle()
  return ((data?.value as string) || '').trim()
}

async function writeConfig(supabase: SupabaseServer, key: string, value: string): Promise<void> {
  await supabase.from('app_config').upsert(
    { key, value, updated_at: new Date().toISOString(), updated_by: 'cargo-auto-refresh' },
    { onConflict: 'key' }
  )
}

/**
 * Returns a valid Cargo access token. If the stored access token is missing or within
 * EXPIRY_SKEW_MS of expiry, it exchanges the stored (server-side only) refresh token for
 * a new access token, persists it to app_config.cargo_token, and returns it. If the
 * backend rotates the refresh token, the new one is persisted too.
 *
 * Degrades gracefully: on any failure (no refresh token, refresh HTTP error, network
 * error) it returns whatever access token we currently have — so callers never hard-fail
 * because of the refresh path, and the manual paste remains a working fallback.
 */
export async function getCargoAccessToken(supabase: SupabaseServer): Promise<string> {
  const current = (await readConfig(supabase, 'cargo_token')) || (process.env.CARGO_TOKEN || '').trim()
  const exp = current ? decodeExpMs(current) : null
  const stillFresh = !!current && exp !== null && exp - Date.now() > EXPIRY_SKEW_MS
  if (stillFresh) return current

  const refresh = await readConfig(supabase, 'cargo_refresh_token')
  if (!refresh) return current // nothing to refresh with — use whatever we have

  try {
    const res = await fetch(CARGO_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ refresh }),
    })
    if (!res.ok) return current
    const json = (await res.json().catch(() => ({}))) as { access?: string; refresh?: string }
    const newAccess = typeof json.access === 'string' ? json.access.trim() : ''
    if (!newAccess) return current
    await writeConfig(supabase, 'cargo_token', newAccess)
    const rotated = typeof json.refresh === 'string' ? json.refresh.trim() : ''
    if (rotated && rotated !== refresh) await writeConfig(supabase, 'cargo_refresh_token', rotated)
    return newAccess
  } catch {
    return current
  }
}

/** Refresh-token metadata for the admin panel. No raw token leaves the server. */
export async function getCargoTokenStatus(supabase: SupabaseServer): Promise<{
  hasRefreshToken: boolean
  refreshExpiresAt: string | null
}> {
  const refresh = await readConfig(supabase, 'cargo_refresh_token')
  const exp = refresh ? decodeExpMs(refresh) : null
  return { hasRefreshToken: !!refresh, refreshExpiresAt: exp ? new Date(exp).toISOString() : null }
}
