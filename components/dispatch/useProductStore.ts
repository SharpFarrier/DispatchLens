'use client'
import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'

// ---- Types ----
export interface ProductFlags {
  id: string
  name: string
  category_id: string | null
  is_active: boolean
  colour: string | null
  notes: string | null
  created_at: string
  has_size: boolean
  has_mattress: boolean
  shape_id: string | null
  is_assembly: boolean
  has_colour: boolean
}
export interface Shape {
  id: string; name: string; slug: string; image_url: string | null; sort_order: number
}
export interface Variant {
  id: string; product_id: string; size: string | null; mattress: string | null
  is_active: boolean; is_assembly: boolean; has_colour: boolean
}
export interface BomItem {
  id: string; product_id: string; part_id: string; quantity: number
  size: string | null; mattress: string | null; parts?: { name: string } | null
}
export interface Part { id: string; name: string; is_active: boolean }
export interface Category { id: string; name: string; sort_order: number }

interface StoreData {
  products: ProductFlags[]
  shapes: Shape[]
  variants: Variant[]
  bom: BomItem[]
  parts: Part[]
  categories: Category[]
  loaded: boolean
}

// ---- Module-singleton cache (mirrors Zustand's shared, load-once behavior) ----
const cache: StoreData = {
  products: [], shapes: [], variants: [], bom: [], parts: [], categories: [], loaded: false,
}
let inflight: Promise<void> | null = null
const subscribers = new Set<() => void>()
function notify() { subscribers.forEach(fn => fn()) }

async function doReload() {
  const supabase = createClient()
  const [
    { data: products },
    { data: shapes },
    { data: variants },
    { data: bom },
    { data: parts },
    { data: categories },
  ] = await Promise.all([
    supabase.from('products_with_flags').select('*').eq('is_active', true).order('name'),
    supabase.from('product_shapes').select('*').order('sort_order'),
    supabase.from('product_variants').select('*').eq('is_active', true),
    supabase.from('bom_items').select('*, parts(name)'),
    supabase.from('parts').select('*').eq('is_active', true).order('name'),
    supabase.from('product_categories').select('*').order('sort_order'),
  ])
  cache.products = (products as ProductFlags[]) || []
  cache.shapes = (shapes as Shape[]) || []
  cache.variants = (variants as Variant[]) || []
  cache.bom = (bom as BomItem[]) || []
  cache.parts = (parts as Part[]) || []
  cache.categories = (categories as Category[]) || []
  cache.loaded = true
  notify()
}

async function load() {
  if (cache.loaded) return
  if (!inflight) inflight = doReload().finally(() => { inflight = null })
  return inflight
}

// ---- Pure selector helpers (operate on cache) ----
const SIZE_ORDER = ['Single 2.5ft', 'Single 3ft', 'Double 4ft', 'Queen 5ft', 'King 6ft']

function getProductsForCategory(categoryName: string): ProductFlags[] {
  const cat = cache.categories.find(c => c.name.toLowerCase() === categoryName.toLowerCase())
  if (!cat) return []
  return cache.products.filter(p => p.category_id === cat.id)
}

function getSizesForProduct(productId: string): string[] {
  const sizes = [...new Set(
    cache.variants.filter(v => v.product_id === productId && v.size).map(v => v.size as string)
  )]
  return sizes.sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b))
}

function getMattressOption(productId: string, size: string | null): string {
  const product = cache.products.find(p => p.id === productId)
  if (!product?.has_mattress) return 'none'
  const variant = cache.variants.find(v => v.product_id === productId && v.size === size)
  if (!variant) return 'both'
  if (variant.mattress === null) return 'both'
  return variant.mattress
}

function getVariant(productId: string, size: string | null = null, mattress: string | null = null): Variant | null {
  return cache.variants.find(v =>
    v.product_id === productId &&
    (v.size || null) === (size || null) &&
    (v.mattress || null) === (mattress || null)
  ) || null
}

function isVariantAssembly(productId: string, size: string | null = null, mattress: string | null = null): boolean {
  const productVariants = cache.variants.filter(v => v.product_id === productId && v.is_active)
  const exact = productVariants.find(v =>
    (v.size || null) === (size || null) &&
    (v.mattress || null) === (mattress || null)
  )
  if (exact) return exact.is_assembly
  const wildcard = productVariants.find(v =>
    (v.size || null) === (size || null) && v.mattress === null
  )
  if (wildcard) return wildcard.is_assembly
  return productVariants.some(v => v.is_assembly)
}

function variantHasColour(productId: string, size: string | null = null, mattress: string | null = null): boolean {
  const variant = getVariant(productId, size, mattress)
  if (!variant) return true
  return variant.has_colour
}

function getBomForProduct(productId: string, size: string | null = null, mattress: string | null = null): BomItem[] {
  const bom = cache.bom.filter(b => b.product_id === productId)
  if (!size && !mattress) {
    return bom.filter(b => !b.size && !b.mattress)
  }
  const exact = bom.filter(b =>
    (b.size || null) === (size || null) &&
    (b.mattress || null) === (mattress || null)
  )
  if (exact.length) return exact
  const sizeWildcard = bom.filter(b =>
    (b.size || null) === (size || null) && !b.mattress
  )
  if (sizeWildcard.length) return sizeWildcard
  return bom.filter(b => !b.size && !b.mattress)
}

function getShapeForProduct(productId: string): Shape | null {
  const product = cache.products.find(p => p.id === productId)
  if (!product?.shape_id) return null
  return cache.shapes.find(s => s.id === product.shape_id) || null
}

// ---- Hook: subscribes to cache, triggers load, exposes data + helpers ----
export function useProductStore() {
  const [, forceRender] = useState(0)

  useEffect(() => {
    const cb = () => forceRender(n => n + 1)
    subscribers.add(cb)
    void load()
    return () => { subscribers.delete(cb) }
  }, [])

  const reload = useCallback(async () => {
    cache.loaded = false
    await doReload()
  }, [])

  return {
    products: cache.products,
    shapes: cache.shapes,
    variants: cache.variants,
    bom: cache.bom,
    parts: cache.parts,
    categories: cache.categories,
    loaded: cache.loaded,
    load,
    reload,
    getProductsForCategory,
    getSizesForProduct,
    getMattressOption,
    getVariant,
    isVariantAssembly,
    variantHasColour,
    getBomForProduct,
    getShapeForProduct,
  }
}

// Shared constants (from lib/catalogue.js)
export const COLOURS = ['Black', 'White', 'Golden', 'Ivory']
export const SIZES = ['Single 2.5ft', 'Single 3ft', 'Double 4ft', 'Queen 5ft', 'King 6ft']
