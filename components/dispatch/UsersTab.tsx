'use client'
import { useState, useEffect } from 'react'
import { UserAccess } from '@/types'
import { CheckCircle, Clock, XCircle, RefreshCw } from 'lucide-react'

const DISPATCH_TOGGLES: { key: keyof UserAccess; label: string; desc: string }[] = [
  { key: 'can_import',   label: 'Import',   desc: 'Paste & import planning data' },
  { key: 'can_plan',     label: 'Plan',     desc: 'Mark dispatch/hold/unfulfillable' },
  { key: 'can_review',   label: 'Review',   desc: 'Assign target dates, cancel orders' },
  { key: 'can_picklist', label: 'Picklist', desc: 'View picklist, mark SKU unfulfillable' },
  { key: 'can_eod',      label: 'EOD',      desc: 'Upload Shypassist, confirm dispatch' },
  { key: 'can_dispatched', label: 'Dispatched', desc: 'View dispatched orders, sync tracking' },
  { key: 'can_returns',  label: 'Returns',  desc: 'Returns tracker & refunds' },
  { key: 'can_users',    label: 'Users',    desc: 'Manage user access (admin only)' },
]

const WAREHOUSE_TOGGLES: { key: keyof UserAccess; label: string; desc: string }[] = [
  { key: 'can_wh_stock',         label: 'Stock',      desc: 'Warehouse: stock inward' },
  { key: 'can_wh_coating',       label: 'Coating',    desc: 'Warehouse: powder coating' },
  { key: 'can_wh_picking',       label: 'Picking',    desc: 'Warehouse: frame picking' },
  { key: 'can_wh_inventory',     label: 'Inventory',  desc: 'Warehouse: production inventory' },
  { key: 'can_wh_barcodes',      label: 'Barcodes',   desc: 'Warehouse: piece barcode registry' },
  { key: 'can_wh_pack_generate', label: 'Pack·Gen',   desc: 'Packing: generate packed barcodes' },
  { key: 'can_wh_pack_scan',     label: 'Pack·Scan',  desc: 'Packing: scan to stock' },
  { key: 'can_wh_pack_inventory',label: 'Pack·Inv',   desc: 'Packing: packed inventory' },
  { key: 'can_wh_pack_rto',      label: 'Pack·RTO',   desc: 'Packing: RTO handling' },
  { key: 'can_wh_pack_units',    label: 'Pack·Units', desc: 'Packing: unit lookup' },
]

// All access keys, for save payloads.
const ALL_ACCESS_KEYS: (keyof UserAccess)[] = [...DISPATCH_TOGGLES, ...WAREHOUSE_TOGGLES].map(t => t.key)

// Role presets — one-click sets of permissions. Applying one flips the listed keys
// ON and everything else OFF; the admin can still fine-tune afterward before saving.
const ROLE_PRESETS: { label: string; desc: string; keys: (keyof UserAccess)[] }[] = [
  { label: 'Dispatch Manager', desc: 'Full dispatch pipeline + dispatched view',
    keys: ['can_import', 'can_plan', 'can_review', 'can_picklist', 'can_eod', 'can_dispatched'] },
  { label: 'Returns Manager', desc: 'Returns tracker + dispatched view',
    keys: ['can_returns', 'can_dispatched'] },
  { label: 'Warehouse Operator', desc: 'Stock, coating, picking, inventory, barcodes',
    keys: ['can_wh_stock', 'can_wh_coating', 'can_wh_picking', 'can_wh_inventory', 'can_wh_barcodes'] },
  { label: 'Packing Operator', desc: 'All packing sub-tabs',
    keys: ['can_wh_pack_generate', 'can_wh_pack_scan', 'can_wh_pack_inventory', 'can_wh_pack_rto', 'can_wh_pack_units'] },
  { label: 'Full Warehouse', desc: 'Every warehouse + packing permission',
    keys: ['can_wh_stock', 'can_wh_coating', 'can_wh_picking', 'can_wh_inventory', 'can_wh_barcodes', 'can_wh_pack_generate', 'can_wh_pack_scan', 'can_wh_pack_inventory', 'can_wh_pack_rto', 'can_wh_pack_units'] },
]

