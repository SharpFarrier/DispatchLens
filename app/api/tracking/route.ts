import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const WORKER_URL = 'https://tracklens-proxy.adityaramnani91581.workers.dev'
const DELHIVERY_BASE = 'https://track.delhivery.com/api/v1/packages/json'

// Status normalisation
function normalizeBluedart(statusCode: string, statusDesc: string): { status: string; label: string } {
  const s = (statusCode + ' ' + statusDesc).toLowerCase()
  if (s.includes('delivered')) return { status: 'delivered', label: 'Delivered' }
  if (s.includes('out for delivery') || s.includes('ofd')) return { status: 'ofd', label: 'Out for Delivery' }
  if (s.includes('ndr') || s.includes('delivery attempt') || s.includes('undelivered')) return { status: 'ndr', label: 'NDR' }
  if (s.includes('rto') || s.includes('return')) return { status: 'rto', label: 'RTO' }
  if (s.includes('picked up') || s.includes('pickup')) return { status: 'picked_up', label: 'Picked Up' }
  if (s.includes('in transit') || s.includes('transit') || s.includes('arrived') || s.includes('departed')) return { status: 'in_transit', label: 'In Transit' }
  if (s.includes('booked') || s.includes('manifested') || s.includes('shipment created')) return { status: 'booked', label: 'Booked' }
  return { status: 'unknown', label: statusDesc || 'Unknown' }
}

function normalizeDelhivery(status: string): { status: string; label: string } {
  const s = status.toLowerCase()
  if (s.includes('delivered')) return { status: 'delivered', label: 'Delivered' }
  if (s.includes('out for delivery')) return { status: 'ofd', label: 'Out for Delivery' }
  if (s.includes('failed delivery') || s.includes('undelivered')) return { status: 'ndr', label: 'NDR' }
  if (s.includes('rto') || s.includes('return')) return { status: 'rto', label: 'RTO' }
  if (s.includes('transit') || s.includes('in transit')) return { status: 'in_transit', label: 'In Transit' }
  if (s.includes('picked up') || s.includes('pickup')) return { status: 'picked_up', label: 'Picked Up' }
  if (s.includes('manifested') || s.includes('booked') || s.includes('pending')) return { status: 'booked', label: 'Booked' }
  return { status: 'unknown', label: status || 'Unknown' }
}

async function trackBluedart(awbs: string[]): Promise<Record<string, { status: string; label: string; lastUpdate: string }>> {
  const results: Record<string, { status: string; label: string; lastUpdate: string }> = {}
  try {
    // Get JWT token from Worker
    const tokenRes = await fetch(`${WORKER_URL}/bluedart-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!tokenRes.ok) throw new Error('Failed to get Bluedart token')
    const { token } = await tokenRes.json()

    // Track each AWB
    await Promise.all(awbs.map(async awb => {
      try {
        const trackRes = await fetch(`${WORKER_URL}/bluedart-track`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ awb, token }),
        })
        if (!trackRes.ok) return
        const data = await trackRes.json()
        // Parse response - Bluedart returns ShipmentData array
        const shipment = data?.ShipmentData?.[0]?.Shipment
        if (shipment) {
          const scans = shipment.Scans || []
          const latest = scans[0]?.ScanDetail
          const statusCode = latest?.ScanType || ''
          const statusDesc = latest?.Scan || shipment.Status || ''
          const scanDate = latest?.ScanDate || ''
          const { status, label } = normalizeBluedart(statusCode, statusDesc)
          results[awb] = { status, label, lastUpdate: scanDate }
        }
      } catch { /* skip failed AWB */ }
    }))
  } catch (e) {
    console.error('Bluedart tracking error:', e)
  }
  return results
}

async function trackDelhivery(awbs: string[]): Promise<Record<string, { status: string; label: string; lastUpdate: string }>> {
  const results: Record<string, { status: string; label: string; lastUpdate: string }> = {}
  try {
    // Delhivery supports batch tracking with comma-separated AWBs
    const batches = []
    for (let i = 0; i < awbs.length; i += 10) batches.push(awbs.slice(i, i + 10))
    
    await Promise.all(batches.map(async batch => {
      try {
        const url = `${DELHIVERY_BASE}/?waybill=${batch.join(',')}`
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } })
        if (!res.ok) return
        const data = await res.json()
        const packages = data?.ShipmentData || []
        packages.forEach((pkg: Record<string, unknown>) => {
          const awb = pkg.AWB as string
          const status = pkg.Status as string || ''
          const lastScan = (pkg.Scans as Record<string, unknown>[])?.[0]
          const lastUpdate = lastScan?.ScanDateTime as string || ''
          if (awb) {
            results[awb] = { ...normalizeDelhivery(status), lastUpdate }
          }
        })
      } catch { /* skip failed batch */ }
    }))
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

  const combined = { ...bdResults, ...dlResults }
  return NextResponse.json(combined)
}
