'use client'
import { useState } from 'react'
import { Package, ScanLine, PackagePlus, RotateCcw, FileSearch } from 'lucide-react'
import InventoryTab from './InventoryTab'

type WarehouseTab = 'generate' | 'scan' | 'inventory' | 'rto' | 'units'

const SUB_TABS: { key: WarehouseTab; label: string; icon: React.ReactNode }[] = [
  { key: 'generate',  label: 'Generate',      icon: <PackagePlus size={14} /> },
  { key: 'scan',      label: 'Scan to Stock', icon: <ScanLine size={14} /> },
  { key: 'inventory', label: 'Inventory',     icon: <Package size={14} /> },
  { key: 'rto',       label: 'RTO',           icon: <RotateCcw size={14} /> },
  { key: 'units',     label: 'Units',         icon: <FileSearch size={14} /> },
]

function Placeholder({ title }: { title: string }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)', padding: 60, textAlign: 'center' as const, color: 'var(--text3)' }}>
      <Package size={28} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
      <p style={{ fontSize: 14, color: 'var(--text2)', fontWeight: 600, marginBottom: 4 }}>{title}</p>
      <p style={{ fontSize: 13 }}>Coming soon — this page is being ported from WareLens.</p>
    </div>
  )
}

export default function WarehouseSection() {
  const [subTab, setSubTab] = useState<WarehouseTab>('inventory')

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 20 }}>
      {/* Sub-tab navigation */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
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
      {subTab === 'inventory' && <InventoryTab />}
      {subTab === 'generate'  && <Placeholder title="Generate Packed Labels" />}
      {subTab === 'scan'      && <Placeholder title="Scan to Stock" />}
      {subTab === 'rto'       && <Placeholder title="RTO Returns" />}
      {subTab === 'units'     && <Placeholder title="Unit Log" />}
    </div>
  )
}
