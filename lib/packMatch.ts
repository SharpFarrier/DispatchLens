import { PRODUCT_SHAPE, SIZE_PACKED_TO_SUPPLY } from './catalogueMap'

// Frame-identity match for Pack & Map. A scanned frame piece must match the
// scanned serialized box label's SKU on shape + size + colour. Mattress is
// decided at packing (not built into the frame), so it is never compared.
// A table SKU (mattress = 'Table') has no frame and is refused outright.

export interface MatchFrame { shape: string | null; size: string | null; colour: string | null }
export interface MatchSku { product: string | null; size: string | null; fcolor: string | null; mattress: string | null }
export interface MatchResult { ok: boolean; reasons: string[]; table: boolean }

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase()

export function computeMatch(frame: MatchFrame, meta: MatchSku): MatchResult {
  if (norm(meta.mattress) === 'table') {
    return { ok: false, table: true, reasons: ['This is a table SKU — tables have no frame to map.'] }
  }
  const reasons: string[] = []
  if (meta.fcolor && frame.colour && norm(meta.fcolor) !== norm(frame.colour)) {
    reasons.push(`Colour: frame ${frame.colour} ≠ SKU ${meta.fcolor}`)
  }
  const expShape = meta.product ? PRODUCT_SHAPE[meta.product] : undefined
  if (expShape && frame.shape && norm(expShape) !== norm(frame.shape)) {
    reasons.push(`Shape: frame ${frame.shape} ≠ SKU ${expShape}`)
  }
  const expSize = meta.size ? SIZE_PACKED_TO_SUPPLY[meta.size] : undefined
  if (expSize && frame.size && norm(expSize) !== norm(frame.size)) {
    reasons.push(`Size: frame ${frame.size} ≠ SKU ${expSize}`)
  }
  return { ok: reasons.length === 0, table: false, reasons }
}
