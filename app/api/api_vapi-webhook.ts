// File location in your DispatchLens repo:
// /app/api/vapi-webhook/route.ts
//
// This endpoint receives events from Vapi.ai during and after each call.
// Vapi sends: call-started, transcript, function-call, end-of-call-report

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!   // use service role key, not anon
)

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { message } = body

  // ── 1. End-of-call report ─────────────────────────────────────────────
  // Vapi sends this when a call ends. Contains transcript + summary.
  if (message?.type === 'end-of-call-report') {
    const {
      call,
      transcript,
      summary,
      analysis,
    } = message

    // Extract structured data from Vapi's analysis
    // (we configure these fields in the Vapi assistant settings)
    const structuredData = analysis?.structuredData || {}

    await supabase.from('call_logs').upsert({
      call_id:         call?.id,
      caller_phone:    call?.customer?.number,
      caller_name:     structuredData.caller_name || null,
      order_id:        structuredData.order_id    || null,
      issue_type:      structuredData.issue_type  || 'other',
      issue_summary:   summary || structuredData.issue_summary || null,
      full_transcript: transcript,
      duration_secs:   call?.endedAt && call?.startedAt
                         ? Math.round((new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000)
                         : null,
      status: 'pending',
    }, { onConflict: 'call_id' })

    return NextResponse.json({ received: true })
  }

  // ── 2. Function call: save_complaint ─────────────────────────────────
  // Claude can call this mid-conversation to save details before the call ends
  if (message?.type === 'function-call' && message?.functionCall?.name === 'save_complaint') {
    const params = message.functionCall.parameters || {}

    await supabase.from('call_logs').upsert({
      call_id:      message?.call?.id,
      caller_phone: message?.call?.customer?.number,
      caller_name:  params.caller_name,
      order_id:     params.order_id,
      issue_type:   params.issue_type,
      issue_summary: params.issue_summary,
      status: 'pending',
    }, { onConflict: 'call_id' })

    // Return this to Vapi so Claude can confirm to the customer
    return NextResponse.json({
      result: 'Complaint saved. Your team will call back within 24 hours.'
    })
  }

  // All other event types (call-started, transcript chunks, etc.) — just ack
  return NextResponse.json({ received: true })
}
