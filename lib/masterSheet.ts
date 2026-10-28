// Shared live read of the Honey Touch master database Google Sheet (shared "anyone
// with the link"). Used by /api/recon/master (category + BAU lookup for the Charges
// view) and /api/recon/price-sync (snapshot sheet prices into the dated recon_prices
// history). Keeping one parser here stops the two routes drifting apart.

export interface SheetProd { category: string; newPrice: number | null; productName: string; masterSku: string }

const SHEET_ID = '11UPpzvWyFdMYOasRFevpS4-rP6e8a0pOWKdW1g5vTwU'
const GID = '0'
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${GID}`

// Normalise a sku to a match key: strip all whitespace, uppercase. Order SKUs
// sometimes carry stray spaces (e.g. "L1-B-BL-RX- 3"); sheet SKUs are clean.
export const normSku = (s: string | null) => (s || '').replace(/\s+/g, '').toUpperCase()

const num = (v: string): number | null => { const n = parseFloat((v || '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n }

// Minimal quote-aware CSV parser (handles quoted commas like "₹14,699.00").
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false }
      else field += c
    } else if (c === '"') inQ = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

// SKU → product, keyed by EVERY alias (master / amazon / flipkart / website),
// normalised, so an order's platform SKU resolves to its category and listing price.
export async function fetchSheetSkus(): Promise<Record<string, SheetProd>> {
  const res = await fetch(CSV_URL, { cache: 'no-store' })
  if (!res.ok) throw new Error(`sheet fetch failed: ${res.status}`)
  const rows = parseCsv(await res.text())
  if (rows.length < 2) return {}
  const header = rows[0].map(h => h.trim().toLowerCase())
  const col = (names: string[]) => { for (let i = 0; i < header.length; i++) if (names.includes(header[i])) return i; return -1 }
  const ci = col(['catogory', 'category']), mi = col(['master sku']), ai = col(['amazon sku'])
  const fi = col(['flipkart sku']), wi = col(['website sku']), pi = col(['new price']), ni = col(['product name'])
  const skus: Record<string, SheetProd> = {}
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row.some(c => (c || '').trim())) continue
    const get = (i: number) => (i >= 0 && i < row.length) ? (row[i] || '').trim() : ''
    const prod: SheetProd = { category: get(ci), newPrice: num(get(pi)), productName: get(ni), masterSku: get(mi) }
    for (const s of [get(mi), get(ai), get(fi), get(wi)]) { const k = normSku(s); if (k) skus[k] = prod }
  }
  return skus
}

// Full per-row read of the sheet (one entry per finished SKU), for the Product Sync —
// upserting new SKUs into the catalogue. Rows without a Master SKU are skipped.
export interface SheetRow {
  productName: string; description: string; category: string; masterSku: string
  amazonSku: string; amazonAsin: string; flipkartSku: string; websiteSku: string; status: string
}
export async function fetchSheetRows(): Promise<SheetRow[]> {
  const res = await fetch(CSV_URL, { cache: 'no-store' })
  if (!res.ok) throw new Error(`sheet fetch failed: ${res.status}`)
  const rows = parseCsv(await res.text())
  if (rows.length < 2) return []
  const header = rows[0].map(h => h.trim().toLowerCase())
  const col = (names: string[]) => { for (let i = 0; i < header.length; i++) if (names.includes(header[i])) return i; return -1 }
  const ni = col(['product name']), di = col(['product description', 'description']), ci = col(['catogory', 'category']), mi = col(['master sku'])
  const ai = col(['amazon sku']), xi = col(['amazon asin']), fi = col(['flipkart sku']), wi = col(['website sku']), si = col(['status'])
  const out: SheetRow[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row.some(c => (c || '').trim())) continue
    const get = (i: number) => (i >= 0 && i < row.length) ? (row[i] || '').trim() : ''
    const masterSku = get(mi)
    if (!masterSku) continue
    out.push({ productName: get(ni), description: get(di), category: get(ci), masterSku, amazonSku: get(ai), amazonAsin: get(xi), flipkartSku: get(fi), websiteSku: get(wi), status: get(si) })
  }
  return out
}
