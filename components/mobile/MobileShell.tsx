'use client'
import { useRef, useEffect, type ReactNode } from 'react'

export interface TabItem { key: string; label: string; badge?: number; badgeHot?: boolean }
export interface SheetGroup { title: string; items: TabItem[] }
export interface BottomNavItem { key: string; label: string; icon: ReactNode }

// Presentational mobile chrome. The parent owns navigation state and passes handlers.
// Only mounted on mobile by the parent; desktop never renders this.
export default function MobileShell({
  sectionTabs, activeTab, onTab, onMore, onSearch,
  bottomNav, activeSection, onSection,
}: {
  sectionTabs: TabItem[]
  activeTab: string
  onTab: (key: string) => void
  onMore?: () => void
  onSearch?: () => void
  bottomNav: BottomNavItem[]
  activeSection: string
  onSection: (key: string) => void
}) {
  const tabsRef = useRef<HTMLDivElement>(null)
  // Auto-scroll the active tab into view when it changes.
  useEffect(() => {
    const el = tabsRef.current?.querySelector(`[data-tab="${activeTab}"]`) as HTMLElement | null
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [activeTab])

  return (
    <>
      <header style={{ height: 52, flex: '0 0 52px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px 0 12px', position: 'fixed', top: 0, left: 0, right: 0, zIndex: 30 }}>
        <div style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 14, display: 'grid', placeItems: 'center', flex: '0 0 26px' }}>D</div>
        <div ref={tabsRef} className="no-scrollbar" style={{ flex: 1, display: 'flex', gap: 4, overflowX: 'auto', WebkitMaskImage: 'linear-gradient(90deg,#000 88%,transparent)', maskImage: 'linear-gradient(90deg,#000 88%,transparent)' }}>
          {sectionTabs.map(t => {
            const on = t.key === activeTab
            return (
              <button key={t.key} data-tab={t.key} onClick={() => onTab(t.key)}
                style={{ flex: '0 0 auto', padding: '7px 12px', borderRadius: 9, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', border: 'none', background: on ? 'var(--accent-bg)' : 'transparent', color: on ? 'var(--accent)' : 'var(--text3)', cursor: 'pointer' }}>
                {t.label}{typeof t.badge === 'number' && t.badge > 0 ? ` ${t.badge}` : ''}
              </button>
            )
          })}
          {onMore && (
            <button onClick={onMore} style={{ flex: '0 0 auto', padding: '7px 12px', borderRadius: 9, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer' }}>More ▾</button>
          )}
        </div>
        {onSearch && (
          <button onClick={onSearch} aria-label="Search" style={{ flex: '0 0 34px', width: 34, height: 34, borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', display: 'grid', placeItems: 'center', color: 'var(--text2)', cursor: 'pointer' }}>🔍</button>
        )}
      </header>

      <nav style={{ position: 'fixed', left: 0, right: 0, bottom: 0, height: 58, background: 'var(--surface)', borderTop: '1px solid var(--border)', display: 'flex', zIndex: 35, paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        {bottomNav.map(n => {
          const on = n.key === activeSection
          return (
            <button key={n.key} onClick={() => onSection(n.key)}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, fontSize: 10.5, fontWeight: 600, color: on ? 'var(--accent)' : 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', position: 'relative', minHeight: 56 }}>
              {on && <span style={{ position: 'absolute', top: 0, width: 28, height: 2, borderRadius: 2, background: 'var(--accent)' }} />}
              <span style={{ fontSize: 19 }}>{n.icon}</span>{n.label}
            </button>
          )
        })}
      </nav>
    </>
  )
}

// The "More" bottom sheet — the overflow tabs grouped. Parent controls open/close.
export function MoreSheet({ open, groups, onPick, onClose }: {
  open: boolean
  groups: SheetGroup[]
  onPick: (key: string) => void
  onClose: () => void
}) {
  if (!open) return null
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(20,18,15,0.4)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', borderRadius: '20px 20px 0 0', width: '100%', maxHeight: '72%', padding: '8px 16px calc(18px + env(safe-area-inset-bottom, 0px))', overflowY: 'auto' }}>
        <div style={{ width: 38, height: 4, borderRadius: 3, background: 'var(--border2)', margin: '8px auto 12px' }} />
        {groups.map((g, gi) => (
          <div key={gi}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', letterSpacing: '.04em', margin: gi === 0 ? '2px 2px 7px' : '14px 2px 7px', textTransform: 'uppercase' }}>{g.title}</div>
            {g.items.map(it => (
              <button key={it.key} onClick={() => { onPick(it.key); onClose() }}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 6px', borderRadius: 11, fontSize: 15, fontWeight: 500, width: '100%', border: 'none', background: 'none', color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}>
                {it.label}
                {typeof it.badge === 'number' && it.badge > 0 && (
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono, monospace)', fontSize: 12, fontWeight: 600, color: '#fff', background: it.badgeHot ? 'var(--critical)' : 'var(--text3)', borderRadius: 10, padding: '1px 8px' }}>{it.badge}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
