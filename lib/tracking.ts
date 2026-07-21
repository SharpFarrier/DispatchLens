// Shared courier tracking engine — used by forward sync (Dashboard) and reverse sync (Returns).
// Pure: no React state. Callers own persistence and UI.

const WORKER = 'https://tracklens-proxy.adityaramnani91581.workers.dev'
const BD_API_KEY = 'WxObKDF1pSM0GWYCBBjnemimMH7Ed3Gp'
const BD_API_SECRET = 'j2FGlGEWnGcgVYDs'
const BD_LOGIN_ID = 'BOM41184'
const BD_LICENCE_KEY = 'hkfoiszukslp0umqriqgn2bolmgovtge'

export interface TrackResult { status: string; label: string; lastUpdate: string; reverseAwb?: string | null }
export type TrackResults = Record<string, TrackResult>

export interface TrackInput {
  id: string
  awb: string
  courier: 'Bluedart' | 'Delhivery' | string
}

export function normalizeBD(code: string, desc: string): { status: string; label: string } {
  const s = (code + ' ' + desc).toLowerCase()
  // Order matters: every NEGATIVE / non-final case is checked BEFORE the bare
  // "delivered" match, and "delivered" is matched as a real delivery event —
  // never as a substring of "undelivered" / "not delivered", and never from an
  // intermediate hub scan that merely mentions the word.
  if (s.includes('undelivered') || s.includes('not delivered') || s.includes('could not be delivered')
      || s.includes('delivery attempt') || s.includes('delivery failed') || s.includes('failed delivery')
      || s.includes('delivery not done') || s.includes('ndr')) {
    return { status: 'ndr', label: 'NDR' }
  }
  if (s.includes('out for delivery') || /\bofd\b/.test(s)) return { status: 'ofd', label: 'Out for Delivery' }
  if (s.includes('rto') || s.includes('return to origin') || s.includes('returned to origin') || s.includes('return')) return { status: 'rto', label: 'RTO' }
  // Positive delivery only: "shipment delivered" / "delivered to consignee" / a
  // status literally "delivered", but NOT when preceded by un-/not-/cannot.
  if (isDelivered(s)) return { status: 'delivered', label: 'Delivered' }
  if (s.includes('picked up') || s.includes('pickup')) return { status: 'picked_up', label: 'Picked Up' }
  if (s.includes('transit') || s.includes('arrived') || s.includes('departed') || s.includes('in-transit')) return { status: 'in_transit', label: 'In Transit' }
  if (s.includes('booked') || s.includes('manifested')) return { status: 'booked', label: 'Booked' }
  return { status: 'unknown', label: desc || code || 'Unknown' }
}

export function normalizeDL(status: string): { status: string; label: string } {
  const s = (status || '').toLowerCase()
  // Same ordering discipline as normalizeBD: exclusions first, positive delivery last.
  if (s.includes('undelivered') || s.includes('not delivered') || s.includes('could not be delivered')
      || s.includes('failed delivery') || s.includes('delivery failed') || s.includes('delivery attempt')
      || s.includes('ndr')) {
    return { status: 'ndr', label: 'NDR' }
  }
  if (s.includes('out for delivery')) return { status: 'ofd', label: 'Out for Delivery' }
  if (s.includes('rto') || s.includes('return to origin') || s.includes('returned to origin') || s.includes('return')) return { status: 'rto', label: 'RTO' }
  if (isDelivered(s)) return { status: 'delivered', label: 'Delivered' }
  if (s.includes('transit') || s.includes('in-transit')) return { status: 'in_transit', label: 'In Transit' }
  if (s.includes('picked up') || s.includes('pickup')) return { status: 'picked_up', label: 'Picked Up' }
  return { status: 'booked', label: status || 'Booked' }
}

// True only for a genuine completed delivery — guards against "undelivered",
// "not delivered", "cannot be delivered", etc. Requires the word "delivered"
// with no negating token immediately before it.
function isDelivered(s: string): boolean {
  if (!s.includes('delivered')) return false
  // Reject if any negation precedes a 'delivered' occurrence.
  const NEG = ['un', 'not ', 'non', 'cannot', "can't", 'couldnt', "couldn't", 'could not', 'no ', 'failed', 'attempt', 'unable']
  // Scan each 'delivered' occurrence; accept only if none are negated.
  let idx = s.indexOf('delivered')
  while (idx !== -1) {
    const before = s.slice(Math.max(0, idx - 14), idx)
    const negated = NEG.some(n => before.includes(n)) || (idx >= 2 && s.slice(idx - 2, idx) === 'un')
    if (!negated) return true
    idx = s.indexOf('delivered', idx + 1)
  }
  return false
}

