export type Courier = 'Bluedart' | 'Delhivery'
export type PlanDecision = 'dispatch_today' | 'hold' | 'unfulfillable' | 'undecided'
export type UrgencyTier = 'CRITICAL' | 'TODAY' | 'PLAN' | 'HOLD'
export type UnfulfillableReason = 'Not ready' | 'No stock available' | 'Other'
export type AccessStatus = 'pending' | 'approved' | 'rejected'

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
  can_users: boolean
  requested_at: string
  reviewed_at: string | null
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
  unfulfillable_reason: UnfulfillableReason | null
  unfulfillable_note: string | null
  target_dispatch_date: string | null
  manual_cancelled: boolean
  manual_cancelled_at: string | null
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
