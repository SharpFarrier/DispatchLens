'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'

export type ExportGateStatus = 'loading' | 'owner' | 'none' | 'pending' | 'approved'

const OWNER_EMAIL = 'adityaramnani91581@gmail.com'

export function useExportGate(reportType: string, reportLabel: string) {
  const supabase = createClient()
  const [status, setStatus] = useState<ExportGateStatus>('loading')
  const [reqId, setReqId] = useState<string | null>(null)
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
      .select('id, status, expires_at')
      .eq('requested_by', email).eq('report_type', reportType)
      .order('requested_at', { ascending: false }).limit(1).maybeSingle()
    if (!data) { setStatus('none'); setReqId(null); return }
    if (data.status === 'approved' && data.expires_at && new Date(data.expires_at as string) > new Date()) {
      setStatus('approved'); setReqId(data.id)
    } else if (data.status === 'pending') {
      setStatus('pending'); setReqId(data.id)
    } else {
      setStatus('none'); setReqId(null)
    }
  }, [supabase, reportType])

  useEffect(() => { void refresh() }, [refresh])

  const handleExport = useCallback(async ({ rowCount, summary, doDownload }: { rowCount: number; summary?: string; doDownload: () => void }) => {
    const email = emailRef.current
    if (ownerRef.current) {
      doDownload()
      await supabase.from('export_log').insert({ report_type: reportType, actor: email, action: 'downloaded', row_count: rowCount })
      return
    }
    if (status === 'approved' && reqId) {
      doDownload()
      await supabase.from('export_log').insert({ request_id: reqId, report_type: reportType, actor: email, action: 'downloaded', row_count: rowCount })
      return
    }
    if (status === 'pending' || !email) return
    const { data } = await supabase.from('export_requests').insert({
      report_type: reportType, report_label: reportLabel,
      params: summary ? { summary } : null, row_count: rowCount,
      status: 'pending', requested_by: email,
    }).select('id').maybeSingle()
    if (data) {
      await supabase.from('export_log').insert({ request_id: data.id, report_type: reportType, actor: email, action: 'requested', row_count: rowCount })
      setStatus('pending'); setReqId(data.id)
    }
  }, [supabase, status, reqId, reportType, reportLabel])

  const label = status === 'owner' ? 'Export'
    : status === 'approved' ? 'Download (approved)'
    : status === 'pending' ? 'Requested\u2026'
    : status === 'loading' ? 'Export'
    : 'Request export'
  const disabled = status === 'pending' || status === 'loading'

  return { status, label, disabled, handleExport, refresh }
}
