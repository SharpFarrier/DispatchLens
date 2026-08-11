// Settlement parsers ported from ReconLens (battle-tested column mappings).
// Amazon: MTR/flat-file TSV (.txt), deduped by settlement-id.
// Flipkart: settlement .xlsx ("Orders" sheet), deduped by NEFT ID.

export interface SettlementRow {
  platform: 'amazon' | 'flipkart' | 'website'
  order_id: string | null
  order_item_code: string | null
  sku: string | null
  amount: number
  transaction_type: string | null
  amount_description: string | null
  dedup_key: string          // settlement-id (amazon) / neft_id (flipkart) / payment-id (aggregator)
  settlement_date: string | null
  raw: Record<string, unknown>
}

export interface ParsedFile {
  platform: 'amazon' | 'flipkart' | 'website'
  rows: SettlementRow[]
  dedupIds: string[]         // all distinct settlement-ids / neft-ids / payment-ids in the file
}

// ── TSV parser (Amazon flat file) ──
function parseTSV(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter(l => l.trim())
  if (!lines.length) return []
  const headers = lines[0].split('\t').map(h => h.trim())
  return lines.slice(1).map(line => {
    const vals = line.split('\t')
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = (vals[i] || '').trim() })
    return row
  })
}

// Amazon: parse a .txt settlement flat-file into settlement lines.
export function parseAmazonText(text: string): ParsedFile {
  const raw = parseTSV(text)
  const dedupSet = new Set<string>()
  const rows: SettlementRow[] = []
  for (const r of raw) {
    const settleId = String(r['settlement-id'] || '').trim()
    if (settleId) dedupSet.add(settleId)
    // Keep only actual order/transaction lines (skip file header/summary rows without a settlement id).
    rows.push({
      platform: 'amazon',
      order_id: (r['order-id'] || '').trim() || null,
      order_item_code: (r['order-item-code'] || '').trim() || null,
      sku: (r['sku'] || '').trim() || null,
      amount: parseFloat(r['amount']) || 0,
      transaction_type: (r['transaction-type'] || '').trim() || null,
      amount_description: (r['amount-description'] || '').trim() || null,
      dedup_key: settleId,
      settlement_date: (r['deposit-date'] || r['settlement-start-date'] || '').trim() || null,
      raw: r,
    })
  }
  return { platform: 'amazon', rows, dedupIds: [...dedupSet] }
}

// ── Flipkart XLSX ──
// SheetJS is loaded on demand from CDN (no npm dependency added).
let xlsxPromise: Promise<unknown> | null = null
function loadXLSX(): Promise<unknown> {
  if (typeof window !== 'undefined' && (window as unknown as { XLSX?: unknown }).XLSX) {
    return Promise.resolve((window as unknown as { XLSX: unknown }).XLSX)
  }
  if (xlsxPromise) return xlsxPromise
  xlsxPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js'
    s.onload = () => resolve((window as unknown as { XLSX: unknown }).XLSX)
    s.onerror = () => reject(new Error('Failed to load spreadsheet reader (XLSX CDN)'))
    document.head.appendChild(s)
  })
  return xlsxPromise
}

type XLSXLike = {
  read: (data: ArrayBuffer, opts: { type: string }) => { SheetNames: string[]; Sheets: Record<string, unknown> }
  utils: { sheet_to_json: (ws: unknown, opts: { header: 1 }) => unknown[][] }
}

// Flipkart: parse a settlement .xlsx buffer into settlement lines.
export async function parseFlipkartBuffer(buf: ArrayBuffer): Promise<ParsedFile> {
  const XLSX = (await loadXLSX()) as XLSXLike
  const wb = XLSX.read(buf, { type: 'array' })
  const sheetName = wb.SheetNames.find(n => n === 'Orders') || wb.SheetNames[0]
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 })

  // Header row is detected by the presence of "Order item ID" (within first 5 rows).
  let hi = -1
  for (let i = 0; i < Math.min(grid.length, 5); i++) {
    if (grid[i] && grid[i].some(c => String(c || '').includes('Order item ID'))) { hi = i; break }
  }
  if (hi === -1) throw new Error('Flipkart file: could not find the "Order item ID" header row')

  const headers = grid[hi].map(h => String(h || '').trim().replace(/\n/g, ' ').replace(/\r/g, ''))
  const bankCol = headers.find(h => h.includes('Bank Settlement Value')) || ''

  const dedupSet = new Set<string>()
  const rows: SettlementRow[] = []
  for (const row of grid.slice(hi + 1)) {
    if (!row || row.length < 4) continue
    const obj: Record<string, unknown> = {}
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : '' })
    const oid = String(obj['Order item ID'] || '').trim()
    if (!oid || oid === 'Order item ID') continue
    const amt = parseFloat(String(obj[bankCol] || 0)) || 0
    const payDate = String(obj['Payment Date'] || '').trim()
    // Dedup per settlement LINE, not by NEFT ID. In newer Flipkart "disbursement" reports the
    // "NEFT ID" column holds a status (e.g. "DISBURSEMENT_CREATED") that repeats on every row,
    // which collapses a whole file to one dedup id and makes every later file look duplicate.
    // Order item ID + payment date + amount uniquely identifies a line across payouts/returns.
    const rowKey = `${oid}|${payDate}|${amt.toFixed(2)}`
    dedupSet.add(rowKey)
    rows.push({
      platform: 'flipkart',
      order_id: String(obj['Order ID'] || '').trim() || null,
      order_item_code: oid || null,
      sku: String(obj['Seller SKU'] || '').trim() || null,
      amount: amt,
      transaction_type: (v => (v === 'Customer Return' || v === 'Logistics Return') ? v : 'Order')(String(obj['Return Type'] ?? '').trim()),
      amount_description: null,
      dedup_key: rowKey,
      settlement_date: payDate || null,
      raw: obj,
    })
  }
  return { platform: 'flipkart', rows, dedupIds: [...dedupSet] }
}

