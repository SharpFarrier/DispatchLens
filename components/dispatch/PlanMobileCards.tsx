'use client'
import type { DBOrder, PlanDecision } from '@/types'
import StatStrip, { type Stat } from '@/components/mobile/StatStrip'
import MobileActionBar from '@/components/mobile/MobileActionBar'
import { CheckCircle, PauseCircle, XCircle, Printer } from 'lucide-react'

export interface PlanMobileProps {
  orders: DBOrder[]
  stats: Stat[]
  urgencyChips: { key: string; label: string; count: number; active: boolean; onClick: () => void }[]
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onDecision: (orderId: string, decision: PlanDecision) => void
  onGenerate: () => void
  genBusy: boolean
  genLabel: string
  daysLeft: (o: DBOrder) => number | null
  urgencyTone: (o: DBOrder) => 'critical' | 'today' | 'ok' | 'plan'
  platformOf: (o: DBOrder) => string
}

const TONE_BADGE: Record<string, { fg: string; bg: string; label: string }> = {
  critical: { fg: 'var(--critical)', bg: 'var(--critical-bg)', label: 'Critical' },
  today: { fg: 'var(--today)', bg: 'var(--today-bg)', label: 'Today' },
  ok: { fg: 'var(--dispatched)', bg: 'var(--dispatched-bg)', label: 'Scheduled' },
  plan: { fg: 'var(--text2)', bg: 'var(--bg2)', label: 'Plan' },
}

export default function PlanMobileCards(p: PlanMobileProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
      <StatStrip stats={p.stats} />

      {/* urgency filter chips — scroll in their own row */}
      <div style={{ position: 'relative' as const, margin: '0 -14px' }}>
        <div className="no-scrollbar" style={{ display: 'flex', gap: 7, overflowX: 'auto', padding: '0 14px' }}>
          {p.urgencyChips.map(c => (
            <button key={c.key} onClick={c.onClick}
              style={{ flex: '0 0 auto', padding: '7px 13px', borderRadius: 20, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' as const, border: `1px solid ${c.active ? 'var(--ink, #1B1917)' : 'var(--border)'}`, background: c.active ? 'var(--ink, #1B1917)' : 'var(--surface)', color: c.active ? '#fff' : 'var(--text2)', cursor: 'pointer' }}>
              {c.label} <span style={{ opacity: 0.6, fontWeight: 500 }}>{c.count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* cards */}
      {p.orders.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>No orders in this view.</div>
      ) : p.orders.map(o => {
        const tone = p.urgencyTone(o)
        const b = TONE_BADGE[tone]
        const dl = p.daysLeft(o)
        const sel = p.selectedIds.has(o.id)
        return (
          <div key={o.id} onClick={() => p.onToggleSelect(o.id)}
            style={{ background: 'var(--surface)', border: `1px solid ${sel ? 'var(--accent)' : 'var(--border)'}`, boxShadow: sel ? '0 0 0 1px var(--accent)' : 'none', borderRadius: 14, padding: 12, cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7, flexWrap: 'wrap' as const }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 6, color: b.fg, background: b.bg, whiteSpace: 'nowrap' as const }}>
                {dl !== null && dl < 0 ? `${dl}d overdue` : b.label}
              </span>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text3)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 7px' }}>{p.platformOf(o)}</span>
              {sel && <CheckCircle size={15} style={{ marginLeft: 'auto', color: 'var(--accent)' }} />}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>{o.order_id}</div>
            <div style={{ fontSize: 13.5, fontWeight: 500, margin: '2px 0 7px', lineHeight: 1.3 }}>{o.sku}{o.customer_name ? ` · ${o.customer_name}` : ''}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: '4px 10px', fontSize: 12, color: 'var(--text3)' }}>
              <span>Qty <b style={{ color: 'var(--text2)', fontWeight: 600 }}>{o.qty ?? 1}</b></span>
              {o.pincode && <span>📍 <b style={{ color: 'var(--text2)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{o.pincode}</b></span>}
              {o.courier && <span>{o.courier}</span>}
              {o.promise_date && <span>Promise <b style={{ color: 'var(--text2)', fontWeight: 600 }}>{o.promise_date}</b></span>}
            </div>
            {/* decision actions */}
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }} onClick={e => e.stopPropagation()}>
              <button onClick={() => p.onDecision(o.id, 'scheduled')} style={{ flex: 1, padding: '8px', borderRadius: 8, border: '1px solid var(--dispatched)', background: 'var(--surface)', color: 'var(--dispatched)', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}><CheckCircle size={13} /> Dispatch</button>
              <button onClick={() => p.onDecision(o.id, 'hold')} style={{ flex: 1, padding: '8px', borderRadius: 8, border: '1px solid var(--border2, var(--border))', background: 'var(--surface)', color: 'var(--today)', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}><PauseCircle size={13} /> Hold</button>
              <button onClick={() => p.onDecision(o.id, 'unfulfillable')} style={{ flex: '0 0 auto', padding: '8px 10px', borderRadius: 8, border: '1px solid #fecaca', background: 'var(--surface)', color: 'var(--critical)', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}><XCircle size={13} /></button>
            </div>
          </div>
        )
      })}

      <MobileActionBar selectedCount={p.selectedIds.size} label={p.genBusy ? 'Generating…' : p.genLabel} onClick={p.onGenerate} disabled={p.genBusy || p.orders.length === 0}>
        <Printer size={16} style={{ display: 'none' }} />
      </MobileActionBar>
    </div>
  )
}
