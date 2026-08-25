'use client'
import { useState, useEffect, useCallback, useMemo, useRef, Fragment, type ReactNode } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { Upload, FileText, AlertTriangle, IndianRupee, RefreshCw, Filter, ArrowUp, ArrowDown, ChevronDown, ChevronRight, X, Download, Search } from 'lucide-react'
import {
  parseAmazonText, parseFlipkartBuffer, readFileText, readFileBuffer,
  parseRazorpayText, parseCashfreeText, detectWebsiteAggregator,
  type SettlementRow,
} from '@/lib/settlements'
import RateCardEditor from './RateCardEditor'
import PriceMaster from './PriceMaster'
import DiscountEvents from './DiscountEvents'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }
type Tab = 'inbox' | 'orders' | 'charges' | 'ratecard' | 'prices' | 'discounts'

interface UploadRow { id: string; platform: string; file_name: string; row_count: number; dedup_ids: string[]; created_at: string; total_settled?: number | null; order_count?: number | null; deposit_date?: string | null; period_start?: string | null; period_end?: string | null }
type FileAggMap = Record<string, { total: number; orders: number; depositDate: string | null; periodStart: string | null; periodEnd: string | null }>

export default function ReconSection() {
  const supabase = createClient()
  const [tab, setTab] = useState<Tab>('inbox')
  const [uploads, setUploads] = useState<UploadRow[]>([])
  const [fileAgg, setFileAgg] = useState<FileAggMap>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'warn' | 'err'; text: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [totals, setTotals] = useState<{ amazon: number; flipkart: number; website: number; orders: number }>({ amazon: 0, flipkart: 0, website: 0, orders: 0 })

  const flash = (type: 'ok' | 'warn' | 'err', text: string) => setMsg({ type, text })

  const loadInbox = useCallback(async () => {
    setLoading(true)
    const { data: up } = await supabase.from('settlement_uploads').select('*').order('created_at', { ascending: false })
    const upRows = (up as UploadRow[]) || []
    setUploads(upRows)
    // Totals come straight from the stored per-file columns — no scan of settlement rows.
    const azRows = upRows.filter(u => u.platform === 'amazon')
    const fkRows = upRows.filter(u => u.platform === 'flipkart')
    const wsRows = upRows.filter(u => u.platform === 'website')
    setTotals(t => ({ ...t, amazon: azRows.reduce((s, u) => s + (u.row_count || 0), 0), flipkart: fkRows.reduce((s, u) => s + (u.row_count || 0), 0), website: wsRows.reduce((s, u) => s + (u.row_count || 0), 0) }))
    // Build the per-file aggregate map from the stored columns (fallback to 0/null if an
    // older file was uploaded before these columns existed).
    const agg: FileAggMap = {}
    for (const u of upRows) {
      agg[u.file_name] = {
        total: u.total_settled ?? 0,
        orders: u.order_count ?? (u.dedup_ids?.length ?? 0),
        depositDate: u.deposit_date ?? null,
        periodStart: u.period_start ?? null,
        periodEnd: u.period_end ?? null,
      }
    }
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

  const handleFiles = async (platform: 'amazon' | 'flipkart' | 'website', files: File[]) => {
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
          } else if (platform === 'flipkart') {
            if (!/\.xlsx$/i.test(f.name)) { flash('warn', `Skipped ${f.name} — expected a .xlsx`); continue }
            parsed = await parseFlipkartBuffer(await readFileBuffer(f))
          } else {
            // Website payments — a CSV from an aggregator. Auto-detect Razorpay vs Cashfree.
            if (!/\.csv$/i.test(f.name)) { flash('warn', `Skipped ${f.name} — expected a .csv from Razorpay or Cashfree`); continue }
            const txt = await readFileText(f)
            const agg = detectWebsiteAggregator(txt)
            if (agg === 'razorpay') parsed = parseRazorpayText(txt)
            else if (agg === 'cashfree') parsed = parseCashfreeText(txt)
            else { flash('warn', `Skipped ${f.name} — couldn't tell if it's a Razorpay or Cashfree export (unrecognized columns)`); continue }
            console.log('[recon] website aggregator detected:', agg)
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
        // Precompute per-file totals now, so the inbox never has to re-scan all settlement rows.
        const orderSet = new Set<string>()
        let totalSettled = 0
        let depositDate: string | null = null
        let periodStart: string | null = null
        let periodEnd: string | null = null
        for (const r of parsed.rows) {
          totalSettled += r.amount || 0
          if (r.order_id) orderSet.add(r.order_id)
          if (!depositDate && r.settlement_date) depositDate = r.settlement_date
          const raw = (r.raw || {}) as Record<string, unknown>
          if (!periodStart && raw['settlement-start-date']) periodStart = String(raw['settlement-start-date'])
          if (!periodEnd && raw['settlement-end-date']) periodEnd = String(raw['settlement-end-date'])
        }
        const { error: upErr } = await supabase.from('settlement_uploads').insert({
          platform, file_name: f.name, dedup_ids: fileIds, row_count: parsed.rows.length, uploaded_by_email: email,
          total_settled: totalSettled, order_count: orderSet.size, deposit_date: depositDate, period_start: periodStart, period_end: periodEnd,
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
        {(['inbox', 'orders', 'charges', 'ratecard', 'prices', 'discounts'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 13, fontWeight: 700,
            background: tab === t ? 'var(--accent)' : 'var(--surface)', color: tab === t ? '#fff' : 'var(--text2)',
          }}>{t === 'inbox' ? 'Settlement Inbox' : t === 'orders' ? 'Orders' : t === 'charges' ? 'Charges' : t === 'ratecard' ? 'Rate Card' : t === 'prices' ? 'Price Master' : 'Discounts'}</button>
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
      ) : tab === 'orders' ? (
        <OrdersView />
      ) : tab === 'charges' ? (
        <ChargesView />
      ) : tab === 'ratecard' ? (
        <RateCardEditor />
      ) : tab === 'prices' ? (
        <PriceMaster />
      ) : (
        <DiscountEvents />
      )}
    </div>
  )
}

// ── Settlement Inbox ──
function InboxView({ uploads, totals, fileAgg, loading, busy, onFiles }: {
  uploads: UploadRow[]; totals: { amazon: number; flipkart: number; website: number }; fileAgg: FileAggMap; loading: boolean; busy: boolean;
  onFiles: (p: 'amazon' | 'flipkart' | 'website', f: File[]) => void
}) {
  const [detailFile, setDetailFile] = useState<{ name: string; platform: string } | null>(null)
  const money = (n: number) => Math.round(n).toLocaleString('en-IN')
  const fmtD = (d: string | null) => { if (!d) return '—'; const s = String(d); const iso = s.includes('.') && /^\d{2}\.\d{2}\.\d{4}/.test(s) ? s.slice(6,10)+'-'+s.slice(3,5)+'-'+s.slice(0,2) : s; const dt = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso); return isNaN(dt.getTime()) ? s.slice(0,10) : dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) }
  const grand = Object.values(fileAgg).reduce((sum, a) => sum + a.total, 0)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
        <UploadCard platform="amazon" label="Amazon settlement (.txt flat-file)" hint="Deduped by settlement-id" count={totals.amazon} busy={busy} onFiles={onFiles} />
        <UploadCard platform="flipkart" label="Flipkart settlement (.xlsx)" hint="Deduped by NEFT ID" count={totals.flipkart} busy={busy} onFiles={onFiles} />
        <UploadCard platform="website" label="Website payments (Razorpay / Cashfree .csv)" hint="Auto-detects aggregator · deduped by payment id" count={totals.website} busy={busy} onFiles={onFiles} />
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
                  <tr key={u.id} onClick={() => setDetailFile({ name: u.file_name, platform: u.platform })} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg2)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
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

      {detailFile && <FileDetail file={detailFile} onClose={() => setDetailFile(null)} />}
    </div>
  )
}

