'use client'
import { useState, useRef, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Eye, Copy, Check } from 'lucide-react'

const OWNER_EMAIL = 'adityaramnani91581@gmail.com'
const REMASK_MS = 5000

// Shared, cached user resolve so N rows don't each hit auth.
let _userPromise: Promise<string> | null = null
function resolveEmail(supabase: ReturnType<typeof createClient>): Promise<string> {
  if (!_userPromise) _userPromise = supabase.auth.getUser().then(({ data }) => data?.user?.email || '')
  return _userPromise!
}

function mask(raw: string): string {
  const d = raw.replace(/\s+/g, '')
  if (d.length <= 4) return '\u2022\u2022\u2022\u2022'
  return d.slice(0, 2) + '\u2022\u2022\u2022\u2022\u2022\u2022' + d.slice(-2)
}

export default function PhoneReveal({ number, orderId }: { number: string | null | undefined; orderId: string | null }) {
  const supabase = createClient()
  const [email, setEmail] = useState<string | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    void resolveEmail(supabase).then(e => { if (alive) { setEmail(e); setIsOwner(e === OWNER_EMAIL) } })
    return () => { alive = false; if (timer.current) clearTimeout(timer.current) }
  }, [supabase])

  if (!number) return <span style={{ color: 'var(--text3)' }}>&mdash;</span>

  const logAction = (action: 'revealed' | 'copied') => {
    void supabase.from('phone_reveal_log').insert({ order_id: orderId, action, actor: email })
  }

  const doReveal = () => {
    setRevealed(true)
    logAction('revealed')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { setRevealed(false); setCopied(false) }, REMASK_MS)
  }

  const doCopy = () => {
    navigator.clipboard?.writeText(number)
    setCopied(true)
    logAction('copied')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { setRevealed(false); setCopied(false) }, REMASK_MS)
  }

  const iconBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 5, border: 'none', background: 'transparent', color: 'var(--text3)', cursor: 'pointer', padding: 0 }

  // Owner: always visible + copy.
  if (isOwner) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 12 }}>{number}</span>
        <button onClick={doCopy} title={copied ? 'Copied' : 'Copy'} style={iconBtn}>{copied ? <Check size={13} style={{ color: 'var(--dispatched)' }} /> : <Copy size={13} />}</button>
      </span>
    )
  }

  // Non-owner: masked -> reveal -> copy -> re-mask.
  if (!revealed) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text2)' }}>{mask(number)}</span>
        <button onClick={doReveal} title="Reveal number" style={iconBtn}><Eye size={13} /></button>
      </span>
    )
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--accent)' }}>{number}</span>
      <button onClick={doCopy} title={copied ? 'Copied' : 'Copy'} style={iconBtn}>{copied ? <Check size={13} style={{ color: 'var(--dispatched)' }} /> : <Copy size={13} style={{ color: 'var(--accent)' }} />}</button>
    </span>
  )
}
