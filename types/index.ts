export type Courier = 'Bluedart' | 'Delhivery'

export type OrderStatus =
  | 'Pending'
  | 'Dispatched'
  | 'Cancelled'
  | 'Unfulfillable'

export type PlanDecision =
  | 'dispatch_today'
  | 'hold'
  | 'unfulfillable'
  | 'undecided'

export type UrgencyTier = 'CRITICAL' | 'TODAY' | 'PLAN' | 'HOLD'

export interface ParsedOrder {
  order_id: string
  order_date: string | null
  dispatch_by_date: string | null
  customer_name: string
  qty: number
  courier: Courier
  tracking_number: string | null
  sku: string
  raw_status: string
  promise_date: string | null
  pincode: string
  city: string | null
  state: string | null
  oda: string | null
  transit_days: number
  // computed
  days_left: number | null
  urgency: UrgencyTier | null
  is_cancelled: boolean
  is_dispatched: boolean
  is_priority: boolean
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
  plan_decision: PlanDecision
  dispatched_at: string | null
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

export interface PicklistItem {
  sku: string
  courier: Courier
  qty: number
  order_count: number
}
