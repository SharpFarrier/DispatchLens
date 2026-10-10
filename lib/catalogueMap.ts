// Catalogue vocabulary bridges between the three systems the Product Master feeds.
// Product Master uses human sizes ("Single 3ft"); the barcode generator (packed_skus)
// uses codes ("3x6"). Mattress wording is carried through verbatim, with a two-way
// synonym map so the generator treats older type-worded rows and new With/Without
// rows as equivalent where they overlap.

export const PM_SIZES = ['Single 2.5ft', 'Single 3ft', 'Double 4ft', 'Queen 5ft', 'King 6ft'] as const
export type PmSize = typeof PM_SIZES[number]

export const COLOURS = ['Black', 'White', 'Golden', 'Ivory'] as const

export const COLOUR_HEX: Record<string, string> = {
  Black: '#1a1a1a', White: '#f0ede8', Golden: '#c9a227', Ivory: '#f5f0e0',
}

// Product Master size  →  packed_skus size code. (Confirmed mapping.)
export const SIZE_PM_TO_PACKED: Record<string, string> = {
  'Single 2.5ft': '2.5x6',
  'Single 3ft': '3x6',
  'Double 4ft': '4x6.25',
  'Queen 5ft': '5x6.25',
  'King 6ft': '6x6.25',
}

// Translate a Product-Master size to the generator's code. Unknown sizes pass through.
export function packedSize(pmSize: string | null): string | null {
  if (!pmSize) return null
  return SIZE_PM_TO_PACKED[pmSize] ?? pmSize
}

export const MATTRESS_OPTIONS = ['With Mattress', 'Without Mattress'] as const

// Two-way mattress synonyms. The generator's older rows use type words; the wizard
// writes With/Without verbatim. mattressGroup() lets callers treat them as one axis.
const MATTRESS_WITHOUT = ['Without Mattress', 'Metal', 'Frame Only', 'Frame']
const MATTRESS_WITH = ['With Mattress', 'Single Layer', 'Double Layer', 'Ortho Tri', 'Ortho', 'Foam']

export function mattressGroup(value: string | null): 'with' | 'without' | 'other' {
  if (!value) return 'other'
  const v = value.trim().toLowerCase()
  if (MATTRESS_WITHOUT.some(m => m.toLowerCase() === v)) return 'without'
  if (MATTRESS_WITH.some(m => m.toLowerCase() === v)) return 'with'
  return 'other'
}

// True when two mattress labels mean the same thing across the two vocabularies.
export function mattressEquivalent(a: string | null, b: string | null): boolean {
  if ((a || '') === (b || '')) return true
  const ga = mattressGroup(a), gb = mattressGroup(b)
  return ga !== 'other' && ga === gb
}