// ── Settlement file drill-down: payout status summary + transaction list ──
function FileDetail({ file, onClose }: { file: { name: string; platform: string }; onClose: () => void }) {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [tx, setTx] = useState<{ order_id: string; sku: string | null; type: string; net: number; matched: boolean }[]>([])
  const [summary, setSummary] = useState<{ total: number; orders: number; matched: number; unmatched: number; sales: number; refunds: number }>({ total: 0, orders: 0, matched: 0, unmatched: 0, sales: 0, refunds: 0 })

  useEffect(() => {
    (async () => {
      setLoading(true)
      // This file's settlement lines.
      const rows = await fetchAllRows<{ order_id: string | null; sku: string | null; amount: number | null; transaction_type: string | null }>((from, to) =>
        supabase.from('settlements').select('order_id, sku, amount, transaction_type').eq('uploaded_file', file.name).range(from, to))
      // Aggregate per order.
      const byOrder: Record<string, { sku: string | null; net: number; isRefund: boolean }> = {}
      for (const r of rows || []) {
        const oid = (r.order_id || '').trim()
        if (!oid) continue
        const a = byOrder[oid] || { sku: r.sku, net: 0, isRefund: false }
        a.net += r.amount || 0
        if ((r.transaction_type || '').toLowerCase() === 'refund' || (r.transaction_type || '').toLowerCase().includes('return')) a.isRefund = true
        if (!a.sku && r.sku) a.sku = r.sku
        byOrder[oid] = a
      }
      const oids = Object.keys(byOrder)
      // Which of these order-ids exist in dispatch_orders? (batch in chunks to keep the IN list sane)
      const matchedSet = new Set<string>()
      const CH = 200
      for (let i = 0; i < oids.length; i += CH) {
        const slice = oids.slice(i, i + CH)
        const { data } = await supabase.from('dispatch_orders').select('order_id').in('order_id', slice)
        for (const d of (data as { order_id: string }[] | null) || []) matchedSet.add(d.order_id)
      }
      const list = oids.map(oid => ({ order_id: oid, sku: byOrder[oid].sku, type: byOrder[oid].isRefund ? 'Refund' : 'Sale', net: byOrder[oid].net, matched: matchedSet.has(oid) }))
      list.sort((a, b) => (a.matched === b.matched ? 0 : a.matched ? 1 : -1))  // unmatched first
      const total = (rows || []).reduce((s, r) => s + (r.amount || 0), 0)
      setSummary({
        total, orders: oids.length,
        matched: list.filter(t => t.matched).length,
        unmatched: list.filter(t => !t.matched).length,
        sales: list.filter(t => t.type === 'Sale').length,
        refunds: list.filter(t => t.type === 'Refund').length,
      })
      setTx(list)
      setLoading(false)
    })()
  }, [file.name, supabase])

  const money = (n: number) => Math.round(n).toLocaleString('en-IN')

  return (
    <div style={{ position: 'relative' as const, marginTop: 18, ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{file.name}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'capitalize' as const }}>{file.platform} settlement · transactions in this payout</div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', display: 'inline-flex' }}><X size={18} /></button>
      </div>

      {loading ? (
        <div style={{ padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Loading transactions…</div>
      ) : (
        <div style={{ padding: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12, marginBottom: 12 }}>
            <div style={{ background: 'var(--bg2)', borderRadius: 8, padding: '10px 12px' }}><div style={{ fontSize: 11, color: 'var(--text3)' }}>Total settled</div><div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)', fontFamily: 'DM Mono' }}>{money(summary.total)}</div></div>
            <div style={{ background: 'var(--bg2)', borderRadius: 8, padding: '10px 12px' }}><div style={{ fontSize: 11, color: 'var(--text3)' }}>Orders</div><div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)', fontFamily: 'DM Mono' }}>{summary.orders.toLocaleString()}</div></div>
            <div style={{ background: 'var(--dispatched-bg)', borderRadius: 8, padding: '10px 12px' }}><div style={{ fontSize: 11, color: 'var(--dispatched)' }}>Matched to dispatch</div><div style={{ fontSize: 18, fontWeight: 800, color: 'var(--dispatched)', fontFamily: 'DM Mono' }}>{summary.matched.toLocaleString()}</div></div>
            <div style={{ background: 'var(--today-bg)', borderRadius: 8, padding: '10px 12px' }}><div style={{ fontSize: 11, color: 'var(--today)' }}>Unmatched</div><div style={{ fontSize: 18, fontWeight: 800, color: 'var(--today)', fontFamily: 'DM Mono' }}>{summary.unmatched.toLocaleString()}</div></div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10 }}>{summary.sales.toLocaleString()} sales · {summary.refunds.toLocaleString()} refunds · unmatched = order id not found in dispatch (older orders or account-level rows).</div>

          <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'auto', maxHeight: 360 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12, minWidth: 560 }}>
              <thead style={{ background: 'var(--bg2)', position: 'sticky' as const, top: 0 }}>
                <tr>{['Order ID', 'SKU', 'Type', 'Net', 'Match'].map(h => <th key={h} style={{ padding: '7px 10px', textAlign: h === 'Net' ? 'right' as const : 'left' as const, fontSize: 11, fontWeight: 700, color: 'var(--text3)' }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {tx.map((t, i) => (
                  <tr key={t.order_id + i} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '7px 10px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text)' }}>{t.order_id}</td>
                    <td style={{ padding: '7px 10px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>{t.sku || '—'}</td>
                    <td style={{ padding: '7px 10px', color: t.type === 'Refund' ? 'var(--today)' : 'var(--text2)' }}>{t.type}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: t.net < 0 ? 'var(--critical)' : 'var(--text2)' }}>{money(t.net)}</td>
                    <td style={{ padding: '7px 10px' }}>
                      <span style={{ background: t.matched ? 'var(--dispatched-bg)' : 'var(--today-bg)', color: t.matched ? 'var(--dispatched)' : 'var(--today)', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700 }}>{t.matched ? 'matched' : 'unmatched'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function UploadCard({ platform, label, hint, count, busy, onFiles }: {
  platform: 'amazon' | 'flipkart' | 'website'; label: string; hint: string; count: number; busy: boolean;
  onFiles: (p: 'amazon' | 'flipkart' | 'website', f: File[]) => void
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
      <input id={inputId} type="file" multiple accept={platform === 'amazon' ? '.txt,.csv,.tsv' : platform === 'website' ? '.csv' : '.xlsx'} disabled={busy}
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

interface OrdCol {
  key: string
  label: string
  type: 'text' | 'category' | 'date' | 'number'
  get: (r: OrderRow) => string | number
  render?: (r: OrderRow) => ReactNode
  align?: 'left' | 'right'
}

// ── Charge aggregation (actuals): normalize Amazon amount_description lines + Flipkart raw
//    columns into the same buckets, splitting forward vs reverse. Fees kept at BASE (pre-GST).
const cnum = (v: unknown) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n }
function amazonBucket(desc: string): string {
  const d = desc || ''
  if (d === 'Principal') return 'sale'
  if (d === 'Commission') return 'commission'
  if (d === 'Fixed closing fee') return 'closing'
  if (d === 'FBA Pick & Pack Fee' || d === 'FBA Weight Handling Fee') return 'fba'
  if (d === 'Product Tax' || d === 'Shipping tax') return 'productTax'
  if (d.startsWith('TCS')) return 'tcs'
  if (d.startsWith('TDS')) return 'tds'
  if (/(IGST|CGST|SGST)$/.test(d)) return 'gstOnFees'
  if (d === 'Shipping' || d === 'Shipping commission') return 'shipping'
  return 'other'
}
const FKCOL: Record<string, (r: Record<string, unknown>) => number> = {
  sale: r => cnum(r['Sale Amount (Rs.)']) + cnum(r['Total Offer Amount (Rs.)']),
  commission: r => cnum(r['Commission (Rs.)']),
  closing: r => cnum(r['Fixed Fee  (Rs.)']),
  shipping: r => cnum(r['Shipping Fee (Rs.)']) + cnum(r['Collection Fee (Rs.)']),
  fba: r => cnum(r['Pick And Pack Fee (Rs.)']),
  productTax: r => cnum(r['Taxes (Rs.)']),
  tcs: r => cnum(r['TCS (Rs.)']),
  tds: r => cnum(r['TDS (Rs.)']),
  gstOnFees: r => cnum(r['GST on MP Fees (Rs.)']),
  net: r => cnum(r['Bank Settlement Value (Rs.)  = SUM(I:Q)']),
}
export interface ChargeAgg {
  sale: number; commission: number; closing: number; shipping: number; fba: number
  productTax: number; tcs: number; tds: number; gstOnFees: number; net: number; other: number
  reverseResidual: number; returned: boolean; commissionPct: number | null
  detail: { label: string; amount: number }[]
}
type SettleLine = { amount: number | null; transaction_type: string | null; amount_description: string | null; raw: Record<string, unknown> | null }
function aggregateCharges(platform: string, lines: SettleLine[]): ChargeAgg {
  const b = { sale: 0, commission: 0, closing: 0, shipping: 0, fba: 0, productTax: 0, tcs: 0, tds: 0, gstOnFees: 0, net: 0, other: 0 }
  let reverseResidual = 0, returned = false
  const detail: { label: string; amount: number }[] = []
  if (platform === 'Amazon') {
    for (const l of lines) {
      const tt = (l.transaction_type || '').toLowerCase()
      const amt = l.amount || 0
      detail.push({ label: `${l.amount_description || l.transaction_type || 'line'}${tt !== 'order' ? ` (${l.transaction_type})` : ''}`, amount: amt })
      if (tt !== 'order') { returned = true; reverseResidual += amt; continue }
      const key = amazonBucket(l.amount_description || '') as keyof typeof b
      b[key] += amt; b.net += amt
    }
  } else if (platform === 'Flipkart') {
    for (const l of lines) {
      const tt = l.transaction_type || ''
      const isReturn = /return/i.test(tt)
      const amt = l.amount || 0
      const raw = l.raw || {}
      const fwd = !isReturn || amt >= 0
      if (isReturn) returned = true
      detail.push({ label: `${isReturn ? 'Return ' : ''}${amt >= 0 ? 'forward' : 'reverse'} · settlement`, amount: FKCOL.net(raw) })
      if (!fwd) { reverseResidual += FKCOL.net(raw); continue }
      for (const k of Object.keys(FKCOL) as (keyof typeof b)[]) b[k] += FKCOL[k](raw)
    }
  }
  const commissionPct = b.sale ? Math.abs(b.commission) / b.sale * 100 : null
  return { ...b, reverseResidual, returned, commissionPct, detail }
}

interface ChargeRow {
  order_id: string; sku: string | null; platform: string; order_date: string | null
  payment_date: string | null; agg: ChargeAgg | null
}
type ChgCol = { key: string; label: string; type: 'text' | 'category' | 'number' | 'date'; align?: 'right'; get: (r: ChargeRow) => string | number; render?: (r: ChargeRow) => ReactNode }

function ChargesView() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<ChargeRow[]>([])
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 100
  const [win, setWin] = useState<'7d' | '30d' | '3mo' | 'all' | 'custom'>('7d')
  const [customFrom, setCustomFrom] = useState(''); const [customTo, setCustomTo] = useState('')
  const [platformF, setPlatformF] = useState<'all' | 'Amazon' | 'Flipkart'>('all')
  const [retF, setRetF] = useState<'all' | 'clean' | 'returned'>('all')
  const [text, setText] = useState('')
  const [sortKey, setSortKey] = useState('order_date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [expanded, setExpanded] = useState<string | null>(null)

  const range = useMemo<{ from: string | null; to: string | null }>(() => {
    const now = new Date(); const iso = (d: Date) => d.toISOString().slice(0, 10)
    const back = (days: number) => iso(new Date(now.getTime() - days * 86400000))
    if (win === '7d') return { from: back(6), to: null }
    if (win === '30d') return { from: back(29), to: null }
    if (win === '3mo') return { from: back(89), to: null }
    if (win === 'all') return { from: null, to: null }
    return { from: customFrom || null, to: customTo || null }
  }, [win, customFrom, customTo])

  const platformOf = (oid: string) => { const t = (oid || '').trim(); if (/^\d{3}-\d{7}-\d{7}$/.test(t)) return 'Amazon'; if (t.startsWith('OD')) return 'Flipkart'; if (/^\d{4,6}$/.test(t)) return 'Website'; return 'Other' }

  const loadWindow = useCallback(async () => {
    if (win === 'custom' && (!customFrom || !customTo)) { setRows([]); setLoading(false); return }
    setLoading(true)
    const orders = await fetchAllRows<{ order_id: string; sku: string | null; barcode_sku: string | null; order_date: string | null }>((from, to) => {
      let q = supabase.from('dispatch_orders').select('order_id, sku, barcode_sku, order_date').eq('is_dispatched', true).eq('is_cancelled', false)
      if (range.from) q = q.gte('order_date', range.from)
      if (range.to) q = q.lte('order_date', range.to)
      return q.order('order_date', { ascending: false }).order('id', { ascending: false }).range(from, to)
    })
    const oids = Array.from(new Set((orders || []).map(o => o.order_id).filter(Boolean)))
    const byOrder: Record<string, SettleLine[]> = {}
    const payDate: Record<string, string> = {}
    const CH = 50
    for (let i = 0; i < oids.length; i += CH) {
      const slice = oids.slice(i, i + CH)
      const chunk = await fetchAllRows<{ order_id: string | null; amount: number | null; transaction_type: string | null; amount_description: string | null; settlement_date: string | null; raw: Record<string, unknown> | null }>((from, to) =>
        supabase.from('settlements').select('order_id, amount, transaction_type, amount_description, settlement_date, raw').in('order_id', slice).order('id', { ascending: true }).range(from, to))
      for (const r of chunk) {
        const oid = (r.order_id || '').trim(); if (!oid) continue
        ;(byOrder[oid] ??= []).push({ amount: r.amount, transaction_type: r.transaction_type, amount_description: r.amount_description, raw: r.raw })
        if (r.settlement_date && !payDate[oid]) payDate[oid] = r.settlement_date
      }
    }
    const out: ChargeRow[] = (orders || []).filter(o => o.order_id).map(o => {
      const oid = o.order_id.trim(); const plat = platformOf(oid); const lines = byOrder[oid]
      return { order_id: o.order_id, sku: o.barcode_sku || o.sku, platform: plat, order_date: o.order_date, payment_date: payDate[oid] ?? null, agg: lines ? aggregateCharges(plat, lines) : null }
    })
    setRows(out); setLoading(false)
  }, [supabase, win, customFrom, customTo, range])
  useEffect(() => { if (win !== 'custom') void loadWindow() }, [win, loadWindow])

  const fmt = (d: string | null) => { if (!d) return '—'; const s = String(d); const dt = new Date(s.length <= 10 ? s + 'T00:00:00' : s); return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) }
  const money = (n: number | null | undefined) => (n == null || n === 0) ? '—' : Math.round(n).toLocaleString('en-IN')

  const COLS: ChgCol[] = useMemo(() => [
    { key: 'sale', label: 'Sale', type: 'number', align: 'right', get: r => r.agg?.sale ?? 0, render: r => <span style={{ fontFamily: 'DM Mono' }}>{money(r.agg?.sale)}</span> },
    { key: 'commission', label: 'Commission', type: 'number', align: 'right', get: r => r.agg?.commission ?? 0, render: r => <span style={{ fontFamily: 'DM Mono' }}>{money(r.agg?.commission)}{r.agg?.commissionPct != null && <span style={{ display: 'block', fontSize: 10, color: 'var(--text3)' }}>{r.agg.commissionPct.toFixed(1)}%</span>}</span> },
    { key: 'closing', label: 'Closing', type: 'number', align: 'right', get: r => r.agg?.closing ?? 0, render: r => <span style={{ fontFamily: 'DM Mono' }}>{money(r.agg?.closing)}</span> },
    { key: 'shipping', label: 'Shipping', type: 'number', align: 'right', get: r => r.agg?.shipping ?? 0, render: r => <span style={{ fontFamily: 'DM Mono' }}>{money(r.agg?.shipping)}</span> },
    { key: 'fba', label: 'FBA', type: 'number', align: 'right', get: r => r.agg?.fba ?? 0, render: r => <span style={{ fontFamily: 'DM Mono' }}>{money(r.agg?.fba)}</span> },
    { key: 'productTax', label: 'Tax', type: 'number', align: 'right', get: r => r.agg?.productTax ?? 0, render: r => <span style={{ fontFamily: 'DM Mono' }}>{money(r.agg?.productTax)}</span> },
    { key: 'tcs', label: 'TCS', type: 'number', align: 'right', get: r => r.agg?.tcs ?? 0, render: r => <span style={{ fontFamily: 'DM Mono' }}>{money(r.agg?.tcs)}</span> },
    { key: 'tds', label: 'TDS', type: 'number', align: 'right', get: r => r.agg?.tds ?? 0, render: r => <span style={{ fontFamily: 'DM Mono' }}>{money(r.agg?.tds)}</span> },
    { key: 'gstOnFees', label: 'GST on fees', type: 'number', align: 'right', get: r => r.agg?.gstOnFees ?? 0, render: r => <span style={{ fontFamily: 'DM Mono', color: 'var(--text3)' }}>{money(r.agg?.gstOnFees)}</span> },
    { key: 'net', label: 'Net', type: 'number', align: 'right', get: r => r.agg ? (r.agg.returned ? r.agg.net + r.agg.reverseResidual : r.agg.net) : 0, render: r => { const n = r.agg ? (r.agg.returned ? r.agg.net + r.agg.reverseResidual : r.agg.net) : null; return <span style={{ fontFamily: 'DM Mono', fontWeight: 700, color: (n ?? 0) < 0 ? 'var(--critical)' : 'var(--text)' }}>{r.agg ? money(n) : <span style={{ color: 'var(--critical)', fontWeight: 400 }}>not settled</span>}</span> } },
  ], [])

  const filtered = useMemo(() => {
    let out = rows.filter(r => {
      if (platformF !== 'all' && r.platform !== platformF) return false
      if (retF === 'clean' && r.agg?.returned) return false
      if (retF === 'returned' && !r.agg?.returned) return false
      if (text.trim()) { const q = text.toLowerCase(); if (!r.order_id.toLowerCase().includes(q) && !(r.sku || '').toLowerCase().includes(q)) return false }
      return true
    })
    const col = COLS.find(c => c.key === sortKey)
    const getV = (r: ChargeRow): string | number => sortKey === 'order_date' ? (r.order_date || '') : sortKey === 'order_id' ? r.order_id : col ? col.get(r) : ''
    out = [...out].sort((a, b) => { const va = getV(a), vb = getV(b); const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb)); return sortDir === 'asc' ? cmp : -cmp })
    return out
  }, [rows, platformF, retF, text, sortKey, sortDir, COLS])

  useEffect(() => { setPage(0) }, [platformF, retF, text])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageSafe = Math.min(page, pageCount - 1)
  const paged = useMemo(() => filtered.slice(pageSafe * PAGE_SIZE, (pageSafe + 1) * PAGE_SIZE), [filtered, pageSafe])
  const toggleSort = (key: string) => { if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(key); setSortDir('desc') } }

  const winBtns = ([['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['3mo', 'Last 3 months'], ['all', 'All'], ['custom', 'Custom']] as [typeof win, string][])
  const segBtn = (active: boolean, label: string, onClick: () => void) => (
    <button onClick={onClick} style={{ padding: '5px 11px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: active ? 'var(--accent)' : 'transparent', color: active ? '#fff' : 'var(--text2)' }}>{label}</button>
  )

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' as const, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 700 }}>Order date:</span>
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
          {winBtns.map(([k, l]) => segBtn(win === k, l, () => setWin(k)))}
        </div>
        {win === 'custom' && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12 }} />
            <span style={{ color: 'var(--text3)', fontSize: 12 }}>to</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12 }} />
            <button onClick={() => void loadWindow()} style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Load</button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' as const, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
          {segBtn(platformF === 'all', 'All platforms', () => setPlatformF('all'))}
          {segBtn(platformF === 'Amazon', 'Amazon', () => setPlatformF('Amazon'))}
          {segBtn(platformF === 'Flipkart', 'Flipkart', () => setPlatformF('Flipkart'))}
        </div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
          {segBtn(retF === 'all', 'All', () => setRetF('all'))}
          {segBtn(retF === 'clean', 'Clean', () => setRetF('clean'))}
          {segBtn(retF === 'returned', 'Returned', () => setRetF('returned'))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 10px' }}>
          <Search size={13} style={{ color: 'var(--text3)' }} />
          <input value={text} onChange={e => setText(e.target.value)} placeholder="Order ID or SKU" style={{ border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12, outline: 'none', width: 150, fontFamily: 'DM Mono' }} />
        </div>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{filtered.length} orders</span>
      </div>

      {loading ? (
        <div style={{ ...card, padding: 40, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Loading charges…</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...card, padding: 40, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>No orders with settlements in this window.</div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' as const }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12, minWidth: 900 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border2)', background: 'var(--bg2)' }}>
                  <th style={{ padding: '8px 10px', textAlign: 'left' as const, fontSize: 11, color: 'var(--text3)', cursor: 'pointer' }} onClick={() => toggleSort('order_id')}>Order {sortKey === 'order_id' ? (sortDir === 'asc' ? '▲' : '▼') : ''}</th>
                  {COLS.map(c => (
                    <th key={c.key} onClick={() => toggleSort(c.key)} style={{ padding: '8px 10px', textAlign: (c.align === 'right' ? 'right' : 'left') as 'right' | 'left', fontSize: 11, color: 'var(--text3)', cursor: 'pointer', whiteSpace: 'nowrap' as const }}>{c.label} {sortKey === c.key ? (sortDir === 'asc' ? '▲' : '▼') : ''}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.map((r, i) => (
                  <Fragment key={r.order_id}>
                    <tr style={{ borderBottom: '1px solid var(--border)', background: r.agg?.returned ? 'var(--today-bg)' : (i % 2 ? 'var(--bg2)' : 'transparent'), cursor: 'pointer' }} onClick={() => setExpanded(expanded === r.order_id ? null : r.order_id)}>
                      <td style={{ padding: '9px 10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {expanded === r.order_id ? <ChevronDown size={13} style={{ color: 'var(--text3)' }} /> : <ChevronRight size={13} style={{ color: 'var(--text3)' }} />}
                          <span style={{ fontFamily: 'DM Mono', fontSize: 11 }}>{r.order_id.length > 18 ? r.order_id.slice(0, 18) + '…' : r.order_id}</span>
                          {r.agg?.returned && <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--today)', border: '1px solid #fed7aa', borderRadius: 4, padding: '0 4px' }}>returned</span>}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 19, fontFamily: 'DM Mono' }}>{r.platform} · {r.sku || '—'}</div>
                      </td>
                      {COLS.map(c => (
                        <td key={c.key} style={{ padding: '9px 10px', textAlign: (c.align === 'right' ? 'right' : 'left') as 'right' | 'left', whiteSpace: 'nowrap' as const }}>{c.render ? c.render(r) : c.get(r)}</td>
                      ))}
                    </tr>
                    {expanded === r.order_id && r.agg && (
                      <tr style={{ background: 'var(--bg2)' }}>
                        <td colSpan={COLS.length + 1} style={{ padding: '4px 10px 12px 29px' }}>
                          <div style={{ fontSize: 11, color: 'var(--text3)', margin: '6px 0 4px' }}>Full settlement lines{r.agg.returned ? ` · reverse residual ${money(r.agg.reverseResidual)}` : ''}</div>
                          <table style={{ width: 'auto', borderCollapse: 'collapse' as const, fontSize: 11 }}>
                            <tbody>
                              {r.agg.detail.map((d, j) => (
                                <tr key={j}><td style={{ padding: '3px 16px 3px 0', color: 'var(--text2)' }}>{d.label}</td><td style={{ padding: '3px 0', textAlign: 'right' as const, fontFamily: 'DM Mono', color: d.amount < 0 ? 'var(--critical)' : 'var(--text2)' }}>{d.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td></tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid var(--border)' }}>
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={pageSafe === 0} style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: pageSafe === 0 ? 'var(--text3)' : 'var(--text)', fontSize: 12, cursor: pageSafe === 0 ? 'default' : 'pointer' }}>Prev</button>
              <span style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'DM Mono' }}>Page {pageSafe + 1} of {pageCount}</span>
              <button onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={pageSafe >= pageCount - 1} style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: pageSafe >= pageCount - 1 ? 'var(--text3)' : 'var(--text)', fontSize: 12, cursor: pageSafe >= pageCount - 1 ? 'default' : 'pointer' }}>Next</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function OrdersView() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<OrderRow[]>([])
  const [bucket, setBucket] = useState<'all' | OrderStatus>('all')
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 100
  // Load window (by ORDER DATE) — keeps the tab fast as history grows.
  const [win, setWin] = useState<'7d' | '30d' | '3mo' | 'all' | 'custom'>('7d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  const [sortKey, setSortKey] = useState<string>('dispatched_at')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [textFilters, setTextFilters] = useState<Record<string, string>>({})
  const [catFilters, setCatFilters] = useState<Record<string, string[]>>({})
  const [dateFilters, setDateFilters] = useState<Record<string, string[]>>({})
  const [openFilter, setOpenFilter] = useState<string | null>(null)
  const [dateTreeOpen, setDateTreeOpen] = useState<Record<string, boolean>>({})
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!openFilter) return
    const h = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setOpenFilter(null) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [openFilter])

  // Resolve the active window to a from/to on order_date (ISO date strings).
  const range = useMemo<{ from: string | null; to: string | null }>(() => {
    const now = new Date()
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    const back = (days: number) => iso(new Date(now.getTime() - days * 86400000))
    if (win === '7d') return { from: back(6), to: null }
    if (win === '30d') return { from: back(29), to: null }
    if (win === '3mo') return { from: back(89), to: null }
    if (win === 'all') return { from: null, to: null }
    return { from: customFrom || null, to: customTo || null }  // custom
  }, [win, customFrom, customTo])

  const loadWindow = useCallback(async () => {
    if (win === 'custom' && (!customFrom || !customTo)) { setRows([]); setLoading(false); return }
    setLoading(true)
    const orders = await fetchAllRows<{ order_id: string; sku: string | null; barcode_sku: string | null; taxable_value: number | null; unit_price: number | null; order_date: string | null; dispatched_at: string | null; delivered_at: string | null; tracking_number: string | null; lr_number: string | null; tracking_status: string | null }>((from, to) => {
      let q = supabase.from('dispatch_orders')
        .select('order_id, sku, barcode_sku, taxable_value, unit_price, order_date, dispatched_at, delivered_at, tracking_number, lr_number, tracking_status')
        .eq('is_dispatched', true).eq('is_cancelled', false)
      if (range.from) q = q.gte('order_date', range.from)
      if (range.to) q = q.lte('order_date', range.to)
      return q.order('order_date', { ascending: false }).order('id', { ascending: false }).range(from, to)
    })

    // Only fetch settlements for the orders in this window (batched by order-id) — keeps it light.
    // Each order can have many settlement LINES (Amazon: ~10, up to 32), so a chunk of order-ids
    // can exceed Supabase's 1000-row response cap. Use a small chunk AND page each .in() request
    // through the cap, or orders past row 1000 silently come back with no settlement -> false "not paid".
    const oids = Array.from(new Set((orders || []).map(o => o.order_id).filter(Boolean)))
    const settle: { order_id: string | null; amount: number | null; transaction_type: string | null; settlement_date: string | null }[] = []
    const CH = 50
    for (let i = 0; i < oids.length; i += CH) {
      const slice = oids.slice(i, i + CH)
      const chunkRows = await fetchAllRows<{ order_id: string | null; amount: number | null; transaction_type: string | null; settlement_date: string | null }>((from, to) =>
        supabase.from('settlements').select('order_id, amount, transaction_type, settlement_date').in('order_id', slice).order('id', { ascending: true }).range(from, to))
      settle.push(...chunkRows)
    }

    const agg: Record<string, { net: number; hasRefund: boolean; payDate: string | null }> = {}
    for (const s of settle) {
      const oid = (s.order_id || '').trim()
      if (!oid) continue
      const a = agg[oid] || { net: 0, hasRefund: false, payDate: null }
      a.net += s.amount || 0
      const tt = (s.transaction_type || '').toLowerCase()
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
      else if (a.net <= 0) status = 'refunded'
      else status = 'paid'
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
  }, [supabase, win, customFrom, customTo, range])

  // Auto-load on mount + when a preset window changes (custom waits for the Load button).
  useEffect(() => { if (win !== 'custom') void loadWindow() }, [win, loadWindow])

  const fmt = (d: string | number | null) => { if (!d) return '—'; const s = String(d); const iso = s.length <= 10 ? s + 'T00:00:00' : s; const dt = new Date(iso); return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) }
  const money = (n: number | null) => n != null ? Math.round(n).toLocaleString('en-IN') : '—'
  const toDay = (v: string | number): string => { const s = String(v || ''); return s ? s.slice(0, 10) : '' }

  const statusLabel: Record<OrderStatus, string> = { paid: 'Paid', notpaid: 'Not paid', refunded: 'Refunded' }
  const pill = (r: OrderRow) => {
    const map: Record<OrderStatus, { bg: string; fg: string }> = {
      paid: { bg: 'var(--dispatched-bg)', fg: 'var(--dispatched)' },
      notpaid: { bg: 'var(--critical-bg)', fg: 'var(--critical)' },
      refunded: { bg: 'var(--today-bg)', fg: 'var(--today)' },
    }
    const m = map[r.status]
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={{ background: m.bg, color: m.fg, padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{statusLabel[r.status]}</span>
        {r.status === 'paid' && r.hasRefund && (<span style={{ background: 'var(--today-bg)', color: 'var(--today)', padding: '2px 6px', borderRadius: 6, fontSize: 10, fontWeight: 700 }}>+refund</span>)}
      </span>
    )
  }

  const COLS: OrdCol[] = useMemo(() => [
    { key: 'order_id', label: 'Order ID', type: 'text', get: r => r.order_id, render: r => <span style={{ fontFamily: 'DM Mono', fontSize: 11 }}>{r.order_id}</span> },
    { key: 'order_date', label: 'Order date', type: 'date', get: r => r.order_date || '', render: r => fmt(r.order_date) },
    { key: 'dispatched_at', label: 'Dispatch date', type: 'date', get: r => r.dispatched_at || '', render: r => fmt(r.dispatched_at) },
    { key: 'delivered_at', label: 'Delivery date', type: 'date', get: r => r.delivered_at || '', render: r => fmt(r.delivered_at) },
    { key: 'payment_date', label: 'Payment date', type: 'date', get: r => toDay(r.payment_date || ''), render: r => fmt(toDay(r.payment_date || '')) },
    { key: 'tracking_ids', label: 'Tracking ID(s)', type: 'text', get: r => r.tracking_ids, render: r => <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>{r.tracking_ids}</span> },
    { key: 'platform', label: 'Platform', type: 'category', get: r => r.platform },
    { key: 'tracking_status', label: 'Tracking status', type: 'category', get: r => r.tracking_status || '(blank)', render: r => <span style={{ color: 'var(--text3)' }}>{r.tracking_status || '—'}</span> },
    { key: 'invoiced', label: 'Amount', type: 'number', align: 'right', get: r => r.invoiced ?? 0, render: r => <span style={{ fontFamily: 'DM Mono' }}>{money(r.invoiced)}</span> },
    { key: 'status', label: 'Status', type: 'category', get: r => statusLabel[r.status], render: r => pill(r) },
  ], [])
  const colByKey = useMemo(() => Object.fromEntries(COLS.map(c => [c.key, c])), [COLS])

  const catOptions = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const c of COLS) if (c.type === 'category') {
      const set = new Set<string>()
      for (const r of rows) set.add(String(c.get(r)) || '(blank)')
      m[c.key] = Array.from(set).sort()
    }
    return m
  }, [COLS, rows])

  const dateTrees = useMemo(() => {
    const m: Record<string, Record<string, Record<string, Set<string>>>> = {}
    for (const c of COLS) if (c.type === 'date') {
      const tree: Record<string, Record<string, Set<string>>> = {}
      for (const r of rows) {
        const day = toDay(c.get(r) as string | number)
        if (!day || day.length < 10) continue
        const [y, mo] = [day.slice(0, 4), day.slice(5, 7)]
        ;(tree[y] ??= {})[mo] ??= new Set<string>()
        tree[y][mo].add(day)
      }
      m[c.key] = tree
    }
    return m
  }, [COLS, rows])

  // bucket-filtered, then column-filtered, then sorted
  const filtered = useMemo(() => {
    let out = rows.filter(r => {
      if (bucket !== 'all' && r.status !== bucket) return false
      for (const key in textFilters) { const v = textFilters[key]; if (!v) continue; const col = colByKey[key]; if (col && !String(col.get(r)).toLowerCase().includes(v.toLowerCase())) return false }
      for (const key in catFilters) { const a = catFilters[key]; if (!a || !a.length) continue; const col = colByKey[key]; if (col && !a.includes(String(col.get(r)) || '(blank)')) return false }
      for (const key in dateFilters) { const days = dateFilters[key]; if (!days || !days.length) continue; const col = colByKey[key]; if (col && !days.includes(toDay(col.get(r) as string | number))) return false }
      return true
    })
    const col = colByKey[sortKey]
    if (col) out = [...out].sort((a, b) => {
      const va = col.get(a), vb = col.get(b)
      const cmp = col.type === 'number' ? (va as number) - (vb as number) : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return out
  }, [rows, bucket, colByKey, textFilters, catFilters, dateFilters, sortKey, sortDir])

  useEffect(() => { setPage(0) }, [bucket, textFilters, catFilters, dateFilters])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageSafe = Math.min(page, pageCount - 1)
  const paged = useMemo(() => filtered.slice(pageSafe * PAGE_SIZE, (pageSafe + 1) * PAGE_SIZE), [filtered, pageSafe])

  const counts = useMemo(() => {
    const c = { all: rows.length, paid: 0, notpaid: 0, refunded: 0 }
    for (const r of rows) c[r.status]++
    return c
  }, [rows])

  const toggleSort = (key: string) => { if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(key); setSortDir('asc') } }
  const hasFilter = (key: string) => !!textFilters[key] || (catFilters[key]?.length ?? 0) > 0 || (dateFilters[key]?.length ?? 0) > 0
  const anyFilter = Object.values(textFilters).some(Boolean) || Object.values(catFilters).some(a => a?.length) || Object.values(dateFilters).some(a => a?.length)
  const clearAll = () => { setTextFilters({}); setCatFilters({}); setDateFilters({}) }

  // Export the currently filtered/sorted rows (all of them, not just the visible page).
  const exportCsv = () => {
    const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const headers = [...COLS.map(c => c.label), 'SKU', 'Net settled']
    const lines = [headers.join(',')]
    for (const r of filtered) lines.push([...COLS.map(c => csvCell(c.get(r))), csvCell(r.sku || ''), csvCell(r.net)].join(','))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `recon-orders-${win}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const monthName = (mo: string) => ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parseInt(mo, 10)] || mo
  const dayNum = (day: string) => parseInt(day.slice(8, 10), 10)
  const toggleDays = (colKey: string, days: string[], on: boolean) => {
    setDateFilters(prev => { const cur = new Set(prev[colKey] || []); if (on) days.forEach(d => cur.add(d)); else days.forEach(d => cur.delete(d)); return { ...prev, [colKey]: Array.from(cur) } })
  }
  const daysUnder = (tree: Record<string, Record<string, Set<string>>>, y?: string, mo?: string): string[] => {
    const out: string[] = []
    for (const yy in tree) { if (y && yy !== y) continue; for (const mm in tree[yy]) { if (mo && mm !== mo) continue; tree[yy][mm].forEach(d => out.push(d)) } }
    return out
  }
  const allChecked = (colKey: string, days: string[]) => { const sel = new Set(dateFilters[colKey] || []); return days.length > 0 && days.every(d => sel.has(d)) }
  const someChecked = (colKey: string, days: string[]) => { const sel = new Set(dateFilters[colKey] || []); return days.some(d => sel.has(d)) }
  const treeNodeOpen = (k: string) => dateTreeOpen[k] ?? false
  const toggleNode = (k: string) => setDateTreeOpen(prev => ({ ...prev, [k]: !(prev[k] ?? false) }))

  const tabs: { key: 'all' | OrderStatus; label: string; n: number }[] = [
    { key: 'all', label: 'All', n: counts.all },
    { key: 'paid', label: 'Paid', n: counts.paid },
    { key: 'notpaid', label: 'Not paid', n: counts.notpaid },
    { key: 'refunded', label: 'Refunded', n: counts.refunded },
  ]

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' as const, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 700 }}>Order date:</span>
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
          {([['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['3mo', 'Last 3 months'], ['all', 'All'], ['custom', 'Custom']] as [typeof win, string][]).map(([key, label]) => (
            <button key={key} onClick={() => setWin(key)} style={{
              padding: '5px 11px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              background: win === key ? 'var(--accent)' : 'transparent', color: win === key ? '#fff' : 'var(--text2)',
            }}>{label}</button>
          ))}
        </div>
        {win === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12 }} />
            <span style={{ color: 'var(--text3)', fontSize: 12 }}>→</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12 }} />
            <button onClick={() => loadWindow()} style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Load</button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' as const, alignItems: 'center' }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setBucket(t.key)} style={{
            padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700,
            border: bucket === t.key ? '2px solid var(--accent)' : '1px solid var(--border)',
            background: bucket === t.key ? 'var(--accent)' : 'var(--surface)',
            color: bucket === t.key ? '#fff' : 'var(--text2)',
          }}>{t.label} {loading ? '' : t.n.toLocaleString()}</button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <button onClick={exportCsv} disabled={loading || !filtered.length} title={anyFilter ? 'Export the filtered rows' : 'Export all rows in this window'} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: filtered.length ? 'var(--text2)' : 'var(--text3)', cursor: filtered.length ? 'pointer' : 'not-allowed', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Download size={12} /> Export CSV{anyFilter ? ' (filtered)' : ''}
          </button>
          {anyFilter && (
            <button onClick={clearAll} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--accent)', cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}><X size={12} /> Clear filters</button>
          )}
        </div>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
        Showing {win === '7d' ? 'orders from the last 7 days' : win === '30d' ? 'orders from the last 30 days' : win === '3mo' ? 'orders from the last 3 months' : win === 'all' ? 'all orders' : 'a custom date range'} (by order date). Counts above reflect this window. Click a header to sort; the funnel to filter (date columns use a Year ▸ Month ▸ Day tree). Status by net settlement amount: no settlement = not paid · net &le; 0 = refunded · net &gt; 0 = paid.
      </div>

      {loading ? (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'auto', maxHeight: 560 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12, minWidth: 1040 }}>
            <thead style={{ background: 'var(--bg2)', position: 'sticky' as const, top: 0, zIndex: 10 }}>
              <tr>
                {COLS.map(col => (
                  <th key={col.key} style={{ padding: '8px 10px', textAlign: col.align === 'right' ? 'right' as const : 'left' as const, whiteSpace: 'nowrap' as const, position: 'relative' as const, userSelect: 'none' as const, background: 'var(--bg2)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, justifyContent: col.align === 'right' ? 'flex-end' : 'flex-start' }}>
                      <span onClick={() => toggleSort(col.key)} style={{ cursor: 'pointer', fontSize: 11, fontWeight: 700, color: sortKey === col.key ? 'var(--accent)' : 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        {col.label}{sortKey === col.key && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                      </span>
                      <button onClick={() => setOpenFilter(openFilter === col.key ? null : col.key)} title="Filter" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 1, display: 'inline-flex', color: hasFilter(col.key) ? 'var(--accent)' : 'var(--text3)', opacity: hasFilter(col.key) ? 1 : 0.45 }}><Filter size={11} /></button>
                    </div>
                    {openFilter === col.key && (
                      <div ref={popRef} style={{ position: 'absolute' as const, top: '100%', left: 0, marginTop: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7, boxShadow: '0 6px 20px rgba(0,0,0,0.14)', padding: 10, zIndex: 50, minWidth: 170, textAlign: 'left' as const }}>
                        {col.type === 'category' ? (
                          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3, maxHeight: 220, overflowY: 'auto' as const }}>
                            {(catOptions[col.key] || []).map(opt => { const cur = catFilters[col.key] || []; const on = cur.includes(opt); return (
                              <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text2)', cursor: 'pointer', padding: '2px 0' }}>
                                <input type="checkbox" checked={on} onChange={() => setCatFilters(prev => { const c = prev[col.key] || []; const next = c.includes(opt) ? c.filter(x => x !== opt) : [...c, opt]; return { ...prev, [col.key]: next } })} />{opt}
                              </label>) })}
                          </div>
                        ) : col.type === 'date' ? (
                          (() => {
                            const tree = dateTrees[col.key] || {}
                            const years = Object.keys(tree).sort((a, b) => b.localeCompare(a))
                            if (!years.length) return <div style={{ fontSize: 12, color: 'var(--text3)', padding: '2px 0' }}>No dates</div>
                            return (
                              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 1, maxHeight: 280, overflowY: 'auto' as const, minWidth: 180 }}>
                                {(dateFilters[col.key]?.length ?? 0) > 0 && (
                                  <button onClick={() => setDateFilters(prev => ({ ...prev, [col.key]: [] }))} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--accent)', fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: '0 0 4px' }}>Clear</button>
                                )}
                                {years.map(y => {
                                  const yKey = `${col.key}|${y}`, yDays = daysUnder(tree, y)
                                  const months = Object.keys(tree[y]).sort((a, b) => b.localeCompare(a))
                                  return (
                                    <div key={y}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 0' }}>
                                        <span onClick={() => toggleNode(yKey)} style={{ cursor: 'pointer', color: 'var(--text3)', display: 'inline-flex', width: 12 }}>{treeNodeOpen(yKey) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                                        <input type="checkbox" checked={allChecked(col.key, yDays)} ref={el => { if (el) el.indeterminate = !allChecked(col.key, yDays) && someChecked(col.key, yDays) }} onChange={e => toggleDays(col.key, yDays, e.target.checked)} />
                                        <span onClick={() => toggleNode(yKey)} style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{y}</span>
                                      </div>
                                      {treeNodeOpen(yKey) && months.map(mo => {
                                        const mKey = `${col.key}|${y}-${mo}`, mDays = daysUnder(tree, y, mo)
                                        const days = Array.from(tree[y][mo]).sort((a, b) => b.localeCompare(a))
                                        return (
                                          <div key={mo} style={{ marginLeft: 17 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 0' }}>
                                              <span onClick={() => toggleNode(mKey)} style={{ cursor: 'pointer', color: 'var(--text3)', display: 'inline-flex', width: 12 }}>{treeNodeOpen(mKey) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                                              <input type="checkbox" checked={allChecked(col.key, mDays)} ref={el => { if (el) el.indeterminate = !allChecked(col.key, mDays) && someChecked(col.key, mDays) }} onChange={e => toggleDays(col.key, mDays, e.target.checked)} />
                                              <span onClick={() => toggleNode(mKey)} style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>{monthName(mo)}</span>
                                            </div>
                                            {treeNodeOpen(mKey) && days.map(d => {
                                              const on = (dateFilters[col.key] || []).includes(d)
                                              return (
                                                <label key={d} style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 17, padding: '2px 0', fontSize: 12, color: 'var(--text2)', cursor: 'pointer', fontFamily: 'DM Mono' }}>
                                                  <input type="checkbox" checked={on} onChange={() => toggleDays(col.key, [d], !on)} />{dayNum(d)}
                                                </label>
                                              )
                                            })}
                                          </div>
                                        )
                                      })}
                                    </div>
                                  )
                                })}
                              </div>
                            )
                          })()
                        ) : (
                          <input autoFocus value={textFilters[col.key] || ''} onChange={e => setTextFilters(prev => ({ ...prev, [col.key]: e.target.value }))} placeholder={`Filter ${col.label}…`} style={{ width: '100%', padding: '6px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, outline: 'none', boxSizing: 'border-box' as const }} />
                        )}
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paged.map((r, i) => (
                <tr key={r.order_id + i} style={{ borderTop: '1px solid var(--border)' }}>
                  {COLS.map(col => (
                    <td key={col.key} style={{ padding: '8px 10px', textAlign: col.align === 'right' ? 'right' as const : 'left' as const, color: 'var(--text2)', whiteSpace: col.key === 'order_id' || col.key === 'tracking_ids' ? 'nowrap' as const : undefined }}>
                      {col.render ? col.render(r) : (col.get(r) || '—')}
                    </td>
                  ))}
                </tr>
              ))}
              {!filtered.length && (
                <tr><td colSpan={COLS.length} style={{ padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>No orders in this view.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {!loading && filtered.length > PAGE_SIZE && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>
            Showing {(pageSafe * PAGE_SIZE + 1).toLocaleString()}–{Math.min((pageSafe + 1) * PAGE_SIZE, filtered.length).toLocaleString()} of {filtered.length.toLocaleString()}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={pageSafe === 0} style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: pageSafe === 0 ? 'var(--text3)' : 'var(--text2)', cursor: pageSafe === 0 ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>Prev</button>
            <span style={{ fontSize: 12, color: 'var(--text2)', fontFamily: 'DM Mono' }}>{pageSafe + 1} / {pageCount}</span>
            <button onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={pageSafe >= pageCount - 1} style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: pageSafe >= pageCount - 1 ? 'var(--text3)' : 'var(--text2)', cursor: pageSafe >= pageCount - 1 ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>Next</button>
          </div>
        </div>
      )}
    </div>
  )
}
