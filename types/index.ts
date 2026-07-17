export type Courier = 'Bluedart' | 'Delhivery'
export type PlanDecision = 'scheduled' | 'hold' | 'unfulfillable' | 'undecided'
export type UrgencyTier = 'CRITICAL' | 'TODAY' | 'PLAN' | 'HOLD'
export type UnfulfillableReason = 'Not ready' | 'No stock available' | 'Other'
export type AccessStatus = 'pending' | 'approved' | 'rejected'
export type Platform = 'Amazon' | 'Flipkart' | 'Website'
export interface UserAccess {
  id: string
  email: string
  user_id: string | null
  status: AccessStatus
  can_import: boolean
  can_plan: boolean
  can_review: boolean
  can_picklist: boolean
  can_eod: boolean
  can_dispatched: boolean
  can_returns: boolean
  can_users: boolean
  can_warehouse: boolean
  can_wh_stock: boolean
  can_wh_coating: boolean
  can_wh_picking: boolean
  can_wh_inventory: boolean
  can_wh_barcodes: boolean
  can_wh_pack_generate: boolean
  can_wh_pack_scan: boolean
  can_wh_pack_inventory: boolean
  can_wh_pack_rto: boolean
  can_wh_pack_units: boolean
  requested_at: string
  reviewed_at: string | null
  created_at: string
  updated_at: string
}
export interface SkuMap {
  id: string
  master_sku: string
  product_name: string | null
  amazon_sku: string | null
  amazon_asin: string | null
  flipkart_sku: string | null
  website_sku: string | null
  other_sku: string | null
  other_sku_2: string | null
  created_at: string
  updated_at: string
}
export interface ParsedOrder {
  order_id: string
  order_date: string | null
  dispatch_by_date: string | null
  customer_name: string
  qty: number
  courier: Courier
  tracking_number: string | null
  lr_number: string | null
  sku: string
  raw_status: string
  promise_date: string | null
  pincode: string
  city: string | null
  state: string | null
  oda: string | null
  transit_days: number
  days_left: number | null
  urgency: UrgencyTier | null
  is_cancelled: boolean
  is_dispatched: boolean
  is_priority: boolean
  // ── Invoice + contact tail (new import columns; both goals: comms + QuickShip) ──
  contact_number: string | null
  unit_price: number | null
  taxable_value: number | null
  tax_amount: number | null
  shipping_charge: number | null
  shipping_taxable: number | null
  shipping_tax: number | null
  igst: number | null
  sgst: number | null
  cgst: number | null
  ship_address: string | null
}
export interface DBOrder {
  id: string
  session_id: string
  order_id: string
  order_date: string | null
  dispatch_by_date: string | null
  customer_name: string
  qty: number
  courier: Courier
  tracking_number: string | null
  tracking_status: string | null
  tracking_label: string | null
  tracking_last_update: string | null
  tracking_synced_at: string | null
  lr_number: string | null
  sku: string
  barcode_sku: string | null
  sku_mapped: boolean
  scan_verified: boolean
  scan_verified_at: string | null
  scanned_barcode: string | null
  manifested_at: string | null
  raw_status: string
  promise_date: string | null
  pincode: string
  city: string | null
  state: string | null
  oda: string | null
  transit_days: number
  days_left: number | null
  urgency: UrgencyTier | null
  is_cancelled: boolean
  is_dispatched: boolean
  is_priority: boolean
  plan_decision: PlanDecision
  scheduled_date: string | null
  dispatched_at: string | null
  unfulfillable_reason: UnfulfillableReason | null
  unfulfillable_note: string | null
  target_dispatch_date: string | null
  manual_cancelled: boolean
  manual_cancelled_at: string | null
  // ── Invoice + contact tail (import) ──
  contact_number: string | null
  unit_price: number | null
  taxable_value: number | null
  tax_amount: number | null
  shipping_charge: number | null
  shipping_taxable: number | null
  shipping_tax: number | null
  igst: number | null
  sgst: number | null
  cgst: number | null
  ship_address: string | null
  // ── CallLens (call-center) ──
  assigned_caller: string | null
  whatsapp_sent: boolean
  whatsapp_sent_at: string | null
  last_disposition: string | null
  last_disposition_at: string | null
  created_at: string
  updated_at: string
}
export interface DispatchSession {
  id: string
  created_by: string
  session_date: string
  label: string
  is_eod_done: boolean
  total_orders: number
  dispatched_count: number
  held_count: number
  unfulfillable_count: number
  created_at: string
  updated_at: string
}
