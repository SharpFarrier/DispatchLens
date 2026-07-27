'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { Upload, FileText, AlertTriangle, IndianRupee, RefreshCw } from 'lucide-react'
import {
  parseAmazonText, parseFlipkartBuffer, readFileText, readFileBuffer,
  type SettlementRow,
} from '@/lib/settlements'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }
type Tab = 'inbox' | 'orders'

interface UploadRow { id: string; platform: string; file_name: string; row_count: number; dedup_ids: string[]; created_at: string }
interface FileAgg { total: number; orders: Set<string>; depositDate: string | null; periodStart: string | null; periodEnd: string | null }
type FileAggMap = Record<string, { total: number; orders: number; depositDate: string | null; periodStart: string | null; periodEnd: string | null }>

export default function ReconSection() {
  const supabase = createClient()
  const [tab, setTab] = useState<Tab>('inbox')
  const [uploads, setUploads] = useState<UploadRow[]>([])
  const [fileAgg, setFileAgg] = useState<FileAggMap>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'warn' | 'err'; text: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [totals, setTotals] = useState<{ amazon: number; flipkart: number; orders: number }>({ amazon: 0, flipkart: 0, orders: 0 })

  const flash = (type: 'ok' | 'warn' | 'err', text: string) => setMsg({ type, text })

  const loadInbox = useCallback(async () => {
    setLoading(true)
    const { data: up } = await supabase.from('settlement_uploads').select('*').order('created_at', { ascending: false })
    const upRows = (up as UploadRow[]) || []
    setUploads(upRows)
    // Lightweight totals
    const { count: azCount } = await supabase.from('settlements').select('id', { count: 'exact', head: true }).eq('platform', 'amazon')
    const { count: fkCount } = await supabase.from('settlements').select('id', { count: 'exact', head: true }).eq('platform', 'flipkart')
    setTotals(t => ({ ...t, amazon: azCount || 0, flipkart: fkCount || 0 }))

    // Per-file settlement details: total settled amount, distinct order count,
    // deposit/payment date, and (Amazon) settlement period — pulled from stored rows.
    const rows = await fetchAllRows<{ uploaded_file: string | null; amount: number | null; order_id: string | null; settlement_date: string | null; platform: string; raw: Record<string, unknown> | null }>((from, to) =>
      supabase.from('settlements').select('uploaded_file, amount, order_id, settlement_date, platform, raw').range(from, to))
    const byFile: Record<string, FileAgg> = {}
    for (const r of rows || []) {
      const key = r.uploaded_file || '(unknown)'
      const a = byFile[key] || { total: 0, orders: new Set<string>(), depositDate: null, periodStart: null, periodEnd: null }
      a.total += r.amount || 0
      if (r.order_id) a.orders.add(r.order_id)
      if (!a.depositDate && r.settlement_date) a.depositDate = r.settlement_date
      // Amazon period from raw (settlement-start-date / settlement-end-date), first seen.
      const raw = r.raw || {}
      if (!a.periodStart && raw['settlement-start-date']) a.periodStart = String(raw['settlement-start-date'])
      if (!a.periodEnd && raw['settlement-end-date']) a.periodEnd = String(raw['settlement-end-date'])
      byFile[key] = a
    }
    const agg: Record<string, { total: number; orders: number; depositDate: string | null; periodStart: string | null; periodEnd: string | null }> = {}
    for (const k in byFile) agg[k] = { total: byFile[k].total, orders: byFile[k].orders.size, depositDate: byFile[k].depositDate, periodStart: byFile[k].periodStart, periodEnd: byFile[k].periodEnd }
    setFileAgg(agg)
    setLoading(false)
  }, [supabase])
  useEffect(() => { void loadInbox() }, [loadInbox])

  // Insert settlement rows in chunks (Supabase caps payload size). Loud on error.
  const insertRows = async (rows: SettlementRow[], fileName: string) => {
    const CHUNK = 300
    let inserted = 0
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK).map(r => ({
        platform: r.platform, order_id: r.order_id, order_item_code: r.order_item_code,
        sku: r.sku, amount: r.amount, transaction_type: r.transaction_type,
        amount_description: r.amount_description, dedup_key: r.dedup_key,
        settlement_date: r.settlement_date, raw: r.raw, uploaded_file: fileName,
      }))
      console.log(`[recon] inserting rows ${i}–${i + slice.length} of ${rows.length}…`)
      const { data, error, status } = await supabase.from('settlements').insert(slice).select('id')
      if (error) {
        console.error('[recon] INSERT ERROR', { status, message: error.message, details: (error as { details?: string }).details, hint: (error as { hint?: string }).hint, code: (error as { code?: string }).code })
        throw new Error(`insert failed at row ${i} (HTTP ${status}): ${error.message}${(error as { hint?: string }).hint ? ' · ' + (error as { hint?: string }).hint : ''}`)
      }
      inserted += (data?.length ?? slice.length)
      console.log(`[recon] ok, total inserted so far: ${inserted}`)
    }
    console.log(`[recon] insertRows DONE — ${inserted} rows for ${fileName}`)
    return inserted
  }

  const handleFiles = async (platform: 'amazon' | 'flipkart', files: File[]) => {
    console.log('[recon] handleFiles called', { platform, count: files?.length })
    if (!files || !files.length) { console.log('[recon] no files'); return }
    setBusy(true); setMsg(null)
    try {
      const { data: auth, error: authErr } = await supabase.auth.getUser()
      const email = auth?.user?.email ?? null
      console.log('[recon] auth user:', email, authErr ? `(authErr: ${authErr.message})` : '')
      if (!auth?.user) {
        flash('err', 'Not signed in (no auth session) — settlement insert would be blocked by RLS. Try reloading / re-logging in.')
        setBusy(false); return
      }
      // Existing dedup ids across all prior uploads for this platform.
      const priorIds = new Set<string>()
      uploads.filter(u => u.platform === platform).forEach(u => (u.dedup_ids || []).forEach(id => priorIds.add(String(id))))

      let filesLoaded = 0, filesSkipped = 0, rowsLoaded = 0
      for (const f of files) {
        console.log('[recon] processing file:', f.name, f.size, 'bytes')
        let parsed
        try {
          if (platform === 'amazon') {
            if (!/\.(txt|csv|tsv)$/i.test(f.name)) { flash('warn', `Skipped ${f.name} — expected a .txt/.csv/.tsv flat-file`); continue }
            parsed = parseAmazonText(await readFileText(f))
          } else {
            if (!/\.xlsx$/i.test(f.name)) { flash('warn', `Skipped ${f.name} — expected a .xlsx`); continue }
            parsed = await parseFlipkartBuffer(await readFileBuffer(f))
          }
        } catch (pe) {
          console.error('[recon] PARSE ERROR', pe)
          flash('err', `Parse failed for ${f.name}: ${(pe as Error).message}`)
          continue
        }
        console.log('[recon] parsed', { rows: parsed.rows.length, dedupIds: parsed.dedupIds.length })

        const fileIds = parsed.dedupIds.map(String)
        const allDup = fileIds.length > 0 && fileIds.every(id => priorIds.has(id))
        if (allDup) { filesSkipped++; flash('warn', `${f.name}: already uploaded — skipped`); continue }

        const insertedCount = await insertRows(parsed.rows, f.name)
        console.log('[recon] inserting settlement_uploads registry row…')
        const { error: upErr } = await supabase.from('settlement_uploads').insert({
          platform, file_name: f.name, dedup_ids: fileIds, row_count: parsed.rows.length, uploaded_by_email: email,
        })
        if (upErr) { console.error('[recon] settlement_uploads insert error', upErr); throw new Error(`file loaded (${insertedCount} rows) but registry insert failed: ${upErr.message}`) }

        fileIds.forEach(id => priorIds.add(id))
        filesLoaded++; rowsLoaded += parsed.rows.length
      }
      if (filesLoaded) flash('ok', `Loaded ${filesLoaded} file(s), ${rowsLoaded.toLocaleString()} settlement rows${filesSkipped ? ` · skipped ${filesSkipped} duplicate` : ''}`)
      else if (filesSkipped) flash('warn', `All ${filesSkipped} file(s) were duplicates — nothing loaded`)
      else flash('warn', 'Nothing was loaded (no rows parsed). Check the file format.')
      await loadInbox()
    } catch (e) {
      console.error('[recon] handleFiles fatal', e)
      flash('err', 'Error: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const bannerStyle = msg?.type === 'ok' ? { color: 'var(--dispatched)', bg: 'var(--dispatched-bg)', bd: '#bbf7d0' }
    : msg?.type === 'warn' ? { color: 'var(--today)', bg: 'var(--today-bg)', bd: '#fed7aa' }
    : { color: 'var(--critical)', bg: 'var(--critical-bg)', bd: '#fecaca' }

  return (
    <div style={{ maxWidth: 1280 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        {(['inbox', 'orders'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 13, fontWeight: 700,
            background: tab === t ? 'var(--accent)' : 'var(--surface)', color: tab === t ? '#fff' : 'var(--text2)',
          }}>{t === 'inbox' ? 'Settlement Inbox' : 'Orders'}</button>
        ))}
        <button onClick={() => loadInbox()} style={{ marginLeft: 'auto', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {msg && (
        <div style={{ marginBottom: 16, borderRadius: 8, border: `1px solid ${bannerStyle.bd}`, background: bannerStyle.bg, color: bannerStyle.color, padding: '10px 14px', fontSize: 13, fontWeight: 600 }}>
          {msg.text}
        </div>
      )}

      {tab === 'inbox' ? (
        <InboxView uploads={uploads} totals={totals} fileAgg={fileAgg} loading={loading} busy={busy} onFiles={handleFiles} />
      ) : (
        <OrdersView />
      )}
    </div>
  )
}

// ── Settlement Inbox ──
function InboxView({ uploads, totals, fileAgg, loading, busy, onFiles }: {
  uploads: UploadRow[]; totals: { amazon: number; flipkart: number }; fileAgg: FileAggMap; loading: boolean; busy: boolean;
  onFiles: (p: 'amazon' | 'flipkart', f: File[]) => void
}) {
  const money = (n: number) => Math.round(n).toLocaleString('en-IN')
  const fmtD = (d: string | null) => { if (!d) return '—'; const s = String(d); const iso = s.includes('.') && /^\d{2}\.\d{2}\.\d{4}/.test(s) ? s.slice(6,10)+'-'+s.slice(3,5)+'-'+s.slice(0,2) : s; const dt = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso); return isNaN(dt.getTime()) ? s.slice(0,10) : dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) }
  const grand = Object.values(fileAgg).reduce((sum, a) => sum + a.total, 0)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
        <UploadCard platform="amazon" label="Amazon settlement (.txt flat-file)" hint="Deduped by settlement-id" count={totals.amazon} busy={busy} onFiles={onFiles} />
        <UploadCard platform="flipkart" label="Flipkart settlement (.xlsx)" hint="Deduped by NEFT ID" count={totals.flipkart} busy={busy} onFiles={onFiles} />
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)', marginBottom: 8 }}>Uploaded files</div>
        {loading ? (
          <div style={{ ...card, padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>Loading…</div>
        ) : !uploads.length ? (
          <div style={{ ...card, padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>No settlement files uploaded yet</div>
        ) : (
          <div style={{ ...card, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 900 }}>
              <thead style={{ background: 'var(--bg2)' }}>
                <tr>
                  {['Platform', 'File', 'Transaction ID(s)', 'Total settled', 'Orders', 'Deposit date', 'Period', 'Uploaded'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Total settled' || h === 'Orders' ? 'right' : 'left', fontSize: 11, fontWeight: 700, color: 'var(--text3)', whiteSpace: 'nowrap' as const }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {uploads.map(u => {
                  const ids = u.dedup_ids || []
                  const a = fileAgg[u.file_name]
                  const idText = ids.length === 0 ? '—' : ids.length === 1 ? ids[0] : `${ids[0]} +${ids.length - 1} more`
                  return (
                  <tr key={u.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', textTransform: 'capitalize', fontWeight: 600, color: 'var(--text)' }}>{u.platform}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{u.file_name}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text)' }} title={ids.join(', ')}>{idText}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono', color: 'var(--text)', fontWeight: 700 }}>{a ? money(a.total) : '—'}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono', color: 'var(--text3)' }}>{a ? a.orders.toLocaleString() : '—'}</td>
                    <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' as const }}>{a ? fmtD(a.depositDate) : '—'}</td>
                    <td style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' as const }}>{a && a.periodStart ? `${fmtD(a.periodStart)} – ${fmtD(a.periodEnd)}` : '—'}</td>
                    <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap' as const }}>{new Date(u.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                  </tr>
                )})}
                <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--bg2)' }}>
                  <td style={{ padding: '8px 12px', fontWeight: 700, color: 'var(--text)' }} colSpan={3}>Grand total settled</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono', fontWeight: 800, color: 'var(--text)' }}>{money(grand)}</td>
                  <td colSpan={4}></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function UploadCard({ platform, label, hint, count, busy, onFiles }: {
  platform: 'amazon' | 'flipkart'; label: string; hint: string; count: number; busy: boolean;
  onFiles: (p: 'amazon' | 'flipkart', f: File[]) => void
}) {
  const inputId = `recon-upload-${platform}`
  return (
    <div style={{ ...card, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <FileText size={15} color="var(--accent)" />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{label}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 12 }}>{hint} · {count.toLocaleString()} rows stored</div>
      <label htmlFor={inputId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px', borderRadius: 8, border: '2px dashed var(--border)', cursor: busy ? 'wait' : 'pointer', color: 'var(--text2)', fontSize: 13, fontWeight: 700, background: 'var(--bg)' }}>
        <Upload size={15} /> {busy ? 'Working…' : 'Upload file(s)'}
      </label>
      <input id={inputId} type="file" multiple accept={platform === 'amazon' ? '.txt,.csv,.tsv' : '.xlsx'} disabled={busy}
        onChange={e => { const picked = e.target.files ? Array.from(e.target.files) : []; e.currentTarget.value = ''; onFiles(platform, picked) }} style={{ display: 'none' }} />
    </div>
  )
}

// ── Orders: dispatched orders reconciled against settlements (net-amount status) ──
type OrderStatus = 'paid' | 'notpaid' | 'refunded'
interface OrderRow {
  order_id: string
  sku: string | null
  platform: string
  order_date: string | null
  dispatched_at: string | null
  delivered_at: string | null
  payment_date: string | null
  tracking_ids: string
  tracking_status: string | null
  invoiced: number | null
  net: number
  hasRefund: boolean
  status: OrderStatus
}

function OrdersView() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<OrderRow[]>([])
  const [bucket, setBucket] = useState<'all' | OrderStatus>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 100

  useEffect(() => {
    (async () => {
      setLoading(true)
      const orders = await fetchAllRows<{ order_id: string; sku: string | null; barcode_sku: string | null; taxable_value: number | null; unit_price: number | null; order_date: string | null; dispatched_at: string | null; delivered_at: string | null; tracking_number: string | null; lr_number: string | null; tracking_status: string | null }>((from, to) =>
        supabase.from('dispatch_orders')
          .select('order_id, sku, barcode_sku, taxable_value, unit_price, order_date, dispatched_at, delivered_at, tracking_number, lr_number, tracking_status')
          .eq('is_dispatched', true).eq('is_cancelled', false)
          .order('dispatched_at', { ascending: false }).range(from, to))

      // All settlement lines (order_id, amount, transaction_type, settlement_date).
      const settle = await fetchAllRows<{ order_id: string | null; amount: number | null; transaction_type: string | null; settlement_date: string | null }>((from, to) =>
        supabase.from('settlements').select('order_id, amount, transaction_type, settlement_date').range(from, to))

      // Aggregate settlements per order: net amount, whether a refund line exists, latest payment date.
      const agg: Record<string, { net: number; hasRefund: boolean; payDate: string | null }> = {}
      for (const s of settle || []) {
        const oid = (s.order_id || '').trim()
        if (!oid) continue
        const a = agg[oid] || { net: 0, hasRefund: false, payDate: null }
        a.net += s.amount || 0
        const tt = (s.transaction_type || '').toLowerCase()
        // A refund is identified ONLY by the settlement transaction type — NOT by a
        // negative amount. On Amazon 'Order' lines, negatives are fees (commission,
        // TCS, TDS), not refunds. Amazon marks refunds as transaction-type 'Refund';
        // Flipkart marks them 'Customer Return' / 'Logistics Return'.
        if (tt === 'refund' || tt.includes('return')) a.hasRefund = true
        if (s.settlement_date && !a.payDate) a.payDate = s.settlement_date
        agg[oid] = a
      }

      const platformOf = (oid: string) => {
        const t = (oid || '').trim()
        if (/^\d{3}-\d{7}-\d{7}$/.test(t)) return 'Amazon'
        if (t.startsWith('OD')) return 'Flipkart'
        if (/^\d{4,6}$/.test(t)) return 'Website'
        return 'Other'
      }

      const out: OrderRow[] = (orders || []).filter(o => o.order_id).map(o => {
        const a = agg[o.order_id.trim()]
        let status: OrderStatus
        if (!a) status = 'notpaid'
        else if (a.net <= 0) status = 'refunded'   // net-amount rule: fully reversed
        else status = 'paid'                        // net positive (with badge if a refund also present)
        const tids = [o.tracking_number, o.lr_number].filter(Boolean).join(' · ')
        return {
          order_id: o.order_id,
          sku: o.barcode_sku || o.sku,
          platform: platformOf(o.order_id),
          order_date: o.order_date,
          dispatched_at: o.dispatched_at,
          delivered_at: o.delivered_at,
          payment_date: a?.payDate ?? null,
          tracking_ids: tids || '—',
          tracking_status: o.tracking_status,
          invoiced: o.taxable_value ?? o.unit_price ?? null,
          net: a?.net ?? 0,
          hasRefund: a?.hasRefund ?? false,
          status,
        }
      })
      setRows(out)
      setLoading(false)
    })()
  }, [supabase])

  const counts = useMemo(() => {
    const c = { all: rows.length, paid: 0, notpaid: 0, refunded: 0 }
    for (const r of rows) c[r.status]++
    return c
  }, [rows])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter(r => {
      if (bucket !== 'all' && r.status !== bucket) return false
      if (q && !(`${r.order_id} ${r.sku || ''} ${r.tracking_ids}`.toLowerCase().includes(q))) return false
      return true
    })
  }, [rows, bucket, search])

  // Reset to the first page whenever the filter/search/bucket changes.
  useEffect(() => { setPage(0) }, [bucket, search])
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  const pageSafe = Math.min(page, pageCount - 1)
  const paged = useMemo(() => shown.slice(pageSafe * PAGE_SIZE, (pageSafe + 1) * PAGE_SIZE), [shown, pageSafe])

  const fmt = (d: string | null) => d ? new Date(d.length <= 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'
  const money = (n: number | null) => n != null ? Math.round(n).toLocaleString('en-IN') : '—'

  const pill = (r: OrderRow) => {
    const map: Record<OrderStatus, { bg: string; fg: string; label: string }> = {
      paid: { bg: 'var(--dispatched-bg)', fg: 'var(--dispatched)', label: 'Paid' },
      notpaid: { bg: 'var(--critical-bg)', fg: 'var(--critical)', label: 'Not paid' },
      refunded: { bg: 'var(--today-bg)', fg: 'var(--today)', label: 'Refunded' },
    }
    const m = map[r.status]
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={{ background: m.bg, color: m.fg, padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{m.label}</span>
        {r.status === 'paid' && r.hasRefund && (
          <span style={{ background: 'var(--today-bg)', color: 'var(--today)', padding: '2px 6px', borderRadius: 6, fontSize: 10, fontWeight: 700 }}>+refund</span>
        )}
      </span>
    )
  }

  const tabs: { key: 'all' | OrderStatus; label: string; n: number }[] = [
    { key: 'all', label: 'All', n: counts.all },
    { key: 'paid', label: 'Paid', n: counts.paid },
    { key: 'notpaid', label: 'Not paid', n: counts.notpaid },
    { key: 'refunded', label: 'Refunded', n: counts.refunded },
  ]

  const COLS = ['Order ID', 'Order date', 'Dispatch date', 'Delivery date', 'Payment date', 'Tracking ID(s)', 'Platform', 'Tracking status', 'Amount', 'Status']

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' as const, alignItems: 'center' }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setBucket(t.key)} style={{
            padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700,
            border: bucket === t.key ? '2px solid var(--accent)' : '1px solid var(--border)',
            background: bucket === t.key ? 'var(--accent)' : 'var(--surface)',
            color: bucket === t.key ? '#fff' : 'var(--text2)',
          }}>{t.label} {loading ? '' : t.n.toLocaleString()}</button>
        ))}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search order id, SKU, tracking"
          style={{ marginLeft: 'auto', minWidth: 220, padding: '7px 11px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, outline: 'none' }} />
      </div>

      <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
        Status by net settlement amount: no settlement = not paid · net &le; 0 = refunded · net &gt; 0 = paid (with +refund badge if a refund line exists). Note: orders on a platform whose settlement file isn&rsquo;t uploaded will show as not paid.
      </div>

      {loading ? (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'auto', maxHeight: 560 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12, minWidth: 1040 }}>
            <thead style={{ background: 'var(--bg2)', position: 'sticky' as const, top: 0 }}>
              <tr>{COLS.map(h => <th key={h} style={{ padding: '8px 10px', textAlign: h === 'Amount' ? 'right' as const : 'left' as const, fontSize: 11, fontWeight: 700, color: 'var(--text3)', whiteSpace: 'nowrap' as const }}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {paged.map((r, i) => (
                <tr key={r.order_id + i} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 10px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text)', whiteSpace: 'nowrap' as const }}>{r.order_id}</td>
                  <td style={{ padding: '8px 10px', color: 'var(--text2)' }}>{fmt(r.order_date)}</td>
                  <td style={{ padding: '8px 10px', color: 'var(--text2)' }}>{fmt(r.dispatched_at)}</td>
                  <td style={{ padding: '8px 10px', color: 'var(--text2)' }}>{fmt(r.delivered_at)}</td>
                  <td style={{ padding: '8px 10px', color: 'var(--text2)' }}>{fmt(r.payment_date)}</td>
                  <td style={{ padding: '8px 10px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' as const }}>{r.tracking_ids}</td>
                  <td style={{ padding: '8px 10px', color: 'var(--text2)' }}>{r.platform}</td>
                  <td style={{ padding: '8px 10px', color: 'var(--text3)', whiteSpace: 'nowrap' as const }}>{r.tracking_status || '—'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: 'var(--text2)' }}>{money(r.invoiced)}</td>
                  <td style={{ padding: '8px 10px' }}>{pill(r)}</td>
                </tr>
              ))}
              {!shown.length && (
                <tr><td colSpan={10} style={{ padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>No orders in this view.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {!loading && shown.length > PAGE_SIZE && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>
            Showing {(pageSafe * PAGE_SIZE + 1).toLocaleString()}–{Math.min((pageSafe + 1) * PAGE_SIZE, shown.length).toLocaleString()} of {shown.length.toLocaleString()}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={pageSafe === 0}
              style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: pageSafe === 0 ? 'var(--text3)' : 'var(--text2)', cursor: pageSafe === 0 ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>Prev</button>
            <span style={{ fontSize: 12, color: 'var(--text2)', fontFamily: 'DM Mono' }}>{pageSafe + 1} / {pageCount}</span>
            <button onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={pageSafe >= pageCount - 1}
              style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: pageSafe >= pageCount - 1 ? 'var(--text3)' : 'var(--text2)', cursor: pageSafe >= pageCount - 1 ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>Next</button>
          </div>
        </div>
      )}
    </div>
  )
}
