import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const WORKER_URL = 'https://tracklens-proxy.adityaramnani91581.workers.dev'

// Bluedart credentials
const BD_LOGIN_ID = 'BOM41184'
const BD_LICENCE_KEY = 'hkfoiszukslp0umqriqgn2bolmgovtge'
const BD_API_KEY = 'WxObKDF1pSM0GWYCBBjnemimMH7Ed3Gp'
const BD_API_SECRET = 'j2FGlGEWnGcgVYDs'
const BD_CUSTOMER_CODE = 'BOM485892'

function normalizeBluedart(statusCode: string, statusDesc: string): { status: string; label: string } {
  const s = (statusCode + ' ' + statusDesc).toLowerCase()
  if (s.includes('delivered')) return { status: 'delivered', label: 'Delivered' }
  if (s.includes('out for delivery') || s.includes('ofd')) return { status: 'ofd', label: 'Out for Delivery' }
  if (s.includes('ndr') || s.includes('delivery attempt') || s.includes('undelivered')) return { status: 'ndr', label: 'NDR' }
  if (s.includes('rto') || s.includes('return')) return { status: 'rto', label: 'RTO' }
  if (s.includes('picked up') || s.includes('pickup')) return { status: 'picked_up', label: 'Picked Up' }
  if (s.includes('in transit') || s.includes('transit') || s.includes('arrived') || s.includes('departed')) return { status: 'in_transit', label: 'In Transit' }
  if (s.includes('booked') || s.includes('manifested') || s.includes('shipment created')) return { status: 'booked', label: 'Booked' }
  return { status: 'unknown', label: statusDesc || statusCode || 'Unknown' }
}

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

async function getBluedartToken(): Promise<string | null> {
  try {
    const res = await fetch(`${WORKER_URL}/bluedart/in/transportation/token/v1/login`, {
      method: 'GET',
      headers: {
        'ClientID': BD_API_KEY,
        'ClientSecret': BD_API_SECRET,
        'Content-Type': 'application/json',
      },
    })
    if (!res.ok) return null
    const data = await res.json()
    return data?.JWTToken || null
  } catch {
    return null
  }
}

async function trackBluedart(awbs: string[]): Promise<Record<string, { status: string; label: string; lastUpdate: string }>> {
  const results: Record<string, { status: string; label: string; lastUpdate: string }> = {}
  const token = await getBluedartToken()
  if (!token) {
    console.error('Bluedart: could not get JWT token')
    return results
  }

  await Promise.all(awbs.map(async awb => {
    try {
      const res = await fetch(`${WORKER_URL}/bluedart/in/transportation/tracking/v1/awbno`, {
        method: 'GET',
        headers: {
          'JWTToken': `Bearer ${token}`,
          'LoginID': BD_LOGIN_ID,
          'LicenceKey': BD_LICENCE_KEY,
          'Content-Type': 'application/json',
          'AWBNo': awb,
        },
      })
      if (!res.ok) return
      const data = await res.json()
      const shipment = data?.ShipmentData?.[0]?.Shipment
      if (shipment) {
        const scans = shipment.Scans || []
        const latest = scans[0]?.ScanDetail
        const statusCode = latest?.ScanType || ''
        const statusDesc = latest?.Scan || shipment.Status || ''
        const scanDate = latest?.ScanDate || ''
        results[awb] = { ...normalizeBluedart(statusCode, statusDesc), lastUpdate: scanDate }
      }
    } catch { /* skip */ }
  }))
  return results
}

async function trackDelhivery(awbs: string[]): Promise<Record<string, { status: string; label: string; lastUpdate: string }>> {
  const results: Record<string, { status: string; label: string; lastUpdate: string }> = {}
  try {
    // Batch in groups of 10
    for (let i = 0; i < awbs.length; i += 10) {
      const batch = awbs.slice(i, i + 10)
      try {
        const res = await fetch(
          `${WORKER_URL}/delhivery/v1/packages/json/?waybill=${batch.join(',')}`,
          { headers: { 'Accept': 'application/json' } }
        )
        if (!res.ok) continue
        const data = await res.json()
        const packages = data?.ShipmentData || []
        packages.forEach((pkg: Record<string, unknown>) => {
          const awb = pkg.AWB as string
          const status = pkg.Status as string || ''
          const scans = pkg.Scans as Record<string, unknown>[] || []
          const lastUpdate = scans[0]?.ScanDateTime as string || ''
          if (awb) results[awb] = { ...normalizeDelhivery(status), lastUpdate }
        })
      } catch { /* skip batch */ }
    }
  } catch (e) {
    console.error('Delhivery tracking error:', e)
  }
  return results
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { orders } = await request.json() as { orders: { id: string; awb: string; courier: string }[] }
  if (!orders?.length) return NextResponse.json({})

  const bdAwbs = orders.filter(o => o.courier === 'Bluedart' && o.awb).map(o => o.awb)
  const dlAwbs = orders.filter(o => o.courier === 'Delhivery' && o.awb).map(o => o.awb)

  const [bdResults, dlResults] = await Promise.all([
    bdAwbs.length ? trackBluedart(bdAwbs) : Promise.resolve({}),
    dlAwbs.length ? trackDelhivery(dlAwbs) : Promise.resolve({}),
  ])

  return NextResponse.json({ ...bdResults, ...dlResults })
}
