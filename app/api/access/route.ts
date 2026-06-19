import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET: fetch user's own access record (called on login)
export async function GET() {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const email = user.email!

  // Check if record exists
  const { data: existing } = await adminClient
    .from('dispatch_user_access')
    .select('*')
    .eq('email', email)
    .single()

  if (existing) {
    // Update user_id if not set
    if (!existing.user_id) {
      await adminClient.from('dispatch_user_access').update({ user_id: user.id }).eq('email', email)
    }
    return NextResponse.json(existing)
  }

  // First time — create pending record
  const { data: newRecord } = await adminClient
    .from('dispatch_user_access')
    .insert({ email, user_id: user.id, status: 'pending' })
    .select()
    .single()

  return NextResponse.json(newRecord)
}

// PATCH: update user access (owner only)
export async function PATCH(request: Request) {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify caller is owner
  const { data: callerAccess } = await adminClient
    .from('dispatch_user_access')
    .select('can_users, status')
    .eq('email', user.email!)
    .single()

  if (!callerAccess?.can_users || callerAccess.status !== 'approved') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()
  const { email, status, can_import, can_plan, can_review, can_picklist, can_eod, can_dispatched, can_users } = body

  const { data, error } = await adminClient
    .from('dispatch_user_access')
    .update({
      status,
      can_import: can_import ?? false,
      can_plan: can_plan ?? false,
      can_review: can_review ?? false,
      can_picklist: can_picklist ?? false,
      can_eod: can_eod ?? false,
      can_dispatched: can_dispatched ?? false,
      can_users: can_users ?? false,
      reviewed_at: new Date().toISOString(),
      reviewed_by: user.id,
    })
    .eq('email', email)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// GET all users (owner only) — separate endpoint
