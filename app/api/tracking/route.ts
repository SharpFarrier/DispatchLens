import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

function normalizeDelhivery(status: string): { status: string; label: string } {
  const s = (status || '').toLowerCase()
  if (s.includes('delivered')) return { status: 'delivered', label: 'Delivered' }
  if (s.includes('out for delivery')) return { status: 'ofd', label: 'Out for Delivery' }
  if (s.includes('failed delivery') || s.includes('undelivered')) return { status: 'ndr', label: 'NDR' }
  if (s.includes('rto') || s.includes('return')) return { status: 'rto', label: 'RTO' }
  if (s.includes('transit') || s.includes('in transit')) return { status: 'in_transit', label: 'In Transit' }
  if (s.includes('picked up') || s.includes('pickup')) return { status: 'picked_up', label: 'Picked Up' }
  if (s.includes('manifested') || s.includes('booked') || s.includes('pending')) return { status: 'booked', label: 'Booked' }
  return { status: 'unknown', label: status || 'Unknown' }
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { orders } = await request.json() as { orders: { id: string; awb: string; courier: string }[] }
  if (!orders?.length) return NextResponse.json({})

  const dlOrders = orders.filter(o => o.courier === 'Delhivery' && o.awb)
  const results: Record<string, { status: string; label: string; lastUpdate: string }> = {}

  if (!dlOrders.length) return NextResponse.json(results)

  const token = process.env.DELHIVERY_TOKEN
  if (!token) return NextResponse.json({ error: 'DELHIVERY_TOKEN not configured' }, { status: 500 })

  // Batch in groups of 10
  for (let i = 0; i < dlOrders.length; i += 10) {
    const batch = dlOrders.slice(i, i + 10)
    try {
      const awbs = batch.map(o => o.awb).join(',')
      const res = await fetch(
        `https://track.delhivery.com/api/v1/packages/json/?waybill=${awbs}`,
        {
          headers: {
            'Authorization': `Token ${token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          }
        }
      )
      if (!res.ok) {
        console.error('Delhivery tracking failed:', res.status, await res.text())
        continue
      }
      const data = await res.json()
      const packages = data?.ShipmentData || []
      packages.forEach((pkg: Record<string, unknown>) => {
        const awb = pkg.AWB as string
        if (awb) {
          const scans = pkg.Scans as Record<string, unknown>[] || []
          results[awb] = {
            ...normalizeDelhivery(pkg.Status as string || ''),
            lastUpdate: scans[0]?.ScanDateTime as string || '',
          }
        }
      })
    } catch (e) {
      console.error('Delhivery batch error:', e)
    }
  }

  return NextResponse.json(results)
}
