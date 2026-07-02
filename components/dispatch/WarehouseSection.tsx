'use client'
import { useState } from 'react'
import { Package, ScanLine, PackagePlus, RotateCcw, FileSearch, Boxes, Paintbrush, Hand, Layers, Warehouse, Tag, Activity } from 'lucide-react'
import InventoryTab from './InventoryTab'
import UnitsTab from './UnitsTab'
import ScanToStockTab from './ScanToStockTab'
import RtoTab from './RtoTab'
import RtoTreatmentTab from './RtoTreatmentTab'
import GenerateTab from './GenerateTab'
import StockTab from './StockTab'
import CoatingTab from './CoatingTab'
import PicksTab from './PicksTab'
import InventoryProdTab from './InventoryProdTab'
import BarcodesTab from './BarcodesTab'
import LifecycleTab from './LifecycleTab'

import { UserAccess } from '@/types'

type TopTab = 'stock' | 'coating' | 'picking' | 'inventory' | 'barcodes' | 'packing'
type PackingTab = 'generate' | 'scan' | 'inventory' | 'lifecycle' | 'rto' | 'treatment' | 'units'

const TOP_TABS: { key: TopTab; label: string; icon: React.ReactNode; perm: keyof UserAccess | 'packing' }[] = [
  { key: 'stock',   label: 'Stock',   icon: <Boxes size={14} />, perm: 'can_wh_stock' },
  { key: 'coating', label: 'Coating', icon: <Paintbrush size={14} />, perm: 'can_wh_coating' },
  { key: 'picking', label: 'Picking', icon: <Hand size={14} />, perm: 'can_wh_picking' },
  { key: 'inventory', label: 'Inventory', icon: <Warehouse size={14} />, perm: 'can_wh_inventory' },
  { key: 'barcodes', label: 'Barcodes', icon: <Tag size={14} />, perm: 'can_wh_barcodes' },
  { key: 'packing', label: 'Packing', icon: <Layers size={14} />, perm: 'packing' },
]

const PACKING_TABS: { key: PackingTab; label: string; icon: React.ReactNode; perm: keyof UserAccess }[] = [
  { key: 'generate',  label: 'Generate',      icon: <PackagePlus size={14} />, perm: 'can_wh_pack_generate' },
  { key: 'scan',      label: 'Scan to Stock', icon: <ScanLine size={14} />, perm: 'can_wh_pack_scan' },
  { key: 'inventory', label: 'Inventory',     icon: <Package size={14} />, perm: 'can_wh_pack_inventory' },
  { key: 'lifecycle', label: 'Lifecycle',     icon: <Activity size={14} />, perm: 'can_wh_pack_units' },
  { key: 'rto',       label: 'RTO',           icon: <RotateCcw size={14} />, perm: 'can_wh_pack_rto' },
  { key: 'treatment', label: 'RTO Treatment', icon: <RotateCcw size={14} />, perm: 'can_wh_pack_rto' },
  { key: 'units',     label: 'Units',         icon: <FileSearch size={14} />, perm: 'can_wh_pack_units' },
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

export default function WarehouseSection({ userId, access }: { userId: string; access: UserAccess }) {
  // Only show sub-tabs the user is permitted to see.
  const packingTabs = PACKING_TABS.filter(t => access[t.perm])
  const topTabs = TOP_TABS.filter(t => t.perm === 'packing' ? packingTabs.length > 0 : access[t.perm as keyof UserAccess])

  const [topTab, setTopTab] = useState<TopTab>(topTabs[0]?.key ?? 'stock')
  const [packingTab, setPackingTab] = useState<PackingTab>(packingTabs[0]?.key ?? 'generate')

  if (topTabs.length === 0) {
    return <div style={{ padding: 48, textAlign: 'center', color: 'var(--text3)' }}>You don&apos;t have access to any warehouse sections.</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Top-level tabs (only permitted ones) */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)' }}>
        {topTabs.map(({ key, label, icon }) => (
          <button key={key} onClick={() => setTopTab(key)} style={tabBtn(topTab === key)}>
            {icon}{label}
          </button>
        ))}
      </div>

      {topTab === 'stock' && <StockTab userId={userId} />}
      {topTab === 'coating' && <CoatingTab userId={userId} />}
      {topTab === 'picking' && <PicksTab userId={userId} />}
      {topTab === 'inventory' && <InventoryProdTab />}
      {topTab === 'barcodes' && <BarcodesTab />}

      {topTab === 'packing' && packingTabs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Inner row (only permitted ones) */}
          <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)' }}>
            {packingTabs.map(({ key, label, icon }) => (
              <button key={key} onClick={() => setPackingTab(key)} style={tabBtn(packingTab === key)}>
                {icon}{label}
              </button>
            ))}
          </div>

          {packingTab === 'generate' && <GenerateTab userId={userId} />}
          {packingTab === 'scan' && <ScanToStockTab />}
          {packingTab === 'inventory' && <InventoryTab />}
          {packingTab === 'lifecycle' && <LifecycleTab userId={userId} />}
          {packingTab === 'rto' && <RtoTab />}
          {packingTab === 'treatment' && <RtoTreatmentTab />}
          {packingTab === 'units' && <UnitsTab />}
        </div>
      )}
    </div>
  )
}
