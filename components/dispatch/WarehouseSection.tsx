'use client'
import { useState } from 'react'
import { Package, ScanLine, PackagePlus, RotateCcw, FileSearch, Boxes, Paintbrush, Hand, Layers } from 'lucide-react'
import InventoryTab from './InventoryTab'
import UnitsTab from './UnitsTab'
import ScanToStockTab from './ScanToStockTab'
import RtoTab from './RtoTab'
import GenerateTab from './GenerateTab'
import StockTab from './StockTab'
import CoatingTab from './CoatingTab'
import PicksTab from './PicksTab'

type TopTab = 'stock' | 'coating' | 'picking' | 'packing'
type PackingTab = 'generate' | 'scan' | 'inventory' | 'rto' | 'units'

const TOP_TABS: { key: TopTab; label: string; icon: React.ReactNode }[] = [
  { key: 'stock',   label: 'Stock',   icon: <Boxes size={14} /> },
  { key: 'coating', label: 'Coating', icon: <Paintbrush size={14} /> },
  { key: 'picking', label: 'Picking', icon: <Hand size={14} /> },
  { key: 'packing', label: 'Packing', icon: <Layers size={14} /> },
]

const PACKING_TABS: { key: PackingTab; label: string; icon: React.ReactNode }[] = [
  { key: 'generate',  label: 'Generate',      icon: <PackagePlus size={14} /> },
  { key: 'scan',      label: 'Scan to Stock', icon: <ScanLine size={14} /> },
  { key: 'inventory', label: 'Inventory',     icon: <Package size={14} /> },
  { key: 'rto',       label: 'RTO',           icon: <RotateCcw size={14} /> },
  { key: 'units',     label: 'Units',         icon: <FileSearch size={14} /> },
]

function tabBtn(active: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '8px 16px', border: 'none', cursor: 'pointer', background: 'transparent',
    color: active ? 'var(--accent)' : 'var(--text2)',
    fontFamily: 'DM Sans', fontWeight: active ? 600 : 400, fontSize: 14,
    borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
    marginBottom: -1, transition: 'all 0.15s',
  }
}

export default function WarehouseSection({ userId }: { userId: string }) {
  const [topTab, setTopTab] = useState<TopTab>('packing')
  const [packingTab, setPackingTab] = useState<PackingTab>('inventory')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Top-level: Stock . Coating . Picking . Packing */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)' }}>
        {TOP_TABS.map(({ key, label, icon }) => (
          <button key={key} onClick={() => setTopTab(key)} style={tabBtn(topTab === key)}>
            {icon}{label}
          </button>
        ))}
      </div>

      {topTab === 'stock' && <StockTab userId={userId} />}
      {topTab === 'coating' && <CoatingTab userId={userId} />}
      {topTab === 'picking' && <PicksTab userId={userId} />}

      {topTab === 'packing' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Inner row: Generate . Scan . Inventory . RTO . Units */}
          <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)' }}>
            {PACKING_TABS.map(({ key, label, icon }) => (
              <button key={key} onClick={() => setPackingTab(key)} style={tabBtn(packingTab === key)}>
                {icon}{label}
              </button>
            ))}
          </div>

          {packingTab === 'generate' && <GenerateTab userId={userId} />}
          {packingTab === 'scan' && <ScanToStockTab />}
          {packingTab === 'inventory' && <InventoryTab />}
          {packingTab === 'rto' && <RtoTab />}
          {packingTab === 'units' && <UnitsTab />}
        </div>
      )}
    </div>
  )
}
