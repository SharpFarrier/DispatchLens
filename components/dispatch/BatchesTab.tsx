'use client'
import { useState, useEffect, useCallback } from 'react'
import { sharePackedLabelsPDF, type LabelUnit } from './packedLabelGenerator'
import { Check, Download, ChevronDown, ChevronRight } from 'lucide-react'

// Admin-only register of generated barcode batches. Reads via /api/barcode-batches
// (service-role, admin-gated). A batch stores the exact printed sheet, so it can be
// re-downloaded after a refresh. Download is enabled once the batch is approved.

interface SkuLine { sku: string; descr: string | null; qty: number }
interface Batch {
  id: string; created_at: string; generator: string | null
  label_count: number; sku_count: number; line_count: number
  units: LabelUnit[]; sku_summary: SkuLine[]
  status: 'pending' | 'approved'; approved_at: string | null
}
type Filter = 'all' | 'pending' | 'approved'

const istDateTime = (iso: string) => new Date(iso).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
})

export default function BatchesTab() {
  const [rows, setRows] = useState<Batch[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    setErr('')
    try {
      const res = await fetch('/api/barcode-batches')
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Could not load batches') }
      const data = await res.json()
      setRows((data.rows || []) as Batch[])
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load batches') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const approve = async (id: string) => {
    setBusy(id)
    try {
      const res = await fetch('/api/barcode-batches', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Approve failed') }
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Approve failed') }
    finally { setBusy(null) }
  }

  const stamp = (iso: string) => iso.slice(0, 10)
  const downloadFull = (b: Batch) => sharePackedLabelsPDF(b.units || [], `batch-${stamp(b.created_at)}-${b.id.slice(0, 6)}.pdf`)
  const downloadSkuOnly = (b: Batch) => {
    const units: LabelUnit[] = []
    for (const l of (b.sku_summary || [])) for (let i = 0; i < l.qty; i++) units.push({ barcode: l.sku, descr: l.descr || undefined })
    return sharePackedLabelsPDF(units, `batch-${stamp(b.created_at)}-${b.id.slice(0, 6)}-sku.pdf`)
  }

  const list = rows.filter(b => filter === 'all' || b.status === filter)

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>Loading batches…</div>

  return (
    <div style={{ maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>Barcode Batches</h2>
        <div style={{ fontSize: 12.5, color: 'var(--text2)', marginTop: 3 }}>Every Generate run is saved here. Approve a batch, then download the exact label sheet to share.</div>
      </div>

      <div style={{ display: 'inline-flex', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 2, gap: 1, alignSelf: 'flex-start' }}>
        {(['all', 'pending', 'approved'] as Filter[]).map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{ border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, padding: '6px 13px', borderRadius: 6, background: filter === f ? 'var(--text)' : 'transparent', color: filter === f ? '#fff' : 'var(--text2)' }}>
            {f === 'all' ? 'All' : f === 'pending' ? 'Pending' : 'Approved'}
          </button>
        ))}
        <button onClick={load} style={{ border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, padding: '6px 11px', borderRadius: 6, background: 'transparent', color: 'var(--text3)' }}>↻</button>
      </div>

      {err && <div style={{ fontSize: 12.5, color: 'var(--critical)', background: 'var(--critical-bg)', padding: '9px 12px', borderRadius: 9 }}>{err}</div>}

      {list.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 44, color: 'var(--text3)', fontSize: 13 }}>No batches {filter === 'all' ? 'yet' : filter}.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {list.map(b => {
            const appr = b.status === 'approved'
            const isOpen = !!open[b.id]
            return (
              <div key={b.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 11, padding: '13px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{istDateTime(b.created_at)}</span>
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>by <b style={{ color: 'var(--text)' }}>{b.generator ? b.generator.split('@')[0] : '—'}</b></span>
                  <span style={{ flex: 1 }} />
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, borderRadius: 20, padding: '3px 9px', color: appr ? 'var(--green)' : 'var(--amber)', background: appr ? 'var(--green-soft)' : 'var(--today-bg)' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: appr ? 'var(--green)' : 'var(--amber)' }} />{appr ? 'Approved' : 'Pending approval'}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 7 }}>
                  {[[b.label_count, b.label_count === 1 ? 'SW label' : 'SW labels'], [b.line_count, b.line_count === 1 ? 'SKU' : 'SKUs']].map(([n, l], i) => (
                    <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text2)', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px' }}><b style={{ color: 'var(--text)' }}>{n}</b> {l}</span>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 11, flexWrap: 'wrap' }}>
                  {!appr ? (
                    <>
                      <button onClick={() => approve(b.id)} disabled={busy === b.id} style={{ ...btn, background: 'var(--green)', color: '#fff' }}><Check size={14} /> {busy === b.id ? 'Approving…' : 'Approve'}</button>
                      <button disabled style={{ ...btn, background: 'var(--surface2)', color: 'var(--text3)', border: '1px solid var(--border)', cursor: 'not-allowed' }}><Download size={14} /> Download labels</button>
                      <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>Approve to enable download</span>
                    </>
                  ) : (
                    <>
                      <button onClick={() => downloadFull(b)} style={{ ...btn, background: 'var(--accent)', color: '#fff' }}><Download size={14} /> Download labels</button>
                      <button onClick={() => downloadSkuOnly(b)} style={{ ...btn, background: 'var(--surface2)', color: 'var(--text2)', border: '1px solid var(--border)' }}><Download size={14} /> SKU stickers only</button>
                    </>
                  )}
                  <button onClick={() => setOpen(o => ({ ...o, [b.id]: !o[b.id] }))} style={{ ...btn, background: 'transparent', color: 'var(--text3)', padding: '8px 8px' }}>
                    {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />} SKUs
                  </button>
                </div>

                {isOpen && (
                  <div style={{ marginTop: 11, borderTop: '1px dashed var(--border)', paddingTop: 10 }}>
                    {(b.sku_summary || []).map((l, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{l.sku}</span>
                        <span style={{ color: 'var(--text2)', fontWeight: 600 }}>× {l.qty}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const btn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600, borderRadius: 8, padding: '8px 13px' }
