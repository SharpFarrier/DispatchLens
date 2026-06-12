import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const WORKER = 'https://tracklens-proxy.adityaramnani91581.workers.dev'

function normalizeCargo(status: string): { status: string; label: string } {
  const s = (status || '').toLowerCase()
  if (s.includes('delivered')) return { status: 'delivered', label: 'Delivered' }
  if (s.includes('out_for_delivery') || s.includes('out for delivery')) return { status: 'ofd', label: 'Out for Delivery' }
  if (s.includes('ndr') || s.includes('undelivered') || s.includes('failed')) return { status: 'ndr', label: 'NDR' }
  if (s.includes('rto')) return { status: 'rto', label: 'RTO' }
  if (s.includes('in_transit') || s.includes('transit') || s.includes('shipped')) return { status: 'in_transit', label: 'In Transit' }
  if (s.includes('picked_up') || s.includes('pickup_scheduled') || s.includes('picked up')) return { status: 'picked_up', label: 'Picked Up' }
  if (s.includes('ready_to_ship') || s.includes('manifested') || s.includes('booked')) return { status: 'booked', label: 'Booked' }
  return { status: 'unknown', label: status || 'Unknown' }
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { orders, debug } = await request.json() as { orders: { id: string; awb: string; courier: string }[]; debug?: boolean }
  if (!orders?.length) return NextResponse.json({})

  const dlOrders = orders.filter(o => o.courier === 'Delhivery' && o.awb)
  const results: Record<string, { status: string; label: string; lastUpdate: string }> = {}
  const debugLog: string[] = []

  if (!dlOrders.length) return NextResponse.json(results)

  // Try env token first, auto-login if expired
  let token = process.env.CARGO_TOKEN || ''
  debugLog.push(`Env token present: ${token ? 'yes' : 'no'}`)

  // Auto-login to get fresh token
  const CARGO_EMAIL = process.env.CARGO_EMAIL || 'logistics@sabiwabi.in'
  const CARGO_PASSWORD = process.env.CARGO_PASSWORD || 'Sabi#789'
  // Try multiple Cargo/Shiprocket login endpoints
  const loginEndpoints = [
    'https://apiv2.shiprocket.in/v1/external/auth/login',
    'https://api-cargo.shiprocket.in/auth/login',
    'https://api-cargo.shiprocket.in/api/auth/login',
  ]
  for (const endpoint of loginEndpoints) {
    try {
      const loginRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: CARGO_EMAIL, password: CARGO_PASSWORD }),
      })
      const loginBody = await loginRes.text()
      debugLog.push(`${endpoint}: HTTP ${loginRes.status} ${loginBody.slice(0, 150)}`)
      if (loginRes.ok) {
        const loginData = JSON.parse(loginBody)
        const freshToken = loginData.token || loginData.data?.token || loginData.access
        if (freshToken) {
          token = freshToken
          debugLog.push(`Fresh token from ${endpoint}: ${token.slice(0, 20)}...`)
          break
        }
      }
    } catch (e) {
      debugLog.push(`${endpoint}: error=${String(e)}`)
    }
  }

  if (!token) return NextResponse.json({ error: 'No Cargo token available' }, { status: 500 })

  // Track each AWB via Cargo shipment-list
  for (const order of dlOrders) {
    try {
      const res = await fetch(`https://api-cargo.shiprocket.in/api/shipment-list/?awb=${order.awb}`, {
        headers: {
          'Authorization': token.startsWith('eyJ') ? `Bearer ${token}` : `token ${token}`,
          'Accept': 'application/json',
        },
      })
      const bodyText = await res.text()
      debugLog.push(`AWB ${order.awb}: HTTP ${res.status} body=${bodyText.slice(0, 300)}`)
      if (!res.ok) continue
      const data = JSON.parse(bodyText)
      const shipments = data.data || data.results || []
      if (Array.isArray(shipments) && shipments.length > 0) {
        const shipment = shipments[0] as Record<string, unknown>
        const status = (shipment.status as string) || (shipment.shipment_status as string) || ''
        const lastUpdate = (shipment.updated_at as string) || (shipment.last_update as string) || ''
        results[order.awb] = { ...normalizeCargo(status), lastUpdate }
        debugLog.push(`AWB ${order.awb}: status=${status}`)
      } else {
        debugLog.push(`AWB ${order.awb}: no shipments, keys=${Object.keys(data).join(',')}`)
        if (debug) debugLog.push(`AWB ${order.awb}: raw=${JSON.stringify(data).slice(0, 300)}`)
      }
    } catch (e) {
      debugLog.push(`AWB ${order.awb}: error=${String(e)}`)
    }
  }

  if (debug) return NextResponse.json({ results, debugLog })
  return NextResponse.json(results)
}
