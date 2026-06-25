'use client'
import { useState } from 'react'
import { Package, ScanLine, PackagePlus, RotateCcw, FileSearch } from 'lucide-react'
import InventoryTab from './InventoryTab'
import UnitsTab from './UnitsTab'
import ScanToStockTab from './ScanToStockTab'
import RtoTab from './RtoTab'
import GenerateTab from './GenerateTab'

type WarehouseTab = 'generate' | 'scan' | 'inventory' | 'rto' | 'units'

const SUB_TABS: { key: WarehouseTab; label: string; icon: React.ReactNode }[] = [
  { key: 'generate',  label: 'Generate',      icon: <PackagePlus size={14} /> },
  { key: 'scan',      label: 'Scan to Stock', icon: <ScanLine size={14} /> },
  { key: 'inventory', label: 'Inventory',     icon: <Package size={14} /> },
  { key: 'rto',       label: 'RTO',           icon: <RotateCcw size={14} /> },
  { key: 'units',     label: 'Units',         icon: <FileSearch size={14} /> },
]

export default function WarehouseSection({ userId }: { userId: string }) {
  const [subTab, setSubTab] = useState<WarehouseTab>('inventory')

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 20 }}>
      {/* Sub-tab navigation */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)' }}>
        {SUB_TABS.map(({ key, label, icon }) => {
          const active = subTab === key
          return (
            <button key={key} onClick={() => setSubTab(key)} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', border: 'none', cursor: 'pointer',
              background: 'transparent',
              color: active ? 'var(--accent)' : 'var(--text2)',
              fontFamily: 'DM Sans', fontWeight: active ? 600 : 400, fontSize: 14,
              borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
              marginBottom: -1, transition: 'all 0.15s',
            }}>
              {icon}{label}
            </button>
          )
        })}
      </div>

      {/* Sub-tab content */}
      {subTab === 'generate'  && <GenerateTab userId={userId} />}
      {subTab === 'scan'      && <ScanToStockTab />}
      {subTab === 'inventory' && <InventoryTab />}
      {subTab === 'rto'       && <RtoTab />}
      {subTab === 'units'     && <UnitsTab />}
    </div>
  )
}
