'use client'
import { useState, useMemo, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { format } from 'date-fns'
import { Spinner, Alert, ColourDot, Th } from './warehouse-ui'
import { useSort } from './warehouse-hooks'
import OpeningStockImporter from './OpeningStockImporter'
import FramePicker, { type FrameItem } from './FramePicker'
import LineItemList from './LineItemList'

const OWNER_EMAIL = 'adityaramnani91581@gmail.com'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

function normaliseMattress(m: string | null): string {
  if (!m) return 'Unknown'
  const s = m.trim().toLowerCase()
  if (s === 'with mattress') return 'With Mattress'
  if (s === 'without mattress') return 'Without Mattress'
  if (s === 'n/a' || s === 'none' || s === 'frame only') return 'Without Mattress'
  return m.trim()
}

const sectionTitle = { fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }
const cardBase: React.CSSProperties = { background: 'var(--surface)', borderRadius: 14, overflow: 'hidden' }
const thStyle: React.CSSProperties = { padding: '8px 12px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: 'var(--text3)' }

const DRILL_TABS = ['received', 'coated', 'picked', 'packed', 'dispatched'] as const

function DrilldownOverlay({ row, data, onClose }: { row: Row; data: Row; onClose: () => void }) {
  const [tab, setTab] = useState<typeof DRILL_TABS[number]>('received')
  const { shipmentItems, coatingItems, pickItems, packPieces, openingStock = [] } = data
  const shape = row.shape, size = row.size || '', mattress = row.mattress

  const receivedEntries = useMemo(() => {
    const fromShipments = shipmentItems.filter((i: Row) => i.shape === shape && (i.size || '') === size && normaliseMattress(i.mattress) === mattress && i.category !== 'parts').map((i: Row) => ({ ...i, date: i.created_at, source: 'shipment' }))
    const fromOpening = openingStock.filter((e: Row) => e.shape === shape && (e.size || '') === size && normaliseMattress(e.mattress) === mattress).map((e: Row) => ({ ...e, date: e.created_at, source: 'opening', supplier: `Opening Stock (${e.entry_type})` }))
    return [...fromOpening, ...fromShipments]
  }, [shipmentItems, openingStock, shape, size, mattress])

  const coatedEntries = useMemo(() => {
    const fromCoating = coatingItems.filter((i: Row) => i.shape === shape && (i.size || '') === size && normaliseMattress(i.mattress) === mattress).map((i: Row) => ({ ...i, date: i.created_at, source: 'coating' }))
    const fromOpening = openingStock.filter((e: Row) => e.entry_type === 'coated' && e.shape === shape && (e.size || '') === size && normaliseMattress(e.mattress) === mattress).map((e: Row) => ({ ...e, date: e.created_at, source: 'opening' }))
    return [...fromOpening, ...fromCoating]
  }, [coatingItems, openingStock, shape, size, mattress])

  const pickedEntries = useMemo(() => pickItems.filter((i: Row) => i.shape === shape && (i.size || '') === size && normaliseMattress(i.mattress) === mattress).map((i: Row) => ({ ...i, date: i.created_at })), [pickItems, shape, size, mattress])
  const packedEntries = useMemo(() => packPieces.filter((p: Row) => p.shape === shape && (p.size || '') === size && (p.status === 'packed' || p.status === 'dispatched')), [packPieces, shape, size])
  const dispatchedEntries = useMemo(() => packPieces.filter((p: Row) => p.shape === shape && (p.size || '') === size && p.status === 'dispatched'), [packPieces, shape, size])

  const entriesMap: Record<string, Row[]> = { received: receivedEntries, coated: coatedEntries, picked: pickedEntries, packed: packedEntries, dispatched: dispatchedEntries }
  const totalsMap: Record<string, number> = {
    received: receivedEntries.reduce((s: number, i: Row) => s + i.pieces, 0),
    coated: coatedEntries.reduce((s: number, i: Row) => s + i.pieces, 0),
    picked: pickedEntries.reduce((s: number, i: Row) => s + i.pieces, 0),
    packed: packedEntries.length, dispatched: dispatchedEntries.length,
  }
  const entries = entriesMap[tab]

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', width: '100%', maxWidth: 640, borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div>
            <div style={{ fontWeight: 800, color: 'var(--text)', fontSize: 16 }}>{shape}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>{size && <span>{size} · </span>}<span>{mattress}</span></div>
          </div>
          <button onClick={onClose} style={{ color: 'var(--text3)', fontSize: 24, fontWeight: 700, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ display: 'flex', gap: 12, padding: '16px 20px 0', flexShrink: 0 }}>
          {[{ label: 'Raw Left', val: totalsMap.received - totalsMap.coated }, { label: 'Coated Left', val: totalsMap.coated - totalsMap.picked }].map(c => (
            <div key={c.label} style={{ flex: 1, background: 'var(--bg2)', borderRadius: 10, border: '1px solid var(--border)', padding: '10px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: c.val < 0 ? 'var(--critical)' : c.val === 0 ? 'var(--text3)' : 'var(--accent)' }}>{c.val}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginTop: 2 }}>{c.label}</div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 4, padding: '12px 16px 0', flexShrink: 0, overflowX: 'auto' }}>
          {DRILL_TABS.map(t => {
            const active = tab === t
            return (
              <button key={t} onClick={() => setTab(t)} style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, textTransform: 'capitalize', cursor: 'pointer', border: 'none', background: active ? 'var(--accent)' : 'var(--bg2)', color: active ? '#fff' : 'var(--text3)' }}>
                {t}<span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 999, fontWeight: 800, background: active ? 'rgba(255,255,255,0.25)' : 'var(--border)', color: active ? '#fff' : 'var(--text2)' }}>{totalsMap[t]}</span>
              </button>
            )
          })}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {entries.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 0', color: 'var(--text3)' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>—</div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>No {tab} entries</div>
            </div>
          ) : (
            <div style={{ ...cardBase, border: '1px solid var(--border)', overflow: 'auto' }}>
              <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
                <thead style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
                  <tr>
                    <th style={thStyle}>Date</th>
                    {tab === 'received' && <th style={thStyle}>Supplier</th>}
                    {(tab === 'coated' || tab === 'picked') && <th style={thStyle}>Mattress</th>}
                    {(tab === 'coated' || tab === 'picked') && <th style={thStyle}>Colour</th>}
                    {(tab === 'packed' || tab === 'dispatched') && <th style={thStyle}>SKU</th>}
                    {(tab === 'packed' || tab === 'dispatched') && <th style={thStyle}>Mattress Type</th>}
                    <th style={{ ...thStyle, textAlign: 'right' }}>{tab === 'packed' || tab === 'dispatched' ? 'Units' : 'Pcs'}</th>
                  </tr>
                </thead>
                <tbody>
                  {tab === 'received' && entries.map((e: Row, i: number) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{e.date ? format(new Date(e.date), 'dd MMM yy') : '—'}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text2)', fontWeight: 600 }}>{e.shipments?.supplier || e.supplier || '—'}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 800, color: 'var(--accent)' }}>{e.pieces}</td>
                    </tr>
                  ))}
                  {(tab === 'coated' || tab === 'picked') && entries.map((e: Row, i: number) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{e.date ? format(new Date(e.date), 'dd MMM yy') : '—'}</td>
                      <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text3)' }}>{e.mattress || '—'}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text2)' }}>{e.colour ? <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><ColourDot colour={e.colour} />{e.colour}</span> : '—'}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 800, color: 'var(--accent)' }}>{e.pieces}</td>
                    </tr>
                  ))}
                  {(tab === 'packed' || tab === 'dispatched') && entries.map((e: Row, i: number) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap' }}>—</td>
                      <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text2)' }}>{e.master_sku}</td>
                      <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text3)' }}>{e.mattress_type || '—'}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 800, color: 'var(--accent)' }}>1</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot style={{ background: 'var(--bg2)', borderTop: '2px solid var(--border)' }}>
                  <tr>
                    <td colSpan={3} style={{ padding: '8px 12px', fontSize: 12, fontWeight: 700, color: 'var(--text3)' }}>Total ({entries.length} entries)</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 800, color: 'var(--accent)' }}>{totalsMap[tab]}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function InventoryProdTab() {
  const supabase = useMemo(() => createClient(), [])
  const [activeCard, setActiveCard] = useState<string | null>(null)
  const [drillRow, setDrillRow] = useState<Row | null>(null)
  const [data, setData] = useState<Row | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isFetching, setIsFetching] = useState(false)
  const [isOwner, setIsOwner] = useState(false)
  const [openingMode, setOpeningMode] = useState<null | 'import' | 'frames'>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data: u }) => {
      setIsOwner((u?.user?.email || '').toLowerCase() === OWNER_EMAIL.toLowerCase())
    })
  }, [supabase])

  const load = useCallback(async () => {
    setIsFetching(true)
    // Growable transactional tables are paged past the 1000-row cap; small
    // reference tables (bom_items, products_with_flags) stay single-shot.
    const [sl, cl, pk, os] = await Promise.all([
      fetchAllRows((from, to) => supabase.from('shipment_items').select('*, shipments!inner(status,supplier)').neq('shipments.status', 'deleted').range(from, to)),
      fetchAllRows((from, to) => supabase.from('coating_items').select('*, coating_trolleys!inner(status)').neq('coating_trolleys.status', 'deleted').range(from, to)),
      fetchAllRows((from, to) => supabase.from('pick_items').select('*, pick_sessions!inner(status)').neq('pick_sessions.status', 'deleted').range(from, to)),
      fetchAllRows((from, to) => supabase.from('opening_stock').select('*').range(from, to)),
    ])
    setData({
      shipmentItems: sl || [], coatingItems: cl || [], pickItems: pk || [],
      packPieces: [], // STUB: pack_pieces not in DispatchLens (old packing system)
      openingStock: os || [],
    })
    setIsLoading(false)
    setIsFetching(false)
  }, [supabase])

  useEffect(() => { void load() }, [load])

  if (isLoading) return <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size="lg" /></div>
  if (!data) return null

  const { shipmentItems, coatingItems, pickItems, packPieces, openingStock } = data

  const receivedMap: Record<string, Row> = {}
  shipmentItems.filter((i: Row) => i.category !== 'parts').forEach((i: Row) => {
    const m = normaliseMattress(i.mattress), k = `${i.shape}|${i.size || ''}|${m}`
    if (!receivedMap[k]) receivedMap[k] = { shape: i.shape, size: i.size || '', mattress: m, received: 0 }
    receivedMap[k].received += i.pieces
  })
  openingStock.filter((e: Row) => e.entry_type === 'raw').forEach((e: Row) => {
    const m = normaliseMattress(e.mattress), k = `${e.shape}|${e.size || ''}|${m}`
    if (!receivedMap[k]) receivedMap[k] = { shape: e.shape, size: e.size || '', mattress: m, received: 0 }
    receivedMap[k].received += e.pieces || 0
  })
  openingStock.filter((e: Row) => e.entry_type === 'coated').forEach((e: Row) => {
    const m = normaliseMattress(e.mattress), k = `${e.shape}|${e.size || ''}|${m}`
    if (!receivedMap[k]) receivedMap[k] = { shape: e.shape, size: e.size || '', mattress: m, received: 0 }
    receivedMap[k].received += e.pieces || 0
  })

  const coatedMap: Record<string, Row> = {}
  coatingItems.filter((i: Row) => i.category !== 'parts').forEach((i: Row) => {
    const m = normaliseMattress(i.mattress), k = `${i.shape}|${i.size || ''}|${m}|${i.colour || '_'}`
    if (!coatedMap[k]) coatedMap[k] = { shape: i.shape, size: i.size || '', mattress: m, colour: i.colour, coated: 0 }
    coatedMap[k].coated += i.pieces
  })
  openingStock.filter((e: Row) => e.entry_type === 'coated').forEach((e: Row) => {
    const m = normaliseMattress(e.mattress), k = `${e.shape}|${e.size || ''}|${m}|${e.colour || '_'}`
    if (!coatedMap[k]) coatedMap[k] = { shape: e.shape, size: e.size || '', mattress: m, colour: e.colour, coated: 0 }
    coatedMap[k].coated += e.pieces || 0
  })

  const pickedMap: Record<string, Row> = {}
  pickItems.filter((i: Row) => i.category !== 'parts').forEach((i: Row) => {
    const m = normaliseMattress(i.mattress), k = `${i.shape}|${i.size || ''}|${m}|${i.colour || '_'}`
    if (!pickedMap[k]) pickedMap[k] = { shape: i.shape, size: i.size || '', mattress: m, colour: i.colour, picked: 0 }
    pickedMap[k].picked += i.pieces
  })

  const packedMap: Record<string, Row> = {}
  packPieces.forEach((p: Row) => {
    if (!packedMap[p.master_sku]) packedMap[p.master_sku] = { master_sku: p.master_sku, displayName: p.display_name, shape: p.shape, size: p.size, frameColour: p.frame_colour, mattressType: p.mattress_type, packed: 0, dispatched: 0 }
    if (p.status === 'packed' || p.status === 'dispatched') packedMap[p.master_sku].packed++
    if (p.status === 'dispatched') packedMap[p.master_sku].dispatched++
  })

  const totalReceived = Object.values(receivedMap).reduce((s, r) => s + r.received, 0)
  const totalCoated = Object.values(coatedMap).reduce((s, r) => s + r.coated, 0)
  const totalPicked = Object.values(pickedMap).reduce((s, r) => s + r.picked, 0)
  const totalPacked = Object.values(packedMap).reduce((s, r) => s + r.packed, 0)
  const totalDispatched = Object.values(packedMap).reduce((s, r) => s + r.dispatched, 0)
  const rawStock = Math.max(0, totalReceived - totalCoated)
  const coatedStock = Math.max(0, totalCoated - totalPicked)
  const pickedStock = Math.max(0, totalPicked - totalPacked)
  const finishedStock = Math.max(0, totalPacked - totalDispatched)
  const hasOpeningStock = openingStock.length > 0

  const ssMap: Record<string, Row> = {}
  Object.values(receivedMap).forEach(r => {
    const k = `${r.shape}|${r.size}|${r.mattress}`
    if (!ssMap[k]) ssMap[k] = { shape: r.shape, size: r.size, mattress: r.mattress, received: 0, totalCoated: 0, rawLeft: 0, coatedLeft: 0 }
    ssMap[k].received += r.received
  })
  Object.values(coatedMap).forEach(c => {
    const k = `${c.shape}|${c.size}|${c.mattress}`
    if (!ssMap[k]) ssMap[k] = { shape: c.shape, size: c.size, mattress: c.mattress, received: 0, totalCoated: 0, rawLeft: 0, coatedLeft: 0 }
    ssMap[k].totalCoated += c.coated
  })
  const pipelineRows = Object.values(ssMap).map(r => ({
    ...r,
    rawLeft: r.received - r.totalCoated,
    coatedLeft: r.totalCoated - Object.values(pickedMap).filter(p => `${p.shape}|${p.size}|${p.mattress}` === `${r.shape}|${r.size}|${r.mattress}`).reduce((s, p) => s + p.picked, 0),
  }))


  const issueRows = pipelineRows.filter(r => r.rawLeft < 0 || r.coatedLeft < 0)

  const rawRows = Object.values(ssMap).map(r => ({ ...r, rawLeft: r.received - r.totalCoated })).filter(r => r.rawLeft > 0)
  const coatedRows = Object.values(coatedMap).map(c => {
    const picked = pickedMap[`${c.shape}|${c.size || ''}|${c.mattress}|${c.colour || '_'}`]?.picked || 0
    return { ...c, coatedLeft: c.coated - picked }
  }).filter(r => r.coatedLeft > 0)
  const pickedRows = Object.values(pickedMap).map(p => {
    const usedPacked = Object.values(packedMap).filter(pk => pk.shape === p.shape && pk.size === p.size).reduce((s, pk) => s + pk.packed, 0)
    return { ...p, inPicking: Math.max(0, p.picked - usedPacked) }
  }).filter(r => r.inPicking > 0)
  const productRows = Object.values(packedMap).map(r => ({ ...r, in_stock: r.packed - r.dispatched }))

  const tdL: React.CSSProperties = { padding: '10px 12px', fontWeight: 600, color: 'var(--text2)' }
  const matTag = (m: string) => <span style={{ fontSize: 12, background: 'var(--bg2)', color: 'var(--text3)', fontWeight: 600, padding: '2px 8px', borderRadius: 6 }}>{m}</span>

  function PipelineTable() {
    const [shapeFilter, setShapeFilter] = useState('')
    const uniqueShapes = [...new Set(pipelineRows.map(r => r.shape))].sort()
    const filteredRows = shapeFilter ? pipelineRows.filter(r => r.shape === shapeFilter) : pipelineRows
    const { sorted, sortKey, sortDir, toggleSort } = useSort(filteredRows, 'received', 'desc')
    return (
      <div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          <button onClick={() => setShapeFilter('')} style={{ padding: '4px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: !shapeFilter ? 'none' : '1px solid var(--border)', background: !shapeFilter ? 'var(--accent)' : 'var(--surface)', color: !shapeFilter ? '#fff' : 'var(--text3)' }}>All</button>
          {uniqueShapes.map(s => (
            <button key={s} onClick={() => setShapeFilter(shapeFilter === s ? '' : s)} style={{ padding: '4px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: shapeFilter === s ? 'none' : '1px solid var(--border)', background: shapeFilter === s ? 'var(--accent)' : 'var(--surface)', color: shapeFilter === s ? '#fff' : 'var(--text3)' }}>{s}</button>
          ))}
        </div>
        <div style={{ ...cardBase, border: '1px solid var(--border)', overflow: 'auto' }}>
          <table style={{ width: '100%', fontSize: 14, minWidth: 560, borderCollapse: 'collapse' }}>
            <thead style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
              <tr>
                <Th label="Shape" sortKey="shape" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
                <Th label="Size" sortKey="size" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
                <Th label="Mattress" sortKey="mattress" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
                <Th label="Received" sortKey="received" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} align="right" />
                <Th label="Coated" sortKey="totalCoated" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} align="right" />
                <Th label="Raw Left" sortKey="rawLeft" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} align="right" />
                <Th label="Coated Left" sortKey="coatedLeft" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={i} onClick={() => setDrillRow(r)} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
                  <td style={{ ...tdL, fontWeight: 700, color: 'var(--text)' }}>{r.shape}</td>
                  <td style={{ padding: '10px 12px', color: 'var(--text3)' }}>{r.size || '—'}</td>
                  <td style={{ padding: '10px 12px' }}>{matTag(r.mattress)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: 'var(--text2)' }}>{r.received}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: 'var(--accent)' }}>{r.totalCoated || 0}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, color: r.rawLeft > 0 ? '#9333ea' : r.rawLeft < 0 ? 'var(--critical)' : 'var(--text3)' }}>{r.rawLeft < 0 && '⚠ '}{r.rawLeft}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, color: r.coatedLeft > 0 ? 'var(--accent)' : r.coatedLeft < 0 ? 'var(--critical)' : 'var(--text3)' }}>{r.coatedLeft < 0 && '⚠ '}{r.coatedLeft}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }


  const cardDefs = [
    { key: 'raw', label: 'Raw', val: rawStock, col: '#9333ea' },
    { key: 'coated', label: 'Coated', val: coatedStock, col: 'var(--accent)' },
    { key: 'picked', label: 'Picked', val: pickedStock, col: '#2563eb' },
    { key: 'finished', label: 'Finished', val: finishedStock, col: 'var(--dispatched)' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {drillRow && <DrilldownOverlay row={drillRow} data={{ shipmentItems, coatingItems, pickItems, packPieces, openingStock }} onClose={() => setDrillRow(null)} />}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)', margin: 0 }}>Inventory</h2>
        <button onClick={() => load()} disabled={isFetching} style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
          {isFetching ? <Spinner size="sm" /> : '↻'} Refresh
        </button>
      </div>

      {!hasOpeningStock && <Alert type="warning" message="Opening stock not set. Numbers may be inaccurate until opening stock is added." />}

      {isOwner && (
        <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px dashed var(--border2)', padding: 16 }}>
          {!openingMode ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: 13 }}>Opening Stock <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', background: 'var(--bg2)', padding: '1px 6px', borderRadius: 4, marginLeft: 4 }}>owner only</span></div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>One-time setup of existing warehouse stock.</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setOpeningMode('import')} style={{ padding: '8px 14px', borderRadius: 8, background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 700, border: 'none', cursor: 'pointer' }}>Import Packed Barcodes</button>
                <button onClick={() => setOpeningMode('frames')} style={{ padding: '8px 14px', borderRadius: 8, background: 'var(--surface)', color: 'var(--accent)', fontSize: 12, fontWeight: 700, border: '1px solid var(--accent)', cursor: 'pointer' }}>Add Production Frames</button>
              </div>
            </div>
          ) : openingMode === 'import' ? (
            <OpeningStockImporter onClose={() => setOpeningMode(null)} />
          ) : (
            <ProductionOpeningStock onClose={() => { setOpeningMode(null); void load() }} />
          )}
        </div>
      )}

      {issueRows.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--critical-bg)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 16px' }}>
          <span style={{ fontSize: 18 }}>⚠️</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: 'var(--critical)', fontSize: 13 }}>{issueRows.length} item{issueRows.length > 1 ? 's' : ''} need attention</div>
            <div style={{ fontSize: 12, color: 'var(--critical)', marginTop: 2 }}>{issueRows.slice(0, 3).map(r => `${r.shape} ${r.size || ''}`).join(', ')}{issueRows.length > 3 ? ` +${issueRows.length - 3} more` : ''}</div>
          </div>
        </div>
      )}

      <div>
        <div style={sectionTitle}>Current Stock</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {cardDefs.map(c => (
            <div key={c.key} onClick={() => setActiveCard(activeCard === c.key ? null : c.key)}
              style={{ ...cardBase, border: activeCard === c.key ? '2px solid var(--accent)' : '2px solid var(--border)', padding: 12, textAlign: 'center', cursor: 'pointer' }}>
              <div style={{ fontSize: 24, fontWeight: 800, color: c.col }}>{c.val}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginTop: 4, textTransform: 'uppercase', letterSpacing: 1 }}>{c.label}</div>
            </div>
          ))}
        </div>
      </div>

      <details>
        <summary style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', listStyle: 'none', fontSize: 12, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Pipeline Totals ▼</summary>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginTop: 8 }}>
          {[['Received', totalReceived, 'var(--text2)'], ['Coated', totalCoated, 'var(--accent)'], ['Picked', totalPicked, '#2563eb'], ['Packed', totalPacked, 'var(--accent)'], ['Dispatched', totalDispatched, 'var(--dispatched)']].map(([l, v, c]) => (
            <div key={l as string} style={{ ...cardBase, border: '1px solid var(--border)', padding: 10, textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: c as string }}>{v as number}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 }}>{l as string}</div>
            </div>
          ))}
        </div>
      </details>

      {activeCard === 'raw' && <BreakdownTable title="Raw Stock Breakdown" colour="#9333ea" rows={rawRows} onClose={() => setActiveCard(null)}
        cols={[{ k: 'shape', l: 'Shape' }, { k: 'size', l: 'Size' }, { k: 'mattress', l: 'Mattress' }, { k: 'received', l: 'Received', r: true }, { k: 'rawLeft', l: 'Raw Left', r: true, hi: '#9333ea' }]} defaultSort="rawLeft" />}
      {activeCard === 'coated' && <BreakdownTable title="Coated Stock Breakdown" colour="var(--accent)" rows={coatedRows} onClose={() => setActiveCard(null)}
        cols={[{ k: 'shape', l: 'Shape' }, { k: 'size', l: 'Size' }, { k: 'mattress', l: 'Mattress' }, { k: 'colour', l: 'Colour', dot: true }, { k: 'coated', l: 'Coated', r: true }, { k: 'coatedLeft', l: 'Coated Left', r: true, hi: 'var(--accent)' }]} defaultSort="coatedLeft" />}
      {activeCard === 'picked' && <BreakdownTable title="Picked Stock Breakdown" colour="#2563eb" rows={pickedRows} onClose={() => setActiveCard(null)}
        cols={[{ k: 'shape', l: 'Shape' }, { k: 'size', l: 'Size' }, { k: 'colour', l: 'Colour', dot: true }, { k: 'picked', l: 'Picked', r: true }, { k: 'inPicking', l: 'In Pick', r: true, hi: '#2563eb' }]} defaultSort="inPicking" />}
      {activeCard === 'finished' && <BreakdownTable title="Finished Stock Breakdown" colour="var(--dispatched)" rows={productRows.filter(r => r.in_stock > 0)} onClose={() => setActiveCard(null)}
        cols={[{ k: 'displayName', l: 'Product' }, { k: 'packed', l: 'Packed', r: true }, { k: 'dispatched', l: 'Dispatched', r: true }, { k: 'in_stock', l: 'In Stock', r: true, hi: 'var(--dispatched)' }]} defaultSort="in_stock" />}

      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ ...sectionTitle, marginBottom: 0 }}>Frame Pipeline</div>
          <div style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 600 }}>Tap a row to inspect</div>
        </div>
        <PipelineTable />
      </div>

    </div>
  )
}