// Read a File as text (Amazon) or ArrayBuffer (Flipkart).
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result || ''))
    r.onerror = () => reject(new Error('Read failed'))
    r.readAsText(file)
  })
}
export function readFileBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as ArrayBuffer)
    r.onerror = () => reject(new Error('Read failed'))
    r.readAsArrayBuffer(file)
  })
}

// ── CSV parser (handles quoted fields containing commas/newlines) ──
// Needed because Razorpay's `notes` column is a JSON blob full of commas.
function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let field = '', row: string[] = [], inQuotes = false
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++ } else inQuotes = false }
      else field += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',') { row.push(field); field = '' }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
      else field += c
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  const nonEmpty = rows.filter(r => r.some(v => v.trim() !== ''))
  if (!nonEmpty.length) return []
  const headers = nonEmpty[0].map(h => h.trim())
  return nonEmpty.slice(1).map(vals => {
    const o: Record<string, string> = {}
    headers.forEach((h, i) => { o[h] = (vals[i] ?? '').trim() })
    return o
  })
}

// Detect which aggregator a CSV is, from its header columns.
export function detectWebsiteAggregator(text: string): 'razorpay' | 'cashfree' | null {
  const firstLine = (text.split('\n')[0] || '').toLowerCase()
  if (firstLine.includes('order_id') && firstLine.includes('notes') && firstLine.includes('captured')) return 'razorpay'
  if (firstLine.includes('cashfree order id') || (firstLine.includes('order id') && firstLine.includes('payment mode'))) return 'cashfree'
  return null
}

// ── Razorpay CSV ──
// Join key = notes.merchant_order_id (the website order-id). Net = amount - fee - tax - amount_refunded.
// Amounts are in RUPEES. dedup by Razorpay payment id (`id`). Only captured payments count as paid.
export function parseRazorpayText(text: string): ParsedFile {
  const raw = parseCSV(text)
  const rows: SettlementRow[] = []
  const dedupSet = new Set<string>()
  for (const r of raw) {
    const payId = (r['id'] || '').trim()
    if (!payId) continue
    // Website order-id lives in the notes JSON as merchant_order_id.
    let orderId: string | null = null
    try { const n = JSON.parse(r['notes'] || '{}'); orderId = String(n.merchant_order_id || n.merchant_order_no || '').trim() || null } catch { orderId = null }
    const captured = (r['status'] || '').toLowerCase() === 'captured' || r['captured'] === '1'
    const gross = parseFloat(r['amount']) || 0
    const fee = parseFloat(r['fee']) || 0
    const tax = parseFloat(r['tax']) || 0
    const refunded = parseFloat(r['amount_refunded']) || 0
    const net = gross - fee - tax - refunded
    dedupSet.add(payId)
    rows.push({
      platform: 'website',
      order_id: orderId,
      order_item_code: null,
      sku: null,
      // Advance/prepaid online payment. Failed captures carry 0 so they never count as paid.
      amount: captured ? net : 0,
      transaction_type: 'advance',
      amount_description: 'razorpay',
      dedup_key: payId,
      settlement_date: (r['created_at'] || '').trim() || null,
      raw: r,
    })
  }
  return { platform: 'website', rows, dedupIds: [...dedupSet] }
}

// ── Cashfree CSV ──
// Join key = "Order Id" (already the website order-id, plain column). No fee/tax breakout,
// so net = Transaction Amount. dedup by "Cashfree Order ID". Only SUCCESS counts as paid.
export function parseCashfreeText(text: string): ParsedFile {
  const raw = parseCSV(text)
  const rows: SettlementRow[] = []
  const dedupSet = new Set<string>()
  for (const r of raw) {
    const cfId = (r['Cashfree Order ID'] || r['Reference Id'] || '').trim()
    const orderId = (r['Order Id'] || '').trim() || null
    const key = cfId || `${orderId}-${r['Transaction Time'] || ''}`
    if (!key) continue
    const success = (r['Transaction Status'] || '').toUpperCase() === 'SUCCESS' || r['Captured'] === '1'
    const amt = parseFloat(r['Transaction Amount'] || r['Order Amount']) || 0
    const refunded = (r['Refunded'] || '').toUpperCase() === 'TRUE'
    dedupSet.add(key)
    rows.push({
      platform: 'website',
      order_id: orderId,
      order_item_code: null,
      sku: null,
      amount: success ? (refunded ? 0 : amt) : 0,
      transaction_type: 'advance',
      amount_description: 'cashfree',
      dedup_key: key,
      settlement_date: (r['Transaction Time'] || '').trim() || null,
      raw: r,
    })
  }
  return { platform: 'website', rows, dedupIds: [...dedupSet] }
}
