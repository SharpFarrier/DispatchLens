import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { isStatus, isPriority, type ReqStatus } from '@/lib/requests'

// In-app feature-request tracker. All DB access goes through this route with the
// service-role key after the caller is authorised here (same pattern as
// /api/access); the table has RLS on with no public policies, so it is only
// reachable this way. Screenshots live in a private storage bucket and are
// handed back as short-lived signed URLs.

export const dynamic = 'force-dynamic'

const BUCKET = 'request-screenshots'
const TABLE = 'dispatch_feature_requests'
const OWNER_EMAIL = 'adityaramnani91581@gmail.com'

function getAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

type Caller = { email: string; name: string | null; isManager: boolean; admin: ReturnType<typeof getAdminClient> }

async function getCaller(): Promise<Caller | null> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return null
  const admin = getAdminClient()
  const { data: access } = await admin
    .from('dispatch_user_access').select('status, can_owner').eq('email', user.email).single()
  if (!access || access.status !== 'approved') return null
  const name = (user.user_metadata?.name as string | undefined) || (user.user_metadata?.full_name as string | undefined) || null
  return { email: user.email, name, isManager: !!access.can_owner || user.email === OWNER_EMAIL, admin }
}

const nowIso = () => new Date().toISOString()

// ── GET: list (role-scoped) or ?scope=count for the sidebar badge ──
export async function GET(request: Request) {
  const caller = await getCaller()
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const scope = new URL(request.url).searchParams.get('scope')
  if (scope === 'count') {
    let q = caller.admin.from(TABLE).select('id', { count: 'exact', head: true }).neq('status', 'done')
    if (!caller.isManager) q = q.eq('created_by', caller.email)
    const { count } = await q
    return NextResponse.json({ open: count ?? 0 })
  }

  let q = caller.admin.from(TABLE).select('*').order('created_at', { ascending: false })
  if (!caller.isManager) q = q.eq('created_by', caller.email)
  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (data || []) as Record<string, unknown>[]
  for (const r of rows) {
    const paths = (r.screenshots as string[] | null) || []
    if (paths.length) {
      const { data: signed } = await caller.admin.storage.from(BUCKET).createSignedUrls(paths, 3600)
      r.screenshot_urls = ((signed || []) as { signedUrl: string }[]).map(s => s.signedUrl)
    } else {
      r.screenshot_urls = []
    }
  }
  return NextResponse.json({ rows, isManager: caller.isManager, email: caller.email })
}

// ── POST: anyone approved files a request ──
export async function POST(request: Request) {
  const caller = await getCaller()
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const title = String(body.title || '').trim()
  if (!title) return NextResponse.json({ error: 'A short request is required' }, { status: 400 })
  const priority = isPriority(body.priority) ? body.priority : 'med'
  const screenshots: string[] = Array.isArray(body.screenshots)
    ? body.screenshots.filter((s: unknown): s is string => typeof s === 'string').slice(0, 6)
    : []

  const { data, error } = await caller.admin.from(TABLE).insert({
    tab_key: String(body.tab_key || 'unknown'),
    tab_label: String(body.tab_label || 'Unknown'),
    title: title.slice(0, 300),
    details: body.details ? String(body.details).slice(0, 4000) : null,
    priority,
    screenshots,
    created_by: caller.email,
    created_by_name: caller.name,
  }).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// ── PATCH: batch status (owner), single status/priority (owner), or submitter edit of own open row ──
export async function PATCH(request: Request) {
  const caller = await getCaller()
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => ({}))

  // Batch: { ids: string[], status }
  if (Array.isArray(body.ids)) {
    if (!caller.isManager) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const status: ReqStatus = isStatus(body.status) ? body.status : 'open'
    const done = status === 'done'
    const { error } = await caller.admin.from(TABLE).update({
      status, updated_at: nowIso(),
      resolved_at: done ? nowIso() : null,
      resolved_by: done ? caller.email : null,
    }).in('id', body.ids as string[])
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const id = body.id as string | undefined
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const { data: row } = await caller.admin.from(TABLE).select('created_by, status').eq('id', id).single()
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const patch: Record<string, unknown> = { updated_at: nowIso() }
  if (caller.isManager) {
    if (isStatus(body.status)) {
      const done = body.status === 'done'
      patch.status = body.status
      patch.resolved_at = done ? nowIso() : null
      patch.resolved_by = done ? caller.email : null
    }
    if (isPriority(body.priority)) patch.priority = body.priority
  } else {
    // Submitter may edit their own request only while it is still Open.
    if (row.created_by !== caller.email || row.status !== 'open') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 300)
    if (typeof body.details === 'string') patch.details = body.details.slice(0, 4000) || null
    if (isPriority(body.priority)) patch.priority = body.priority
  }

  const { data, error } = await caller.admin.from(TABLE).update(patch).eq('id', id).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// ── DELETE: owner any, or submitter their own open row ──
export async function DELETE(request: Request) {
  const caller = await getCaller()
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = new URL(request.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { data: row } = await caller.admin.from(TABLE).select('created_by, status, screenshots').eq('id', id).single()
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!caller.isManager && !(row.created_by === caller.email && row.status === 'open')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const shots = (row.screenshots as string[] | null) || []
  if (shots.length) await caller.admin.storage.from(BUCKET).remove(shots)
  const { error } = await caller.admin.from(TABLE).delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
