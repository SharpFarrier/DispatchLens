import { SkuMap, Platform } from '@/types'

// Detect platform from order ID pattern.
// Amazon:   xxx-xxxxxxx-xxxxxxx  (3-7-7 digits)
// Flipkart: starts with OD
// else:     Website
export function detectPlatform(orderId: string): Platform {
  const id = (orderId || '').trim()
  if (/^\d{3}-\d{7}-\d{7}$/.test(id)) return 'Amazon'
  if (/^OD/i.test(id)) return 'Flipkart'
  return 'Website'
}

// Build fast lookup maps from the SKU map table.
// Keyed lowercase for case-insensitive matching.
export function buildSkuLookup(maps: SkuMap[]) {
  const amazon = new Map<string, string>()
  const flipkart = new Map<string, string>()
  const website = new Map<string, string>()
  const other = new Map<string, string>()
  const other2 = new Map<string, string>()
  for (const m of maps) {
    if (m.amazon_sku) amazon.set(m.amazon_sku.trim().toLowerCase(), m.master_sku)
    if (m.flipkart_sku) flipkart.set(m.flipkart_sku.trim().toLowerCase(), m.master_sku)
    if (m.website_sku) website.set(m.website_sku.trim().toLowerCase(), m.master_sku)
    if (m.other_sku) other.set(m.other_sku.trim().toLowerCase(), m.master_sku)
    if (m.other_sku_2) other2.set(m.other_sku_2.trim().toLowerCase(), m.master_sku)
  }
  return { amazon, flipkart, website, other, other2 }
}

export type SkuLookup = ReturnType<typeof buildSkuLookup>

// Resolve an order's platform SKU to the canonical Master/barcode SKU.
// Returns null if no mapping found.
export function resolveBarcodeSku(orderId: string, platformSku: string, lookup: SkuLookup): string | null {
  const platform = detectPlatform(orderId)
  const key = (platformSku || '').trim().toLowerCase()
  if (!key) return null
  let master: string | undefined
  if (platform === 'Amazon') master = lookup.amazon.get(key)
  else if (platform === 'Flipkart') master = lookup.flipkart.get(key)
  else master = lookup.website.get(key)
  // Fallback: if not found in the detected platform, try all (handles platform mis-detection)
  if (!master) master = lookup.amazon.get(key) || lookup.flipkart.get(key) || lookup.website.get(key) || lookup.other.get(key) || lookup.other2.get(key)
  return master || null
}
