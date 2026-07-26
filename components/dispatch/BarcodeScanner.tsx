'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { Zap, ZapOff, X } from 'lucide-react'

/**
 * Shared camera barcode scanner — Code-128, tuned for warehouse piece labels.
 *
 * Strategy (best engine available on the device):
 *   1) Native BarcodeDetector (Android Chrome) — restricted to code_128, near-native.
 *   2) ZXing (@zxing/browser) fallback (iOS Safari & others) — Code-128 hint only.
 * Continuous live decode: fires onScan the instant a barcode reads (no shutter),
 * with a short duplicate-guard so one label doesn't fire repeatedly. Torch toggle,
 * wide landscape scan box (1D shape), tap-to-focus.
 *
 * onScan(text) is called for every accepted read. The parent decides what to do
 * (and can keep the scanner open for continuous scanning).
 */
export default function BarcodeScanner({
  onScan,
  onClose,
  dedupeMs = 1500,
}: {
  onScan: (text: string) => void
  onClose?: () => void
  dedupeMs?: number
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const zxingControlsRef = useRef<{ stop: () => void } | null>(null)
  const lastRef = useRef<{ code: string; at: number }>({ code: '', at: 0 })
  const stoppedRef = useRef(false)

  const [torchOn, setTorchOn] = useState(false)
  const [torchAvailable, setTorchAvailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [engine, setEngine] = useState<'native' | 'zxing' | null>(null)

  // Accept a decoded value (with duplicate-guard) and bubble it up.
  const accept = useCallback((raw: string) => {
    const code = (raw || '').trim()
    if (!code) return
    const now = Date.now()
    if (code === lastRef.current.code && now - lastRef.current.at < dedupeMs) return
    lastRef.current = { code, at: now }
    try { navigator.vibrate?.(60) } catch { /* ignore */ }
    onScan(code)
  }, [onScan, dedupeMs])

  const stopEverything = useCallback(() => {
    stoppedRef.current = true
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    try { zxingControlsRef.current?.stop() } catch { /* ignore */ }
    zxingControlsRef.current = null
    const s = streamRef.current
    if (s) { for (const t of s.getTracks()) { try { t.stop() } catch { /* ignore */ } } }
    streamRef.current = null
  }, [])

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks?.()[0]
    if (!track) return
    try {
      const next = !torchOn
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      setTorchOn(next)
    } catch { /* torch not supported */ }
  }, [torchOn])

  useEffect(() => {
    stoppedRef.current = false
    let cancelled = false

    async function start() {
      try {
        // Prefer the rear camera at a decent resolution for barcode sharpness.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
        if (cancelled) { for (const t of stream.getTracks()) t.stop(); return }
        streamRef.current = stream
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        video.setAttribute('playsinline', 'true')
        await video.play().catch(() => {})

        // Torch capability?
        const track = stream.getVideoTracks()[0]
        const caps = (track?.getCapabilities?.() || {}) as MediaTrackCapabilities & { torch?: boolean }
        setTorchAvailable(!!caps.torch)

        // Engine 1: native BarcodeDetector (Android Chrome), Code-128 only.
        const BD = (window as unknown as { BarcodeDetector?: new (o?: { formats: string[] }) => { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> } }).BarcodeDetector
        let supportsNative = false
        if (BD) {
          try {
            const getFormats = (window as unknown as { BarcodeDetector: { getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector.getSupportedFormats
            const formats = getFormats ? await getFormats() : ['code_128']
            supportsNative = formats.includes('code_128')
          } catch { supportsNative = false }
        }

        if (supportsNative && BD) {
          setEngine('native')
          const detector = new BD({ formats: ['code_128'] })
          const tick = async () => {
            if (stoppedRef.current || cancelled) return
            try {
              if (video.readyState >= 2) {
                const codes = await detector.detect(video)
                if (codes && codes.length) accept(codes[0].rawValue)
              }
            } catch { /* transient */ }
            rafRef.current = requestAnimationFrame(tick)
          }
          rafRef.current = requestAnimationFrame(tick)
          return
        }

        // Engine 2: ZXing fallback (iOS/others), Code-128 hint.
        setEngine('zxing')
        const { BrowserMultiFormatReader } = await import('@zxing/browser')
        const { DecodeHintType, BarcodeFormat } = await import('@zxing/library')
        const hints = new Map()
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128])
        hints.set(DecodeHintType.TRY_HARDER, true)
        const reader = new BrowserMultiFormatReader(hints)
        const controls = await reader.decodeFromVideoElement(video, (result) => {
          if (result) accept(result.getText())
        })
        zxingControlsRef.current = controls as unknown as { stop: () => void }
      } catch (e) {
        if (!cancelled) setError((e as Error).message || 'Camera unavailable')
      }
    }

    start()
    return () => { cancelled = true; stopEverything() }
  }, [accept, stopEverything])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ position: 'relative', width: '100%', borderRadius: 10, overflow: 'hidden', background: '#000', aspectRatio: '3 / 4' }}>
        <video ref={videoRef} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} muted playsInline />
        {/* Wide landscape scan guide (1D barcode shape) */}
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: '84%', height: '28%', border: '3px solid rgba(255,255,255,0.9)', borderRadius: 10, boxShadow: '0 0 0 2000px rgba(0,0,0,0.35)' }} />
        </div>
        {/* Controls */}
        <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', gap: 8, pointerEvents: 'auto' }}>
          {torchAvailable && (
            <button onClick={toggleTorch} aria-label="Torch" style={{ width: 40, height: 40, borderRadius: 20, border: 'none', background: torchOn ? '#fbbf24' : 'rgba(0,0,0,0.55)', color: torchOn ? '#000' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              {torchOn ? <Zap size={18} /> : <ZapOff size={18} />}
            </button>
          )}
          {onClose && (
            <button onClick={() => { stopEverything(); onClose() }} aria-label="Close" style={{ width: 40, height: 40, borderRadius: 20, border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <X size={18} />
            </button>
          )}
        </div>
        <div style={{ position: 'absolute', bottom: 8, left: 0, right: 0, textAlign: 'center', color: 'rgba(255,255,255,0.85)', fontSize: 11, fontFamily: 'DM Mono', pointerEvents: 'none' }}>
          {error ? `⚠ ${error}` : `Point at barcode · ${engine === 'native' ? 'fast mode' : engine === 'zxing' ? 'scanning' : 'starting…'}`}
        </div>
      </div>
    </div>
  )
}
