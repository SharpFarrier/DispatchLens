import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { createClient as adminClient } from '@supabase/supabase-js'
import DashboardClient from '@/components/dispatch/DashboardClient'
import AccessGate from '@/components/dispatch/AccessGate'

const admin = adminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export default async function Home() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const email = user.email!

  // Get or create access record
  let { data: access } = await admin
    .from('dispatch_user_access')
    .select('*')
    .eq('email', email)
    .single()

  if (!access) {
    const { data: newAccess } = await admin
      .from('dispatch_user_access')
      .insert({ email, user_id: user.id, status: 'pending' })
      .select()
      .single()
    access = newAccess
  } else if (!access.user_id) {
    await admin.from('dispatch_user_access').update({ user_id: user.id }).eq('email', email)
  }

  if (!access || access.status !== 'approved') {
    return <AccessGate status={access?.status || 'pending'} email={email} user={user} />
  }

  // Load ALL active orders across all sessions — no date boundary
  const { data: orders } = await supabase
    .from('dispatch_orders')
    .select('*')
    .order('created_at', { ascending: false })

  return (
    <DashboardClient
      user={user}
      access={access}
      initialOrders={orders || []}
    />
  )
}
