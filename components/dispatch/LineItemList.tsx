'use client'
import { ColourDot, MattressTag } from './warehouse-ui'
import type { FrameItem } from './FramePicker'

// Returns array of missing field labels for a line item.
// Uses item-level flags (size_required, mattress_required, colour_required)
// set by FramePicker at add time.
export function getItemErrors(item: FrameItem, { requireColour = false }: { requireColour?: boolean } = {}): string[] {
  if (item.category === 'parts') return []
  const errors: string[] = []
  if (item.size_required && !item.size) errors.push('Size')
  if (item.mattress_required && !item.mattress) errors.push('Mattress')
  if ((item.colour_required || requireColour) && !item.colour) errors.push('Colour')
  return errors
}

export default function LineItemList({ items, onRemove, invalidIndices = [] }: {
  items: FrameItem[]; onRemove?: (i: number) => void; invalidIndices?: number[]
}) {
  if (!items.length) return (
    <p style={{ fontSize: 13, color: 'var(--text3)', padding: '8px 0', margin: 0 }}>No frames added yet.</p>
  )
  const total = items.reduce((s, i) => s + i.pieces, 0)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((item, i) => {
        const isInvalid = invalidIndices.includes(i)
        return (
          <div key={i}
            style={{
              display: 'flex', alignItems: 'center', borderRadius: 10, padding: '10px 12px', gap: 12,
              border: isInvalid ? '1px solid var(--critical)' : '1px solid var(--border)',
              boxShadow: isInvalid ? '0 0 0 1px var(--critical)' : 'none',
              background: isInvalid ? 'var(--critical-bg)' : 'var(--bg2)',
            }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {item.shape}
                {item.colour && <ColourDot colour={item.colour} />}
                {item.is_assembly && (
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-bg)', padding: '2px 6px', borderRadius: 4 }}>🔩</span>
                )}
                {isInvalid && (
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--critical)', background: 'var(--critical-bg)', padding: '2px 6px', borderRadius: 4 }}>⚠ Incomplete</span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
                {item.size
                  ? <span style={{ fontSize: 12, color: 'var(--text3)' }}>{item.size}</span>
                  : item.size_required && <span style={{ fontSize: 12, color: 'var(--critical)', fontWeight: 600 }}>Size missing</span>}
                {item.mattress && item.mattress !== 'N/A'
                  ? <MattressTag mattress={item.mattress} />
                  : item.mattress_required && !item.mattress && <span style={{ fontSize: 12, color: 'var(--critical)', fontWeight: 600 }}>Mattress missing</span>}
                {item.colour && <span style={{ fontSize: 12, color: 'var(--text3)' }}>{item.colour}</span>}
                {item.category === 'parts' && item.part_name && (
                  <span style={{ fontSize: 12, color: 'var(--text3)' }}>{item.part_name}</span>
                )}
              </div>
            </div>
            <span style={{ fontSize: 20, fontWeight: 800, color: 'var(--accent)', flexShrink: 0 }}>{item.pieces}</span>
            {onRemove && (
              <button onClick={() => onRemove(i)}
                style={{ color: 'var(--critical)', fontSize: 18, fontWeight: 700, lineHeight: 1, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
            )}
          </div>
        )
      })}
      <div style={{ textAlign: 'right', fontSize: 12, fontWeight: 700, color: 'var(--text3)', paddingRight: 4 }}>
        Total: <span style={{ color: 'var(--accent)' }}>{total} pcs</span>
      </div>
    </div>
  )
}
