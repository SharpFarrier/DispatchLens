'use client'
import { useState, useEffect } from 'react'

// True below 768px — the single switch for mobile layout across DispatchLens.
// SSR-safe: returns false on the server, resolves on mount (desktop renders unchanged).
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const on = () => setMatches(mql.matches)
    on()
    mql.addEventListener('change', on)
    return () => mql.removeEventListener('change', on)
  }, [query])
  return matches
}

export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767px)')
}