// Helper: fragment wrapper so map can return two <tr>s with a key
function FragmentRow({ children }: { children: React.ReactNode }) { return <>{children}</> }

// Generic breakdown table for the 4 stock cards
function BreakdownTable({ title, colour, rows, cols, defaultSort, onClose }: {
  title: string; colour: string; rows: Row[]; defaultSort: string; onClose: () => void
  cols: Array<{ k: string; l: string; r?: boolean; hi?: string; dot?: boolean }>
}) {
  const { sorted, sortKey, sortDir, toggleSort } = useSort(rows, defaultSort, 'desc')
  return (
    <div style={{ background: 'var(--surface)', borderRadius: 14, border: `2px solid ${colour}`, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontWeight: 800, color: colour, fontSize: 13 }}>{title}</span>
        <button onClick={onClose} style={{ color: 'var(--text3)', fontSize: 20, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
      </div>
      <div style={{ overflow: 'auto' }}>
        <table style={{ width: '100%', fontSize: 14, minWidth: 380, borderCollapse: 'collapse' }}>
          <thead style={{ background: 'var(--bg2)' }}>
            <tr>{cols.map(c => <Th key={c.k} label={c.l} sortKey={c.k} currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} align={c.r ? 'right' : 'left'} />)}</tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                {cols.map(c => {
                  const v = row[c.k]
                  if (c.dot) return <td key={c.k} style={{ padding: '8px 12px', color: 'var(--text2)' }}>{v ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ColourDot colour={v} />{v}</span> : '—'}</td>
                  return <td key={c.k} style={{ padding: '8px 12px', textAlign: c.r ? 'right' : 'left', fontWeight: c.hi ? 800 : 600, color: c.hi || 'var(--text2)' }}>{v ?? '—'}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Production opening-stock entry form (raw/coated frames → opening_stock) ──
function ProductionOpeningStock({ onClose }: { onClose: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [entryType, setEntryType] = useState<'raw' | 'coated'>('coated')
  const [items, setItems] = useState<FrameItem[]>([])
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)

  function showToast(msg: string, type = 'success') { setToast({ msg, type }); setTimeout(() => setToast(null), 3000) }

  async function handleSubmit() {
    if (!items.length) { showToast('Add at least one frame', 'error'); return }
    setSubmitting(true)
    try {
      const rows = items.map(l => ({
        entry_type: entryType,
        category: l.category,
        shape: l.shape,
        size: l.size || null,
        mattress: l.mattress || null,
        colour: entryType === 'coated' ? (l.colour || null) : null,
        pieces: l.pieces,
        notes: notes || null,
      }))
      const { error } = await supabase.from('opening_stock').insert(rows)
      if (error) throw error
      showToast(`Saved ${rows.length} opening-stock entr${rows.length > 1 ? 'ies' : 'y'} ✓`)
      setItems([]); setNotes('')
      setTimeout(onClose, 800)
    } catch (e) { showToast('Error: ' + (e as Error).message, 'error') }
    setSubmitting(false)
  }

  const sectionT = { fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 50, padding: '12px 20px', borderRadius: 999, fontSize: 13, fontWeight: 700, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', background: toast.type === 'error' ? 'var(--critical-bg)' : 'var(--dispatched-bg)', color: toast.type === 'error' ? 'var(--critical)' : 'var(--dispatched)', border: '1px solid var(--border)' }}>{toast.msg}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', margin: 0 }}>Production Opening Stock</h3>
        <button onClick={onClose} style={{ color: 'var(--text3)', fontSize: 20, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
      </div>

      <div>
        <div style={sectionT}>Entry Type</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {(['raw', 'coated'] as const).map(t => (
            <button key={t} onClick={() => setEntryType(t)}
              style={{ padding: 12, borderRadius: 10, fontWeight: 700, fontSize: 13, textTransform: 'capitalize', cursor: 'pointer', border: entryType === t ? '2px solid var(--accent)' : '2px solid var(--border)', background: entryType === t ? 'var(--accent-bg)' : 'var(--surface)', color: entryType === t ? 'var(--accent)' : 'var(--text3)' }}>
              {t === 'raw' ? 'Raw (uncoated)' : 'Coated'}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div style={sectionT}>Frames</div>
        <LineItemList items={items} onRemove={i => setItems(p => p.filter((_, idx) => idx !== i))} />
      </div>

      <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', padding: 16 }}>
        <div style={{ fontWeight: 700, color: 'var(--accent)', fontSize: 13, marginBottom: 12 }}>+ Add Frame</div>
        <FramePicker mode="coating" showColour={entryType === 'coated'} onAdd={item => setItems(p => [...p, item])} />
      </div>

      <div>
        <div style={sectionT}>Notes <span style={{ color: 'var(--text3)', fontSize: 12, fontWeight: 400 }}>(optional)</span></div>
        <textarea style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box', resize: 'none' }} rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
      </div>

      <button onClick={handleSubmit} disabled={submitting || !items.length}
        style={{ width: '100%', padding: 14, background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 15, borderRadius: 10, border: 'none', cursor: 'pointer', opacity: (submitting || !items.length) ? 0.4 : 1 }}>
        {submitting ? 'Saving…' : `Save Opening Stock${items.length ? ` (${items.reduce((s, i) => s + i.pieces, 0)} pcs)` : ''}`}
      </button>
    </div>
  )
}
