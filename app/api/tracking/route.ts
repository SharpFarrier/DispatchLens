import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const WORKER = 'https://tracklens-proxy.adityaramnani91581.workers.dev'
const CARGO_EMAIL = 'logistics@sabiwabi.in'
const CARGO_PASSWORD = 'Sabi#789'

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

async function getCargoToken(): Promise<string | null> {
  try {
    const res = await fetch(`${WORKER}/cargo/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: CARGO_EMAIL, password: CARGO_PASSWORD }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.token || data.data?.token || data.access || null
  } catch {
    return null
  }
}

async function trackViaCargo(awbs: string[], token: string): Promise<Record<string, { status: string; label: string; lastUpdate: string }>> {
  const results: Record<string, { status: string; label: string; lastUpdate: string }> = {}

  // Fetch one AWB at a time — Cargo's shipment-list filters by awb param
  for (const awb of awbs) {
    try {
      const res = await fetch(`${WORKER}/cargo/shipment-list/?awb=${awb}`, {
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/json',
        },
      })
      if (!res.ok) continue
      const data = await res.json()
      // Cargo returns { data: [...shipments] } or { results: [...] }
      const shipments = data.data || data.results || []
      if (Array.isArray(shipments) && shipments.length > 0) {
        const shipment = shipments[0] as Record<string, unknown>
        const status = (shipment.status as string) || (shipment.shipment_status as string) || ''
        const lastUpdate = (shipment.updated_at as string) || (shipment.last_update as string) || ''
        results[awb] = { ...normalizeCargo(status), lastUpdate }
      }
    } catch { /* skip */ }
  }

  return results
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

  // Get Cargo token
  debugLog.push(`Logging into Cargo as ${CARGO_EMAIL}`)
  const token = await getCargoToken()
  if (!token) {
    debugLog.push('Cargo login failed')
    if (debug) return NextResponse.json({ results, debugLog })
    return NextResponse.json(results)
  }
  debugLog.push(`Cargo token obtained: ${token.slice(0, 20)}...`)

  // Track AWBs via Cargo
  const awbs = dlOrders.map(o => o.awb)
  debugLog.push(`Tracking ${awbs.length} Delhivery AWBs via Cargo`)

  for (const awb of awbs) {
    try {
      const res = await fetch(`${WORKER}/cargo/shipment-list/?awb=${awb}`, {
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/json',
        },
      })
      debugLog.push(`AWB ${awb}: HTTP ${res.status}`)
      if (!res.ok) continue
      const data = await res.json()
      const shipments = data.data || data.results || []
      if (Array.isArray(shipments) && shipments.length > 0) {
        const shipment = shipments[0] as Record<string, unknown>
        const status = (shipment.status as string) || (shipment.shipment_status as string) || ''
        const lastUpdate = (shipment.updated_at as string) || (shipment.last_update as string) || ''
        results[awb] = { ...normalizeCargo(status), lastUpdate }
        debugLog.push(`AWB ${awb}: status=${status}`)
      } else {
        debugLog.push(`AWB ${awb}: no shipments found, keys=${Object.keys(data).join(',')}`)
        if (debug) debugLog.push(`AWB ${awb}: raw=${JSON.stringify(data).slice(0, 300)}`)
      }
    } catch (e) {
      debugLog.push(`AWB ${awb}: error=${String(e)}`)
    }
  }

  if (debug) return NextResponse.json({ results, debugLog })
  return NextResponse.json(results)
}
