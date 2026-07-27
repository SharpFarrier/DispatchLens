// Settlement parsers ported from ReconLens (battle-tested column mappings).
// Amazon: MTR/flat-file TSV (.txt), deduped by settlement-id.
// Flipkart: settlement .xlsx ("Orders" sheet), deduped by NEFT ID.

export interface SettlementRow {
  platform: 'amazon' | 'flipkart'
  order_id: string | null
  order_item_code: string | null
  sku: string | null
  amount: number
  transaction_type: string | null
  amount_description: string | null
  dedup_key: string          // settlement-id (amazon) / neft_id (flipkart)
  settlement_date: string | null
  raw: Record<string, unknown>
}

export interface ParsedFile {
  platform: 'amazon' | 'flipkart'
  rows: SettlementRow[]
  dedupIds: string[]         // all distinct settlement-ids / neft-ids in the file
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
    const neft = String(obj['NEFT ID'] || '').trim()
    if (neft) dedupSet.add(neft)
    rows.push({
      platform: 'flipkart',
      order_id: String(obj['Order ID'] || '').trim() || null,
      order_item_code: oid || null,
      sku: String(obj['Seller SKU'] || '').trim() || null,
      amount: parseFloat(String(obj[bankCol] || 0)) || 0,
      transaction_type: (v => (v === 'Customer Return' || v === 'Logistics Return') ? v : 'Order')(String(obj['Return Type'] ?? '').trim()),
      amount_description: null,
      dedup_key: neft,
      settlement_date: String(obj['Payment Date'] || '') || null,
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
