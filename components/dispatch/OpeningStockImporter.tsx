'use client'
import { useState, useMemo, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'

// Parse a barcode into { sku, seq }. Rule: seq is the final hyphen segment,
// sku is everything before it. e.g. ME-B-BL-MB-2-622 -> sku 'ME-B-BL-MB-2', seq 622
function parseBarcode(raw: string): { sku: string; seq: number } | null {
  const bc = (raw || '').trim()
  if (!bc) return null
  const idx = bc.lastIndexOf('-')
  if (idx <= 0 || idx === bc.length - 1) return null
  const seqStr = bc.slice(idx + 1)
  const sku = bc.slice(0, idx)
  if (!/^\d+$/.test(seqStr)) return null
  const seq = parseInt(seqStr, 10)
  if (!Number.isFinite(seq) || seq < 0) return null
  return { sku, seq }
}

// Single-column CSV → array of trimmed non-empty values (skips a 'barcode' header)
function parseCsvColumn(text: string): string[] {
  const lines = text.split(/\r?\n/).map(l => l.split(',')[0].trim()).filter(Boolean)
  if (lines.length && /^barcode$/i.test(lines[0])) lines.shift()
  return lines
}

interface ParsedRow { barcode: string; sku: string; seq: number }
interface Preview {
  stockRows: ParsedRow[]            // valid, known-SKU, de-duped, not-in-DB
  badFormat: string[]               // couldn't parse
  unknownSku: ParsedRow[]           // parsed but SKU not in packed_skus
  fileDupes: string[]               // duplicate barcodes within the file
  dbDupes: string[]                 // barcodes already present in packed_units
  perSku: Record<string, { count: number; min: number; max: number }>
  ceilings: Array<{ sku: string; barcode: string; seq: number; known: boolean; belowStock: boolean; newLastSeq: number }>
  ceilingUnknown: string[]
}

const sectionTitle = { fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }
const card: React.CSSProperties = { background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', padding: 16 }

export default function OpeningStockImporter({ onClose }: { onClose?: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [stockText, setStockText] = useState<string | null>(null)
  const [ceilText, setCeilText] = useState<string | null>(null)
  const [stockName, setStockName] = useState('')
  const [ceilName, setCeilName] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [progress, setProgress] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [skipBad, setSkipBad] = useState(true)

  function readFile(file: File, setText: (s: string) => void, setName: (s: string) => void) {
    const reader = new FileReader()
    reader.onload = () => { setText(String(reader.result || '')); setName(file.name); setPreview(null); setDone(null) }
    reader.readAsText(file)
  }

  const analyze = useCallback(async () => {
    setError(''); setDone(null); setAnalyzing(true)
    try {
      if (!stockText) { setError('Upload the barcodes CSV first'); setAnalyzing(false); return }

      // Known SKUs
      const { data: skuRows, error: skuErr } = await supabase.from('packed_skus').select('sku, last_seq')
      if (skuErr) throw skuErr
      const knownSkus = new Set((skuRows || []).map(r => r.sku))

      // Parse stock file
      const rawBarcodes = parseCsvColumn(stockText)
      const badFormat: string[] = []
      const unknownSku: ParsedRow[] = []
      const seenInFile = new Set<string>()
      const fileDupes: string[] = []
      const candidate: ParsedRow[] = []
      for (const bc of rawBarcodes) {
        const p = parseBarcode(bc)
        if (!p) { badFormat.push(bc); continue }
        const row = { barcode: bc, sku: p.sku, seq: p.seq }
        if (seenInFile.has(bc)) { fileDupes.push(bc); continue }
        seenInFile.add(bc)
        if (!knownSkus.has(p.sku)) { unknownSku.push(row); continue }
        candidate.push(row)
      }

      // DB dupes — check which candidate barcodes already exist in packed_units
      const dbDupes: string[] = []
      const barcodesToCheck = candidate.map(c => c.barcode)
      for (let i = 0; i < barcodesToCheck.length; i += 500) {
        const chunk = barcodesToCheck.slice(i, i + 500)
        const { data: existing, error: exErr } = await supabase.from('packed_units').select('barcode').in('barcode', chunk)
        if (exErr) throw exErr
        ;(existing || []).forEach(e => dbDupes.push(e.barcode))
      }
      const dbDupeSet = new Set(dbDupes)
      const stockRows = candidate.filter(c => !dbDupeSet.has(c.barcode))

      // Per-SKU summary
      const perSku: Preview['perSku'] = {}
      for (const r of stockRows) {
        if (!perSku[r.sku]) perSku[r.sku] = { count: 0, min: r.seq, max: r.seq }
        const s = perSku[r.sku]
        s.count++; s.min = Math.min(s.min, r.seq); s.max = Math.max(s.max, r.seq)
      }

      // Ceilings file
      const ceilings: Preview['ceilings'] = []
      const ceilingUnknown: string[] = []
      if (ceilText) {
        const ceilBarcodes = parseCsvColumn(ceilText)
        for (const bc of ceilBarcodes) {
          const p = parseBarcode(bc)
          if (!p) { ceilingUnknown.push(bc); continue }
          if (!knownSkus.has(p.sku)) { ceilingUnknown.push(bc); continue }
          const stockMax = perSku[p.sku]?.max ?? 0
          ceilings.push({
            sku: p.sku, barcode: bc, seq: p.seq, known: true,
            belowStock: p.seq < stockMax, newLastSeq: p.seq,
          })
        }
      }

      setPreview({ stockRows, badFormat, unknownSku, fileDupes, dbDupes, perSku, ceilings, ceilingUnknown })
    } catch (e) {
      setError('Analyze failed: ' + (e as Error).message)
    }
    setAnalyzing(false)
  }, [stockText, ceilText, supabase])

  const commit = useCallback(async () => {
    if (!preview) return
    if (!skipBad && (preview.badFormat.length || preview.unknownSku.length)) {
      setError('There are invalid rows. Either enable "skip invalid" or fix the file.')
      return
    }
    setError(''); setCommitting(true); setProgress('Starting…')
    try {
      const rows = preview.stockRows.map(r => ({
        barcode: r.barcode, sku: r.sku, seq: r.seq,
        status: 'stocked', source: 'opening_stock',
        stocked_at: new Date().toISOString(),
      }))

      // Insert in chunks of 200
      let inserted = 0
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200)
        const { error: insErr } = await supabase.from('packed_units').insert(chunk)
        if (insErr) throw new Error(`Insert failed around row ${i}: ${insErr.message}`)
        inserted += chunk.length
        setProgress(`Inserted ${inserted} / ${rows.length} units…`)
      }

      // Apply ceilings → set last_seq per SKU
      let ceilCount = 0
      for (const c of preview.ceilings) {
        const { error: upErr } = await supabase.from('packed_skus').update({ last_seq: c.newLastSeq }).eq('sku', c.sku)
        if (upErr) throw new Error(`last_seq update failed for ${c.sku}: ${upErr.message}`)
        ceilCount++
        setProgress(`Set last_seq for ${ceilCount} / ${preview.ceilings.length} SKUs…`)
      }

      setDone(`✓ Imported ${inserted} units as opening stock. Set generation ceiling for ${ceilCount} SKUs.`)
      setPreview(null); setStockText(null); setCeilText(null); setStockName(''); setCeilName('')
    } catch (e) {
      setError('Commit failed: ' + (e as Error).message)
    }
    setCommitting(false); setProgress('')
  }, [preview, skipBad, supabase])

  const fileInput = (label: string, name: string, onPick: (f: File) => void) => (
    <label style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '12px 16px' }}>
      <div>
        <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: 13 }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>{name || 'No file selected'}</div>
      </div>
      <span style={{ padding: '6px 14px', borderRadius: 8, background: 'var(--accent-bg)', color: 'var(--accent)', fontSize: 12, fontWeight: 700 }}>Choose CSV</span>
      <input type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) onPick(f) }} />
    </label>
  )

  const stat = (label: string, val: number | string, colour = 'var(--text)') => (
    <div style={{ flex: 1, textAlign: 'center', padding: '10px 8px', background: 'var(--bg2)', borderRadius: 10, border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: colour }}>{val}</div>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginTop: 2 }}>{label}</div>
    </div>
  )

  const skuList = preview ? Object.entries(preview.perSku).sort((a, b) => a[0].localeCompare(b[0])) : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', margin: 0 }}>Import Opening Stock</h3>
        {onClose && <button onClick={onClose} style={{ color: 'var(--text3)', fontSize: 20, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}>×</button>}
      </div>
      <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
        One-time import of existing warehouse stock. Upload your scanned barcodes and the per-SKU ceiling barcodes, review the preview, then commit. Nothing is written until you press Commit.
      </p>

      <div>
        <div style={sectionTitle}>1 · Scanned barcodes (your stock on hand)</div>
        {fileInput('barcodes.csv', stockName, f => readFile(f, setStockText, setStockName))}
      </div>
      <div>
        <div style={sectionTitle}>2 · Ceiling barcodes (highest used per SKU — sets where new generation resumes)</div>
        {fileInput('seq_ceilings.csv', ceilName, f => readFile(f, setCeilText, setCeilName))}
      </div>

      <button onClick={analyze} disabled={!stockText || analyzing}
        style={{ width: '100%', padding: 12, background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 14, borderRadius: 10, border: 'none', cursor: 'pointer', opacity: (!stockText || analyzing) ? 0.4 : 1 }}>
        {analyzing ? 'Analyzing…' : 'Analyze (preview, no writes)'}
      </button>

      {error && <div style={{ ...card, borderColor: 'var(--critical)', color: 'var(--critical)', fontSize: 13, fontWeight: 600 }}>{error}</div>}
      {done && <div style={{ ...card, borderColor: 'var(--dispatched)', background: 'var(--dispatched-bg)', color: 'var(--dispatched)', fontSize: 13, fontWeight: 700 }}>{done}</div>}

      {preview && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={sectionTitle}>Stock summary</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {stat('Will import', preview.stockRows.length, 'var(--dispatched)')}
              {stat('Bad format', preview.badFormat.length, preview.badFormat.length ? 'var(--critical)' : 'var(--text3)')}
              {stat('Unknown SKU', preview.unknownSku.length, preview.unknownSku.length ? 'var(--critical)' : 'var(--text3)')}
              {stat('File dupes', preview.fileDupes.length, preview.fileDupes.length ? 'var(--today)' : 'var(--text3)')}
              {stat('Already in DB', preview.dbDupes.length, preview.dbDupes.length ? 'var(--today)' : 'var(--text3)')}
            </div>
          </div>

          {(preview.badFormat.length > 0 || preview.unknownSku.length > 0) && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={skipBad} onChange={e => setSkipBad(e.target.checked)} />
              Skip the {preview.badFormat.length + preview.unknownSku.length} invalid row(s) and import the rest
            </label>
          )}

          {preview.unknownSku.length > 0 && (
            <div style={{ ...card }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--critical)', marginBottom: 6 }}>Unknown SKUs (first 20)</div>
              <div style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'DM Mono', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {preview.unknownSku.slice(0, 20).map((r, i) => <span key={i}>{r.barcode}</span>)}
                {preview.unknownSku.length > 20 && <span>+{preview.unknownSku.length - 20} more</span>}
              </div>
            </div>
          )}

          {/* Ceiling summary */}
          <div>
            <div style={sectionTitle}>Generation ceilings</div>
            {!ceilText ? (
              <div style={{ ...card, color: 'var(--today)', fontSize: 13, fontWeight: 600 }}>
                ⚠ No ceiling file uploaded. last_seq will NOT be changed — new Generate could collide with imported barcodes. Upload seq_ceilings.csv unless you're sure.
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  {stat('Ceilings set', preview.ceilings.length, 'var(--accent)')}
                  {stat('Unrecognised', preview.ceilingUnknown.length, preview.ceilingUnknown.length ? 'var(--critical)' : 'var(--text3)')}
                  {stat('Below stock ⚠', preview.ceilings.filter(c => c.belowStock).length, preview.ceilings.some(c => c.belowStock) ? 'var(--critical)' : 'var(--text3)')}
                </div>
                {preview.ceilings.some(c => c.belowStock) && (
                  <div style={{ ...card, borderColor: 'var(--critical)', fontSize: 12, color: 'var(--critical)', fontWeight: 600 }}>
                    Some ceiling seqs are LOWER than the highest stock seq for that SKU — that's contradictory (you have stock above the ceiling). Fix before committing:
                    <div style={{ fontFamily: 'DM Mono', marginTop: 6, color: 'var(--text3)' }}>
                      {preview.ceilings.filter(c => c.belowStock).slice(0, 10).map(c => `${c.sku} (ceiling ${c.seq} < stock ${preview.perSku[c.sku]?.max})`).join(', ')}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Per-SKU table */}
          {skuList.length > 0 && (
            <div>
              <div style={sectionTitle}>Per-SKU counts ({skuList.length} SKUs)</div>
              <div style={{ ...card, padding: 0, overflow: 'auto', maxHeight: 320 }}>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead style={{ background: 'var(--bg2)', position: 'sticky', top: 0 }}>
                    <tr>
                      <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: 'var(--text3)' }}>SKU</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: 'var(--text3)' }}>Units</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: 'var(--text3)' }}>Seq range</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: 'var(--text3)' }}>New ceiling</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skuList.map(([sku, s]) => {
                      const ceil = preview.ceilings.find(c => c.sku === sku)
                      return (
                        <tr key={sku} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text)' }}>{sku}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 800, color: 'var(--accent)' }}>{s.count}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text3)', fontSize: 12 }}>{s.min}–{s.max}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: ceil ? 'var(--text2)' : 'var(--text3)', fontSize: 12 }}>{ceil ? ceil.seq : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <button onClick={commit} disabled={committing || preview.stockRows.length === 0 || preview.ceilings.some(c => c.belowStock)}
            style={{ width: '100%', padding: 14, background: 'var(--dispatched)', color: '#fff', fontWeight: 700, fontSize: 15, borderRadius: 10, border: 'none', cursor: 'pointer', opacity: (committing || preview.stockRows.length === 0 || preview.ceilings.some(c => c.belowStock)) ? 0.4 : 1 }}>
            {committing ? (progress || 'Committing…') : `Commit — import ${preview.stockRows.length} units${preview.ceilings.length ? ` + set ${preview.ceilings.length} ceilings` : ''}`}
          </button>
        </div>
      )}
    </div>
  )
}
