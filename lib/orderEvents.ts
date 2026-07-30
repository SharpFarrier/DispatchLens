// Shared helper to append an event to an order's lifecycle timeline
// (dispatch_order_events, shown in the Order History panel).
//
// The /api/events route records the acting user (created_by / created_by_email)
// server-side from the auth session, so callers never pass identity — just the
// order, a type, a title, and an optional note.
//
// event_type should be one the history panel knows how to colour. Current set:
//   import · scheduled · rescheduled · hold · unfulfillable · cancelled ·
//   dispatched · target_set · note · tracking · return
// (unknown types still render, just with the default 'note' styling).
//
// Fire-and-forget: logging must never block or break the user's action, so this
// swallows errors. Await it only if you need ordering; otherwise call and move on.

export type OrderEventType =
  | 'import' | 'scheduled' | 'rescheduled' | 'hold' | 'unfulfillable'
  | 'cancelled' | 'dispatched' | 'target_set' | 'note' | 'tracking' | 'return'

export async function logOrderEvent(
  orderId: string,
  eventType: OrderEventType | string,
  title: string,
  note?: string | null,
): Promise<void> {
  if (!orderId || !eventType || !title) return
  try {
    await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId, event_type: eventType, title, note: note ?? null }),
    })
  } catch {
    /* timeline logging is best-effort — never surface to the user */
  }
}
