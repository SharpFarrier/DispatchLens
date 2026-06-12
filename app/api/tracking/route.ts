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

  const token = process.env.CARGO_TOKEN
  if (!token) return NextResponse.json({ error: 'CARGO_TOKEN not configured' }, { status: 500 })
  debugLog.push(`Token present: ${token.slice(0, 20)}...`)

  // Track each AWB via Cargo shipment-list
  for (const order of dlOrders) {
    try {
      const res = await fetch(`https://api-cargo.shiprocket.in/api/shipment-list/?awb=${order.awb}`, {
        headers: {
          'Authorization': `token ${token}`,
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
