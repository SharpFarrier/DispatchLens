import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET() {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerAccess } = await adminClient
    .from('dispatch_user_access')
    .select('can_users, status')
    .eq('email', user.email!)
    .single()

  if (!callerAccess?.can_users || callerAccess.status !== 'approved') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data } = await adminClient
    .from('dispatch_user_access')
    .select('*')
    .order('requested_at', { ascending: false })

  return NextResponse.json(data || [])
}
