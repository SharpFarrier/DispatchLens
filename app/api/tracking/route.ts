import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const WORKER = 'https://tracklens-proxy.adityaramnani91581.workers.dev'

// True only for a genuine completed delivery. Guards against "undelivered",
// "not delivered", "cannot be delivered", "failed delivery", etc. — the word
// "delivered" only counts when NOT preceded by a negation.
function isDelivered(s: string): boolean {
  if (!s.includes('delivered')) return false
  const NEG = ['un', 'not ', 'non', 'cannot', "can't", 'couldnt', "couldn't", 'could not', 'no ', 'failed', 'attempt', 'unable']
  let idx = s.indexOf('delivered')
  while (idx !== -1) {
    const before = s.slice(Math.max(0, idx - 14), idx)
    const negated = NEG.some(n => before.includes(n)) || (idx >= 2 && s.slice(idx - 2, idx) === 'un')
    if (!negated) return true
    idx = s.indexOf('delivered', idx + 1)
  }
  return false
}

function normalizeCargo(status: string): { status: string; label: string } {
  const s = (status || '').toLowerCase()
  // Order matters: every NEGATIVE / non-final case is checked BEFORE the bare
  // "delivered" match. "undelivered"/"not delivered"/"failed delivery" contain
  // the substring "delivered" and previously leaked through as Delivered.
  if (s.includes('undelivered') || s.includes('not delivered') || s.includes('could not be delivered')
      || s.includes('delivery failed') || s.includes('failed delivery') || s.includes('delivery attempt')
      || s.includes('ndr') || s.includes('failed')) {
    return { status: 'ndr', label: 'NDR' }
  }
  if (s.includes('out_for_delivery') || s.includes('out for delivery')) return { status: 'ofd', label: 'Out for Delivery' }
  if (s.includes('rto')) return { status: 'rto', label: 'RTO' }
  if (isDelivered(s)) return { status: 'delivered', label: 'Delivered' }
  if (s.includes('in_transit') || s.includes('transit') || s.includes('shipped')) return { status: 'in_transit', label: 'In Transit' }
  if (s.includes('pickup scheduled') || s.includes('pickup_scheduled') || s.includes('ready_to_ship') || s.includes('ready to ship') || s.includes('manifested') || s.includes('booked')) return { status: 'booked', label: 'Pickup Scheduled' }
  if (s.includes('picked_up') || s.includes('picked up') || s.includes('pickup complete')) return { status: 'picked_up', label: 'Picked Up' }
  return { status: 'unknown', label: status || 'Unknown' }
}

async function trackDelhiveryPublic(awb: string, debugLog: string[]): Promise<{ status: string; label: string; lastUpdate: string } | null> {
  try {
    const res = await fetch(`https://dlv-api.delhivery.com/v3/unified-tracking?wbn=${awb}`, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://www.delhivery.com',
        'Referer': 'https://www.delhivery.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      },
    })
    const text = await res.text()
    if (!res.ok) { debugLog.push(`DL public ${awb}: HTTP ${res.status} ${text.slice(0, 150)}`); return null }
    const data = JSON.parse(text)
    const pkg = data?.data?.[0]
    if (!pkg) { debugLog.push(`DL public ${awb}: no data, keys=${Object.keys(data).join(',')}`); return null }
    const status = pkg?.status?.status || pkg?.status?.instructions || ''
    const lastUpdate = pkg?.status?.statusDateTime || ''
    debugLog.push(`DL public ${awb}: status=${status}`)
    return { ...normalizeCargo(status), lastUpdate }
  } catch (e) {
    debugLog.push(`DL public ${awb}: error=${String(e)}`)
    return null
  }
}

async function getCargoToken(supabase: Awaited<ReturnType<typeof createClient>>): Promise<string> {
  try {
    const { data } = await supabase.from('app_config').select('value').eq('key', 'cargo_token').maybeSingle()
    const dbToken = (data?.value as string) || ''
    if (dbToken) return dbToken
  } catch { /* fall through to env */ }
  return process.env.CARGO_TOKEN || ''
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

  // Token: DB (app_config) first, env var as fallback. Refreshed in-app, no redeploy.
  let token = await getCargoToken(supabase)
  debugLog.push(`Token present: ${token ? 'yes' : 'no'}`)

  if (!token) return NextResponse.json({ error: 'No Cargo token available' }, { status: 500 })

  // Track each AWB via Cargo shipment-list
  const today = new Date()
  const yearAgo = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const awbFields = ['waybill_no', 'awb', 'awb_code', 'awb_number', 'tracking_number', 'tracking_id', 'awb_no', 'waybill']

  const processOrder = async (order: { id: string; awb: string; courier: string }) => {
    try {
      const qs = new URLSearchParams({
        page: '1', page_size: '10',
        created_at_after: fmt(yearAgo),
        created_at_before: fmt(today),
        waybill_no: order.awb.trim(),
        entity: 'shipment',
      })
      const res = await fetch(`https://api-cargo.shiprocket.in/api/shipment-list/?${qs}`, {
        headers: {
          'Authorization': token.startsWith('eyJ') ? `Bearer ${token}` : `token ${token}`,
          'Accept': 'application/json',
        },
      })
      const bodyText = await res.text()
      if (!res.ok) { debugLog.push(`AWB ${order.awb}: HTTP ${res.status} ${bodyText.slice(0, 150)}`); return }
      const data = JSON.parse(bodyText)
      const list: Record<string, unknown>[] = data.data || data.results || []
      const match = list.find(s => awbFields.some(f => String(s[f] || '').trim() === order.awb.trim()))
        || (list.length === 1 ? list[0] : null)
      if (match) {
        const status = (match.status as string) || (match.shipment_status as string) || ''
        const lastUpdate = (match.updated_at as string) || (match.last_update as string) || ''
        let final = { ...normalizeCargo(status), lastUpdate }
        if (final.status === 'booked' || final.status === 'unknown') {
          const pub = await trackDelhiveryPublic(order.awb, debugLog)
          if (pub && pub.status !== 'unknown') final = pub
        }
        results[order.awb] = final
        debugLog.push(`AWB ${order.awb}: cargo=${status} final=${final.label}`)
      } else {
        const pub = await trackDelhiveryPublic(order.awb, debugLog)
        if (pub) results[order.awb] = pub
      }
    } catch (e) {
      debugLog.push(`AWB ${order.awb}: error=${String(e)}`)
    }
  }

  // Concurrency pool of 8
  const POOL = 8
  for (let i = 0; i < dlOrders.length; i += POOL) {
    await Promise.all(dlOrders.slice(i, i + POOL).map(processOrder))
  }

  if (debug) return NextResponse.json({ results, debugLog })
  return NextResponse.json(results)
}
