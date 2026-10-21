import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'

// Admin register of generated barcode batches. All access here is service-role
// after an admin check (can_users), same pattern as /api/access. Generators only
// INSERT rows (directly, under RLS); this route lists and approves them.

export const dynamic = 'force-dynamic'

const TABLE = 'barcode_batches'
const OWNER_EMAIL = 'adityaramnani91581@gmail.com'

function getAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

async function getCaller() {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return null
  const admin = getAdminClient()
  const { data: access } = await admin
    .from('dispatch_user_access').select('status, can_users').eq('email', user.email).single()
  if (!access || access.status !== 'approved') return null
  const isAdmin = !!access.can_users || user.email === OWNER_EMAIL
  return { userId: user.id, email: user.email, isAdmin, admin }
}

// GET: list batches (admin only), newest first, with the generator's email resolved.
export async function GET() {
  const caller = await getCaller()
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!caller.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data, error } = await caller.admin.from(TABLE).select('*').order('created_at', { ascending: false }).limit(200)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rows = (data || []) as Record<string, unknown>[]

  // Resolve created_by (auth uid) -> email for display.
  const ids = Array.from(new Set(rows.map(r => r.created_by).filter((x): x is string => typeof x === 'string')))
  const byId: Record<string, string> = {}
  if (ids.length) {
    const { data: users } = await caller.admin.from('dispatch_user_access').select('email, user_id').in('user_id', ids)
    for (const u of (users || []) as { email: string; user_id: string | null }[]) {
      if (u.user_id && u.email) byId[u.user_id] = u.email
    }
  }
  for (const r of rows) {
    const uid = r.created_by as string | null
    r.generator = uid ? (byId[uid] || null) : null
  }
  return NextResponse.json({ rows })
}

// PATCH: approve a batch (admin only). Body: { id }.
export async function PATCH(request: Request) {
  const caller = await getCaller()
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!caller.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const id = body.id as string | undefined
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { data, error } = await caller.admin.from(TABLE)
    .update({ status: 'approved', approved_at: new Date().toISOString(), approved_by: caller.userId })
    .eq('id', id).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