export default function UsersTab({ ownerEmail }: { ownerEmail: string }) {
  const [users, setUsers] = useState<UserAccess[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  // local edits before save
  const [edits, setEdits] = useState<Record<string, Partial<UserAccess>>>({})

  const load = async () => {
    setLoading(true)
    const res = await fetch('/api/access/all')
    const data = await res.json()
    setUsers(data)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const getEdit = (user: UserAccess) => ({ ...user, ...(edits[user.email] || {}) })

  const toggleField = (email: string, field: keyof UserAccess) => {
    setEdits(prev => {
      const current = { ...(prev[email] || {}) }
      const user = users.find(u => u.email === email)!
      const currentVal = field in current ? current[field] : user[field]
      return { ...prev, [email]: { ...current, [field]: !currentVal } }
    })
  }

  // Apply a role preset: set the preset's keys ON, all other access keys OFF, as a local edit.
  const applyPreset = (email: string, keys: (keyof UserAccess)[]) => {
    setEdits(prev => {
      const next: Partial<UserAccess> = {}
      for (const k of ALL_ACCESS_KEYS) (next as Record<string, boolean>)[k] = keys.includes(k)
      return { ...prev, [email]: { ...(prev[email] || {}), ...next } }
    })
  }

  const saveUser = async (user: UserAccess) => {
    const edit = edits[user.email] || {}
    const merged = { ...user, ...edit }
    setSaving(user.email)
    const payload: Record<string, unknown> = { email: user.email, status: 'approved' }
    for (const key of ALL_ACCESS_KEYS) payload[key] = merged[key] ?? false
    const res = await fetch('/api/access', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      const updated = await res.json()
      setUsers(prev => prev.map(u => u.email === user.email ? updated : u))
      setEdits(prev => { const n = { ...prev }; delete n[user.email]; return n })
    }
    setSaving(null)
  }

  const rejectUser = async (email: string) => {
    setSaving(email)
    const payload: Record<string, unknown> = { email, status: 'rejected' }
    for (const key of ALL_ACCESS_KEYS) payload[key] = false
    const res = await fetch('/api/access', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      const updated = await res.json()
      setUsers(prev => prev.map(u => u.email === email ? updated : u))
    }
    setSaving(null)
  }

  const pending = users.filter(u => u.status === 'pending')
  const approved = users.filter(u => u.status === 'approved' && u.email !== ownerEmail)
  const rejected = users.filter(u => u.status === 'rejected')
  const owner = users.find(u => u.email === ownerEmail)

  const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

  const UserCard = ({ user, showSave = true }: { user: UserAccess; showSave?: boolean }) => {
    const e = getEdit(user)
    const hasEdits = !!edits[user.email]
    const isOwnerRow = user.email === ownerEmail
    const isSaving = saving === user.email

    return (
      <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
        {/* User info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{user.email}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2, fontFamily: 'DM Mono' }}>
              Requested {new Date(user.requested_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {user.status === 'pending' && <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#d97706', background: '#fef3c7', padding: '3px 10px', borderRadius: 20, border: '1px solid #fde68a' }}><Clock size={11} /> Pending</span>}
            {user.status === 'approved' && <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--dispatched)', background: 'var(--dispatched-bg)', padding: '3px 10px', borderRadius: 20, border: '1px solid #bbf7d0' }}><CheckCircle size={11} /> Approved</span>}
            {user.status === 'rejected' && <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--critical)', background: 'var(--critical-bg)', padding: '3px 10px', borderRadius: 20, border: '1px solid #fecaca' }}><XCircle size={11} /> Rejected</span>}
          </div>
        </div>

        {/* Toggles — grouped: Dispatch then Warehouse */}
        {(() => {
          const renderToggle = ({ key, label, desc }: { key: keyof UserAccess; label: string; desc: string }) => {
            const isOn = e[key] as boolean
            const isDisabled = isOwnerRow
            return (
              <div key={key} title={desc} style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 6 }}>
                <button
                  onClick={() => !isDisabled && toggleField(user.email, key)}
                  disabled={isDisabled}
                  style={{
                    width: 44, height: 24, borderRadius: 12, border: 'none',
                    background: isOn ? 'var(--dispatched)' : 'var(--border2)',
                    cursor: isDisabled ? 'default' : 'pointer',
                    position: 'relative' as const, transition: 'background 0.2s',
                    flexShrink: 0,
                  }}
                >
                  <div style={{
                    width: 18, height: 18, borderRadius: '50%', background: '#fff',
                    position: 'absolute' as const, top: 3,
                    left: isOn ? 23 : 3,
                    transition: 'left 0.2s',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }} />
                </button>
                <span style={{ fontSize: 10, fontFamily: 'DM Mono', color: isOn ? 'var(--text)' : 'var(--text3)', fontWeight: isOn ? 500 : 400, textAlign: 'center' as const }}>{label}</span>
              </div>
            )
          }
          return (
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
              {/* Role presets — one click sets a sensible toggle set, still editable before save */}
              {!isOwnerRow && (
                <div>
                  <div style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--text3)', letterSpacing: '0.05em', marginBottom: 8 }}>QUICK ROLE</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
                    {ROLE_PRESETS.map(p => (
                      <button key={p.label} title={p.desc} onClick={() => applyPreset(user.email, p.keys)}
                        style={{ fontSize: 11, fontWeight: 600, fontFamily: 'DM Sans', color: 'var(--accent)', background: 'var(--accent-bg)', border: '1px solid var(--accent)', borderRadius: 20, padding: '4px 12px', cursor: 'pointer', whiteSpace: 'nowrap' as const }}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <div style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--text3)', letterSpacing: '0.05em', marginBottom: 8 }}>DISPATCH</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 8 }}>
                  {DISPATCH_TOGGLES.map(renderToggle)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--text3)', letterSpacing: '0.05em', marginBottom: 8 }}>WAREHOUSE</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
                  {WAREHOUSE_TOGGLES.map(renderToggle)}
                </div>
              </div>
            </div>
          )
        })()}

        {/* Actions */}
        {showSave && !isOwnerRow && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => saveUser(user)}
              disabled={isSaving}
              style={{
                padding: '7px 18px', borderRadius: 7, border: 'none',
                background: hasEdits ? 'var(--accent)' : 'var(--dispatched)',
                color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                opacity: isSaving ? 0.7 : 1,
              }}
            >
              {isSaving ? 'Saving…' : user.status === 'pending' ? 'Approve & Save' : 'Save Changes'}
            </button>
            {user.status !== 'rejected' && (
              <button
                onClick={() => rejectUser(user.email)}
                disabled={isSaving}
                style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid #fecaca', background: 'var(--critical-bg)', color: 'var(--critical)', fontSize: 13, cursor: 'pointer', fontWeight: 500 }}
              >
                Reject
              </button>
            )}
            {user.status === 'rejected' && (
              <button onClick={() => saveUser(user)} disabled={isSaving} style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid #bbf7d0', background: 'var(--dispatched-bg)', color: 'var(--dispatched)', fontSize: 13, cursor: 'pointer', fontWeight: 500 }}>
                Re-approve
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>Users</h1>
        <button onClick={load} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text2)', cursor: 'pointer', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text3)', padding: 40, textAlign: 'center' as const }}>Loading users…</div>
      ) : (
        <>
          {/* Pending */}
          {pending.length > 0 && (
            <section>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <h2 style={{ fontSize: 13, fontWeight: 600, fontFamily: 'DM Mono', color: '#d97706' }}>PENDING APPROVAL</h2>
                <span style={{ fontSize: 12, background: '#fef3c7', color: '#d97706', border: '1px solid #fde68a', borderRadius: 20, padding: '1px 8px' }}>{pending.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                {pending.map(u => <UserCard key={u.email} user={u} />)}
              </div>
            </section>
          )}

          {/* Approved */}
          {approved.length > 0 && (
            <section>
              <h2 style={{ fontSize: 13, fontWeight: 600, fontFamily: 'DM Mono', color: 'var(--dispatched)', marginBottom: 12 }}>APPROVED</h2>
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                {approved.map(u => <UserCard key={u.email} user={u} />)}
              </div>
            </section>
          )}

          {/* Owner */}
          {owner && (
            <section>
              <h2 style={{ fontSize: 13, fontWeight: 600, fontFamily: 'DM Mono', color: 'var(--text3)', marginBottom: 12 }}>OWNER</h2>
              <UserCard user={owner} showSave={false} />
            </section>
          )}

          {/* Rejected */}
          {rejected.length > 0 && (
            <section>
              <h2 style={{ fontSize: 13, fontWeight: 600, fontFamily: 'DM Mono', color: 'var(--critical)', marginBottom: 12 }}>REJECTED</h2>
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                {rejected.map(u => <UserCard key={u.email} user={u} />)}
              </div>
            </section>
          )}

          {users.length <= 1 && (
            <div style={{ ...card, padding: 48, textAlign: 'center' as const, color: 'var(--text2)' }}>
              No other users have requested access yet.
            </div>
          )}
        </>
      )}
    </div>
  )
}
