import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * React hook wrapper around the shared AgUiReducer.
 * Loads the reducer class from /shared/agui-client.js via fetch (same pattern as useTTSStream).
 *
 * The reducer ingests ag-ui events (RUN_STARTED, TOOL_CALL_*, etc.) and maintains
 * structured state. Phase 4 wires this in additively — consumers call `ingest()` for
 * each SSE frame in parallel with their existing legacy event handlers, but the
 * reducer state isn't yet rendered.
 *
 * If the loader fails, `ingest()` is a no-op — UI behavior is unaffected.
 */

let AgUiReducerClass = null
let loadPromise = null

async function loadAgUiReducer() {
  if (AgUiReducerClass) return AgUiReducerClass
  if (loadPromise) return loadPromise

  loadPromise = new Promise(async (resolve, reject) => {
    try {
      const port = window.location.port || '8888'
      const response = await fetch(`http://localhost:${port}/shared/agui-client.js`)
      if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`)
      const code = await response.text()

      // Strip ES module syntax — same approach as useTTSStream
      const exports = {}
      const moduleCode = code
        .replace(/export\s+class\s+AgUiReducer/, 'const AgUiReducer = class')
        .replace(/export\s+default\s+AgUiReducer\s*;?/, '')

      const fn = new Function('exports', moduleCode + '\nexports.AgUiReducer = AgUiReducer;')
      fn(exports)
      AgUiReducerClass = exports.AgUiReducer
      resolve(AgUiReducerClass)
    } catch (err) {
      console.warn('Failed to load AgUiReducer:', err)
      loadPromise = null
      reject(err)
    }
  })
  return loadPromise
}

export function useAgUiReducer() {
  const reducerRef = useRef(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadAgUiReducer().then(Cls => {
      if (cancelled) return
      reducerRef.current = new Cls()
      setReady(true)
    }).catch(() => {
      // Loader failed — reducer stays null, ingest/reset become no-ops
    })
    return () => { cancelled = true }
  }, [])

  const ingest = useCallback((event) => {
    if (reducerRef.current) {
      try { reducerRef.current.ingest(event) } catch {}
    }
  }, [])

  const reset = useCallback(() => {
    if (reducerRef.current) {
      try { reducerRef.current.reset() } catch {}
    }
  }, [])

  const getState = useCallback(() => {
    return reducerRef.current ? reducerRef.current.getState() : null
  }, [])

  return { ingest, reset, getState, ready, reducer: reducerRef.current }
}
