import { Courier, ParsedOrder, UrgencyTier } from '@/types'

// Parse scientific notation (e.g. 2.08945E+13) to full integer string
function parsePossibleScientific(val: string): string {
  if (!val || val.trim() === '') return val
  const s = val.trim()
  // Check if it looks like scientific notation
  if (/^[\d.]+[eE][+\-]?\d+$/.test(s)) {
    try {
      return BigInt(Math.round(parseFloat(s))).toString()
    } catch {
      return String(Math.round(parseFloat(s)))
    }
  }
  return s
}

// Parse date strings in multiple formats
function parseDate(raw: string | undefined): string | null {
  if (!raw || raw === '#N/A' || raw === '#REF!' || raw.trim() === '') return null
  const s = raw.trim()

  // DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/)
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`

  // M-D-YY (Bluedart format e.g. 6-19-26)
  const mdy = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/)
  if (mdy) return `20${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`

  // M-D-YYYY
  const mdyFull = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/)
  if (mdyFull) return `${mdyFull[3]}-${mdyFull[1].padStart(2, '0')}-${mdyFull[2].padStart(2, '0')}`

  // DD/MM/YYYY or MM/DD/YY
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (slash) {
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3]
    return `${year}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`
  }

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s

  return null
}

function computeDaysLeft(promiseDateStr: string | null, transitDays: number): number | null {
  if (!promiseDateStr) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const promise = new Date(promiseDateStr)
  promise.setHours(0, 0, 0, 0)
  const diffDays = Math.round((promise.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
  return diffDays - transitDays
}

function computeUrgency(daysLeft: number | null): UrgencyTier | null {
  if (daysLeft === null) return null
  if (daysLeft <= 0) return 'CRITICAL'
  if (daysLeft <= 2) return 'TODAY'
  if (daysLeft === 3) return 'PLAN'
  return 'HOLD'
}

function isCancelledStatus(status: string): boolean {
  return ['cancel', 'cancelled', 'canceled'].includes(status.toLowerCase().trim())
}

function isDispatchedStatus(status: string): boolean {
  return status.toLowerCase().trim() === 'dispatched'
}

// Detect header row and map columns
function mapHeaders(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {}
  headers.forEach((h, i) => {
    const norm = h.toLowerCase().trim()
    if (norm.includes('order id') || norm === 'order id') map['order_id'] = i
    if (norm.includes('order date')) map['order_date'] = i
    if (norm.includes('dispatch by') || norm.includes('dispatch by date')) map['dispatch_by_date'] = i
    if (norm === 'name') map['name'] = i
    if (norm === 'qty') map['qty'] = i
    if (norm === 'courier') map['courier'] = i
    if (norm.includes('ltl') || norm.includes('tracking')) map['tracking'] = i
    if (norm === 'master') map['master'] = i
    if (norm.includes('sku')) map['sku'] = i
    if (norm === 'status') map['status'] = i
    if (norm.includes('dispatch date') || norm === 'disaptch date') map['dispatch_date'] = i
    if (norm.includes('promise date')) map['promise_date'] = i
    if (norm === 'pincode') map['pincode'] = i
    if (norm === 'state') map['state'] = i
    if (norm === 'oda') map['oda'] = i
    if (norm.includes('transit')) map['transit_days'] = i
    // Delhivery sheet has city between promise date and pincode (unnamed or state/city)
    if (norm === 'city' || norm === '') {
      if (!map['city']) map['city'] = i
    }
  })
  return map
}

export function parseOrders(rawText: string, courier: Courier): ParsedOrder[] {
  const lines = rawText.trim().split('\n').filter(l => l.trim())
  if (lines.length < 2) return []

  // Find header line (contains 'order' or 'sku')
  let headerIdx = 0
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const lower = lines[i].toLowerCase()
    if (lower.includes('order') || lower.includes('sku')) {
      headerIdx = i
      break
    }
  }

  const headers = lines[headerIdx].split('\t')
  const colMap = mapHeaders(headers)
  const results: ParsedOrder[] = []

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    if (cols.length < 3) continue

    const get = (key: string) => colMap[key] !== undefined ? (cols[colMap[key]] || '').trim() : ''

    const orderId = get('order_id')
    if (!orderId || orderId === '' || /^\d+$/.test(orderId) && orderId.length < 4) continue

    const rawStatus = get('status')
    const skuRaw = get('sku')
    const promiseDateStr = parseDate(get('promise_date'))
    const transitDays = parseInt(get('transit_days')) || 7
    const daysLeft = computeDaysLeft(promiseDateStr, transitDays)

    // For Delhivery: city is between state and pincode columns
    // detect city separately
    let city = get('city')
    // Delhivery sheet: state col exists, city is unlabelled col after state
    if (courier === 'Delhivery' && colMap['state'] !== undefined) {
      const stateIdx = colMap['state']
      if (cols[stateIdx + 1] && !city) {
        city = (cols[stateIdx + 1] || '').trim()
      }
    }

    const order: ParsedOrder = {
      order_id: orderId,
      order_date: parseDate(get('order_date')),
      dispatch_by_date: parseDate(get('dispatch_by_date')),
      customer_name: get('name'),
      qty: parseInt(get('qty')) || 1,
      courier,
      tracking_number: (courier === 'Delhivery' ? parsePossibleScientific(get('master')) : get('tracking')) || null,
      sku: skuRaw,
      raw_status: rawStatus,
      promise_date: promiseDateStr,
      pincode: get('pincode'),
      city: city || null,
      state: get('state') || null,
      oda: get('oda') || null,
      transit_days: transitDays,
      days_left: daysLeft,
      urgency: computeUrgency(daysLeft),
      is_cancelled: isCancelledStatus(rawStatus) || isCancelledStatus(skuRaw),
      is_dispatched: isDispatchedStatus(rawStatus),
      is_priority: false,
    }

    results.push(order)
  }

  return results
}
