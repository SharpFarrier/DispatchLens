import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import DashboardClient from '@/components/dispatch/DashboardClient'

export default async function Home() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const today = new Date().toISOString().split('T')[0]
  const { data: sessions } = await supabase
    .from('dispatch_sessions')
    .select('*')
    .eq('session_date', today)
    .order('created_at', { ascending: false })

  return <DashboardClient user={user} initialSessions={sessions || []} />
}
