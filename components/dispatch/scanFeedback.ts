// ============================================================
// scanFeedback.ts — audio cues for the scanning station.
// Web Audio API (no files). High beep = success, low buzz = error,
// mid blip = warning. Lets an operator work by ear.
// ============================================================

let ctx: AudioContext | null = null
function audioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  return ctx
}

function tone(freq: number, durationMs: number, type: OscillatorType = 'sine', gain = 0.15) {
  const ac = audioCtx()
  if (!ac) return
  if (ac.state === 'suspended') ac.resume()
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = type
  osc.frequency.value = freq
  g.gain.value = gain
  osc.connect(g); g.connect(ac.destination)
  const now = ac.currentTime
  osc.start(now)
  g.gain.setValueAtTime(gain, now)
  g.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000)
  osc.stop(now + durationMs / 1000)
}

export function beepSuccess() {
  tone(1180, 90, 'sine', 0.18)
  setTimeout(() => tone(1560, 90, 'sine', 0.18), 70)
}

export function beepError() {
  tone(220, 320, 'square', 0.12)
}

export function beepWarn() {
  tone(660, 160, 'triangle', 0.14)
}
