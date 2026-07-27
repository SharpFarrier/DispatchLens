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
type Tab = 'inbox' | 'notpaid'

interface UploadRow { id: string; platform: string; file_name: string; row_count: number; dedup_ids: string[]; created_at: string }

export default function ReconSection() {
  const supabase = createClient()
  const [tab, setTab] = useState<Tab>('inbox')
  const [uploads, setUploads] = useState<UploadRow[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'warn' | 'err'; text: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [totals, setTotals] = useState<{ amazon: number; flipkart: number; orders: number }>({ amazon: 0, flipkart: 0, orders: 0 })

  const flash = (type: 'ok' | 'warn' | 'err', text: string) => setMsg({ type, text })

  const loadInbox = useCallback(async () => {
    setLoading(true)
    const { data: up } = await supabase.from('settlement_uploads').select('*').order('created_at', { ascending: false })
    setUploads((up as UploadRow[]) || [])
    // Lightweight totals
    const { count: azCount } = await supabase.from('settlements').select('id', { count: 'exact', head: true }).eq('platform', 'amazon')
    const { count: fkCount } = await supabase.from('settlements').select('id', { count: 'exact', head: true }).eq('platform', 'flipkart')
    setTotals(t => ({ ...t, amazon: azCount || 0, flipkart: fkCount || 0 }))
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
    <div style={{ maxWidth: 1000 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        {(['inbox', 'notpaid'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 13, fontWeight: 700,
            background: tab === t ? 'var(--accent)' : 'var(--surface)', color: tab === t ? '#fff' : 'var(--text2)',
          }}>{t === 'inbox' ? 'Settlement Inbox' : 'Not Paid'}</button>
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
        <InboxView uploads={uploads} totals={totals} loading={loading} busy={busy} onFiles={handleFiles} />
      ) : (
        <NotPaidView />
      )}
    </div>
  )
}

// ── Settlement Inbox ──
function InboxView({ uploads, totals, loading, busy, onFiles }: {
  uploads: UploadRow[]; totals: { amazon: number; flipkart: number }; loading: boolean; busy: boolean;
  onFiles: (p: 'amazon' | 'flipkart', f: File[]) => void
}) {
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
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: 'var(--bg2)' }}>
                <tr>
                  {['Platform', 'File', 'Rows', 'IDs', 'Uploaded'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Rows' || h === 'IDs' ? 'right' : 'left', fontSize: 11, fontWeight: 700, color: 'var(--text3)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {uploads.map(u => (
                  <tr key={u.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', textTransform: 'capitalize', fontWeight: 600, color: 'var(--text)' }}>{u.platform}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{u.file_name}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono', color: 'var(--text2)' }}>{u.row_count.toLocaleString()}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono', color: 'var(--text3)' }}>{(u.dedup_ids || []).length}</td>
                    <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text3)' }}>{new Date(u.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                  </tr>
                ))}
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

// ── Not Paid: dispatched orders with no matching settlement ──
function NotPaidView() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<{ order_id: string; sku: string | null; platform: string; dispatched_at: string | null; value: number | null }[]>([])

  useEffect(() => {
    (async () => {
      setLoading(true)
      // Dispatched, non-cancelled orders.
      const orders = await fetchAllRows<{ order_id: string; sku: string | null; barcode_sku: string | null; taxable_value: number | null; unit_price: number | null; dispatched_at: string | null }>((from, to) =>
        supabase.from('dispatch_orders')
          .select('order_id, sku, barcode_sku, taxable_value, unit_price, dispatched_at')
          .eq('is_dispatched', true).eq('is_cancelled', false)
          .order('dispatched_at', { ascending: false }).range(from, to))
      // All settled order ids (any platform).
      const settled = await fetchAllRows<{ order_id: string | null }>((from, to) =>
        supabase.from('settlements').select('order_id').range(from, to))
      const settledSet = new Set((settled || []).map(s => (s.order_id || '').trim()).filter(Boolean))

      const platformOf = (oid: string) => {
        const s = (oid || '').trim()
        if (/^\d{3}-\d{7}-\d{7}$/.test(s)) return 'Amazon'
        if (s.startsWith('OD')) return 'Flipkart'
        if (/^\d{4,6}$/.test(s)) return 'Website'
        return 'Other'
      }
      const notPaid = (orders || [])
        .filter(o => o.order_id && !settledSet.has(o.order_id.trim()))
        .map(o => ({ order_id: o.order_id, sku: o.barcode_sku || o.sku, platform: platformOf(o.order_id), dispatched_at: o.dispatched_at, value: o.taxable_value ?? o.unit_price ?? null }))
      setRows(notPaid)
      setLoading(false)
    })()
  }, [supabase])

  const totalValue = useMemo(() => rows.reduce((s, r) => s + (r.value || 0), 0), [rows])

  return (
    <div>
      <div style={{ ...card, padding: 16, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <AlertTriangle size={18} color="var(--critical)" />
        <div>
          <div style={{ fontSize: 13, color: 'var(--text3)' }}>Dispatched orders with no matching settlement</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)' }}>{loading ? '…' : rows.length.toLocaleString()} orders <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text3)', display: 'inline-flex', alignItems: 'center' }}>· <IndianRupee size={13} />{Math.round(totalValue).toLocaleString('en-IN')} invoiced</span></div>
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>Matched by order id. &ldquo;Value&rdquo; is the invoiced taxable value from the order (expected-price engine comes later).</div>
      {loading ? (
        <div style={{ ...card, padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>Loading…</div>
      ) : !rows.length ? (
        <div style={{ ...card, padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>Every dispatched order has a settlement — nothing outstanding.</div>
      ) : (
        <div style={{ ...card, overflow: 'auto', maxHeight: 520 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: 'var(--bg2)', position: 'sticky' as const, top: 0 }}>
              <tr>
                {['Order ID', 'Platform', 'SKU', 'Dispatched', 'Invoiced'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Invoiced' ? 'right' : 'left', fontSize: 11, fontWeight: 700, color: 'var(--text3)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.order_id + i} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text)' }}>{r.order_id}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text2)' }}>{r.platform}</td>
                  <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>{r.sku || '—'}</td>
                  <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text3)' }}>{r.dispatched_at ? new Date(r.dispatched_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono', color: 'var(--text2)' }}>{r.value != null ? Math.round(r.value).toLocaleString('en-IN') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
