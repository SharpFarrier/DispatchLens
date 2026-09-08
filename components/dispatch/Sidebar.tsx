'use client'
import { useState } from 'react'
import { LogOut, LayoutGrid, Warehouse as WarehouseIcon, Settings as SettingsIcon } from 'lucide-react'

export interface NavItem { key: string; label: string; count?: number; section: 'orders' | 'warehouse' | 'settings'; show: boolean }

const SECTIONS: { key: NavItem['section']; label: string; icon: React.ReactNode }[] = [
  { key: 'orders', label: 'Orders', icon: <LayoutGrid size={18} /> },
  { key: 'warehouse', label: 'Warehouse', icon: <WarehouseIcon size={18} /> },
  { key: 'settings', label: 'Settings', icon: <SettingsIcon size={18} /> },
]

export default function Sidebar({ items, tab, setTab, username, onSignOut }: {
  items: NavItem[]; tab: string; setTab: (k: string) => void; username: string; onSignOut: () => void
}) {
  const visible = items.filter(i => i.show)
  const bySection = (s: NavItem['section']) => visible.filter(i => i.section === s)
  const sectionOf = (k: string) => visible.find(i => i.key === k)?.section ?? 'orders'
  const [mobileSection, setMobileSection] = useState<NavItem['section']>(sectionOf(tab))

  const navBtn = (i: NavItem) => {
    const active = tab === i.key
    const reviewRed = i.key === 'review' && (i.count ?? 0) > 0
    return (
      <button key={i.key} onClick={() => setTab(i.key)} style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left' as const,
        padding: '7px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
        background: active ? 'var(--accent-solid)' : 'transparent',
        color: active ? '#fff' : 'var(--sidebar-muted)',
        fontSize: 13.5, fontWeight: active ? 600 : 500, fontFamily: 'var(--font-sans)',
        transition: 'background 0.12s, color 0.12s',
      }}
        onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--sidebar-hover)' }}
        onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}>
        <span style={{ flex: 1, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.label}</span>
        {i.count != null && i.count > 0 && (
          <span style={{ fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono)', padding: '0 6px', borderRadius: 10, minWidth: 18, textAlign: 'center' as const,
            background: reviewRed ? 'var(--red)' : (active ? 'rgba(255,255,255,0.2)' : 'var(--sidebar-hover)'),
            color: reviewRed ? '#fff' : (active ? '#fff' : 'var(--sidebar-muted)') }}>{i.count}</span>
        )}
      </button>
    )
  }

  return (
    <>
      {/* ── Desktop rail ── */}
      <aside className="dl-sidebar" style={{
        width: 210, flexShrink: 0, background: 'var(--sidebar)', borderRight: '1px solid var(--sidebar-border)',
        display: 'flex', flexDirection: 'column' as const, height: '100vh', position: 'sticky' as const, top: 0,
        padding: '14px 12px', gap: 4,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '2px 8px 12px', marginBottom: 4 }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent-solid)', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 14, fontFamily: 'var(--font-mono)' }}>D</div>
          <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>DispatchLens</span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' as const, display: 'flex', flexDirection: 'column' as const, gap: 14 }} className="no-scrollbar">
          {(['orders', 'warehouse'] as const).map(sec => bySection(sec).length > 0 && (
            <div key={sec}>
              <div style={{ fontSize: 10.5, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'var(--sidebar-muted)', fontWeight: 600, padding: '0 12px', marginBottom: 6, opacity: 0.7 }}>{sec}</div>
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2 }}>{bySection(sec).map(navBtn)}</div>
            </div>
          ))}
        </div>

        {/* Settings + account pinned bottom */}
        {bySection('settings').length > 0 && (
          <div style={{ borderTop: '1px solid var(--sidebar-border)', paddingTop: 10, marginTop: 6 }}>
            <div style={{ fontSize: 10.5, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'var(--sidebar-muted)', fontWeight: 600, padding: '0 12px', marginBottom: 6, opacity: 0.7 }}>Settings</div>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2 }}>{bySection('settings').map(navBtn)}</div>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 2px', borderTop: '1px solid var(--sidebar-border)', marginTop: 8 }}>
          <span style={{ flex: 1, fontSize: 12.5, color: 'var(--sidebar-muted)', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' }}>{username}</span>
          <button onClick={onSignOut} title="Sign out" style={{ background: 'none', border: '1px solid var(--sidebar-border)', borderRadius: 6, color: 'var(--sidebar-muted)', cursor: 'pointer', padding: '5px 7px', display: 'flex' }}><LogOut size={13} /></button>
        </div>
      </aside>

      {/* ── Mobile: section bottom bar + sub-view strip under the header ── */}
      <div className="dl-mobile-substrip" style={{ display: 'none', gap: 6, overflowX: 'auto' as const, padding: '8px 12px', background: 'var(--panel)', borderBottom: '1px solid var(--line)', position: 'sticky' as const, top: 0, zIndex: 40 }}>
        {bySection(mobileSection).map(i => {
          const active = tab === i.key
          return (
            <button key={i.key} onClick={() => setTab(i.key)} style={{ whiteSpace: 'nowrap' as const, padding: '7px 13px', borderRadius: 20, border: 'none', cursor: 'pointer', fontSize: 13.5, fontWeight: active ? 600 : 500,
              background: active ? 'var(--accent-solid)' : 'var(--panel-2)', color: active ? '#fff' : 'var(--ink-2)' }}>{i.label}</button>
          )
        })}
      </div>
      <nav className="dl-mobile-bottombar" style={{ display: 'none', position: 'fixed' as const, bottom: 0, left: 0, right: 0, zIndex: 60, background: 'var(--sidebar)', borderTop: '1px solid var(--sidebar-border)', padding: '6px 0', justifyContent: 'space-around' }}>
        {SECTIONS.filter(s => bySection(s.key).length > 0).map(s => {
          const active = mobileSection === s.key
          return (
            <button key={s.key} onClick={() => { setMobileSection(s.key); const first = bySection(s.key)[0]; if (first) setTab(first.key) }}
              style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 3, background: 'none', border: 'none', cursor: 'pointer', color: active ? '#fff' : 'var(--sidebar-muted)', fontSize: 10.5, fontWeight: 600, flex: 1 }}>
              {s.icon}{s.label}
            </button>
          )
        })}
      </nav>
    </>
  )
}
