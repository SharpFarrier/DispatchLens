import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCargoAccessToken } from '@/lib/cargoToken'

// GET — returns a currently-valid Cargo access token, auto-refreshing server-side
// (via the stored refresh token) if the saved one is expiring. Available to any
// authenticated user, since label/invoice generation needs it. The refresh token
// itself never leaves the server.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const token = await getCargoAccessToken(supabase)
  if (!token) return NextResponse.json({ error: 'No Cargo token available' }, { status: 500 })
  return NextResponse.json({ token })
}