// Fetch tracking for a set of AWBs across couriers. Returns results keyed by AWB.
// onProgress is called after each batch/chunk with how many were just processed.
export async function fetchTracking(
  orders: TrackInput[],
  onProgress?: (justDone: number) => void,
): Promise<TrackResults> {
  const results: TrackResults = {}
  if (!orders.length) return results

  const bdOrders = orders.filter(o => o.courier === 'Bluedart')
  const dlOrders = orders.filter(o => o.courier === 'Delhivery')

  // ── Bluedart: JWT login, then throttled XML tracking calls via the worker ──
  if (bdOrders.length) {
    let bdToken: string | null = null
    try {
      const tokenRes = await fetch(`${WORKER}/bluedart/in/transportation/token/v1/login`, {
        method: 'GET',
        headers: { 'ClientID': BD_API_KEY, 'ClientSecret': BD_API_SECRET },
      })
      const tokenData = await tokenRes.json()
      bdToken = tokenData?.JWTToken || null
    } catch { /* token failed */ }

    if (bdToken) {
      const CONCURRENCY = 6
      for (let i = 0; i < bdOrders.length; i += CONCURRENCY) {
        const batch = bdOrders.slice(i, i + CONCURRENCY)
        await Promise.all(batch.map(async o => {
          try {
            const params = new URLSearchParams({
              handler: 'tnt',
              action: 'custawbquery',
              loginid: BD_LOGIN_ID,
              awb: 'awb',
              numbers: o.awb.trim(),
              format: 'xml',
              lickey: BD_LICENCE_KEY,
              verno: '1.3',
              scan: '1',
            })
            const res = await fetch(`${WORKER}/bluedart/in/transportation/tracking/v1?${params}`, {
              method: 'GET',
              headers: { 'JWTToken': bdToken as string },
            })
            if (res.status === 429) return
            const xmlText = await res.text()
            const doc = new DOMParser().parseFromString(xmlText, 'text/xml')
            const shipment = doc.querySelector('Shipment')
            if (shipment) {
              const statusEl = shipment.querySelector('Status')
              const firstScan = shipment.querySelector('Scans Scan, Scans > ScanDetail')
              const scanText = firstScan?.querySelector('Scan')?.textContent || firstScan?.textContent || ''
              const scanDate = firstScan?.querySelector('ScanDate')?.textContent || ''
              const statusText = statusEl?.textContent || scanText || ''
              // Reverse AWB: Bluedart puts the return/RTO waybill in <NewWaybillNo>
              // once the shipment is Returned To Origin. Capture it so the reverse
              // leg can be auto-tracked without manual entry.
              const newWaybill = (shipment.querySelector('NewWaybillNo')?.textContent
                || shipment.querySelector('NewWayBillNo')?.textContent
                || shipment.getAttribute('NewWaybillNo')
                || shipment.getAttribute('NewWayBillNo')
                || '').trim()
              if (statusText) {
                const norm = normalizeBD('', statusText)
                results[o.awb] = { ...norm, lastUpdate: scanDate, reverseAwb: newWaybill && newWaybill !== o.awb ? newWaybill : null }
              }
            }
          } catch { /* skip */ }
        }))
        onProgress?.(batch.length)
        if (i + CONCURRENCY < bdOrders.length) await new Promise(r => setTimeout(r, 200))
      }
    }
  }

  // ── Delhivery: server route, chunked to stay under serverless timeout ──
  if (dlOrders.length) {
    const CHUNK = 25
    for (let i = 0; i < dlOrders.length; i += CHUNK) {
      const chunk = dlOrders.slice(i, i + CHUNK)
      try {
        const res = await fetch('/api/tracking', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orders: chunk.map(o => ({ id: o.id, awb: o.awb, courier: o.courier }))
          }),
        })
        if (res.ok) {
          const data = await res.json()
          Object.assign(results, data)
        }
      } catch { /* skip chunk */ }
      onProgress?.(chunk.length)
    }
  }

  return results
}
