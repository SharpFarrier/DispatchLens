import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET: fetch events for an order
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const orderId = searchParams.get('order_id')
  if (!orderId) return NextResponse.json({ error: 'order_id required' }, { status: 400 })

  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data } = await admin
    .from('dispatch_order_events')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })

  return NextResponse.json(data || [])
}

// POST: add a note or system event
export async function POST(request: Request) {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { order_id, event_type, title, note } = body

  if (!order_id || !event_type || !title) {
    return NextResponse.json({ error: 'order_id, event_type, title required' }, { status: 400 })
  }

  const { data, error } = await admin
    .from('dispatch_order_events')
    .insert({
      order_id,
      event_type,
      title,
      note: note || null,
      created_by: user.id,
      created_by_email: user.email,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
