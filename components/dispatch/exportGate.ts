'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'

export type ExportGateStatus = 'loading' | 'owner' | 'none' | 'pending' | 'approved'

const OWNER_EMAIL = 'adityaramnani91581@gmail.com'
const BUCKET = 'export-reports'
const APPROVED_COOLDOWN_MS = 60_000  // after approval, lock for 1 min, then allow a fresh request

function triggerDownload(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

// B1: exact file stored at request time; approved reports download from the Reports tab.
//  - owner  -> downloads directly, logged.
//  - none/(denied|expired) -> "Request export" -> uploads the exact CSV to Storage + creates request.
//  - pending -> "Requested…".
//  - approved -> "Ready in Reports" (download happens there).
export function useExportGate(reportType: string, reportLabel: string) {
  const supabase = createClient()
  const [status, setStatus] = useState<ExportGateStatus>('loading')
  const [reqId, setReqId] = useState<string | null>(null)
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const emailRef = useRef<string>('')
  const ownerRef = useRef<boolean>(false)

  const refresh = useCallback(async () => {
    const { data: u } = await supabase.auth.getUser()
    const email = u?.user?.email || ''
    emailRef.current = email
    ownerRef.current = email === OWNER_EMAIL
    if (ownerRef.current) { setStatus('owner'); return }
    if (!email) { setStatus('none'); return }
    const { data } = await supabase.from('export_requests')
      .select('id, status, expires_at, decided_at')
      .eq('requested_by', email).eq('report_type', reportType)
      .order('requested_at', { ascending: false }).limit(1).maybeSingle()
    if (!data) { setStatus('none'); setReqId(null); return }
    if (cooldownTimer.current) { clearTimeout(cooldownTimer.current); cooldownTimer.current = null }
    if (data.status === 'approved' && data.expires_at && new Date(data.expires_at as string) > new Date()) {
      // Approved: lock the button for 1 min (so they grab the download), then free it so a
      // NEW filtered report can be requested. The approved report stays in Reports for 7 days.
      const decidedMs = data.decided_at ? new Date(data.decided_at as string).getTime() : 0
      const elapsed = Date.now() - decidedMs
      if (decidedMs && elapsed < APPROVED_COOLDOWN_MS) {
        setStatus('approved'); setReqId(data.id)
        cooldownTimer.current = setTimeout(() => { setStatus('none'); setReqId(null) }, APPROVED_COOLDOWN_MS - elapsed)
      } else {
        setStatus('none'); setReqId(null)   // cooldown passed -> allow a fresh request
      }
    } else if (data.status === 'pending') {
      setStatus('pending'); setReqId(data.id)
    } else {
      setStatus('none'); setReqId(null)
    }
  }, [supabase, reportType])

  useEffect(() => { void refresh(); return () => { if (cooldownTimer.current) clearTimeout(cooldownTimer.current) } }, [refresh])

  const handleExport = useCallback(async ({ rowCount, summary, getCsv, filename }: { rowCount: number; summary?: string; getCsv: () => string; filename: string }) => {
    const email = emailRef.current
    const csv = getCsv()
    if (ownerRef.current) {
      triggerDownload(csv, filename)
      await supabase.from('export_log').insert({ report_type: reportType, actor: email, action: 'downloaded', row_count: rowCount })
      return
    }
    if (status === 'pending' || status === 'approved' || !email) return
    // Upload the exact CSV, then create the request pointing at it.
    const path = `${email.replace(/[^a-zA-Z0-9]/g, '_')}/${reportType}-${Date.now()}.csv`
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, new Blob([csv], { type: 'text/csv' }), { upsert: false })
    if (upErr) return
    const { data } = await supabase.from('export_requests').insert({
      report_type: reportType, report_label: reportLabel,
      params: summary ? { summary, filename } : { filename }, row_count: rowCount,
      status: 'pending', requested_by: email, file_path: path,
    }).select('id').maybeSingle()
    if (data) {
      await supabase.from('export_log').insert({ request_id: data.id, report_type: reportType, actor: email, action: 'requested', row_count: rowCount })
      setStatus('pending'); setReqId(data.id)
    }
  }, [supabase, status, reportType, reportLabel])

  const label = status === 'owner' ? 'Export'
    : status === 'approved' ? 'Ready in Reports'
    : status === 'pending' ? 'Requested\u2026'
    : status === 'loading' ? 'Export'
    : 'Request export'
  const disabled = status === 'pending' || status === 'approved' || status === 'loading'

  return { status, label, disabled, handleExport, refresh }
}
