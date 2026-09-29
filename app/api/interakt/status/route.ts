import { NextResponse } from 'next/server'

// Safe diagnostic: reports whether the server actually has the Interakt env vars, WITHOUT
// revealing any secret. Returns only booleans and lengths + a first/last char fingerprint of
// the webhook token so a value mismatch can be spotted without exposing the token.
export async function GET() {
  const tok = process.env.INTERAKT_WEBHOOK_TOKEN || ''
  const key = process.env.INTERAKT_SECRET_KEY || ''
  const fp = tok.length >= 4 ? `${tok.slice(0, 2)}…${tok.slice(-2)}` : (tok ? 'short' : 'none')
  return NextResponse.json({
    hasWebhookToken: !!tok,
    webhookTokenLength: tok.length,
    webhookTokenFingerprint: fp,
    hasSecretKey: !!key,
    secretKeyLength: key.length,
  })
}
