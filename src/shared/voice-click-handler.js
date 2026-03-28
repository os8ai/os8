/**
 * Shared voice button click handling logic.
 * Used by both terminal (OS8 shell) and assistant app.
 *
 * Implements double-click detection for continuous mode with
 * safeguards against accidental restarts after stopping.
 */

export const DOUBLE_CLICK_THRESHOLD = 300 // ms
export const RECENTLY_STOPPED_GRACE_PERIOD = 500 // ms

/**
 * Determines what action to take based on click timing.
 * @param {Object} params
 * @param {number} params.now - Current timestamp
 * @param {number} params.lastClickTime - Time of last click
 * @param {number} params.lastStopTime - Time of last stop action
 * @param {boolean} params.isStreaming - Whether voice is currently streaming
 * @param {boolean} params.isConnecting - Whether voice is connecting
 * @param {boolean} params.isTranscribing - Whether voice is transcribing (batch mode)
 * @returns {'stop' | 'double-click' | 'single-click-pending' | 'ignore'}
 */
export function detectClickAction({
  now,
  lastClickTime,
  lastStopTime,
  isStreaming,
  isConnecting,
  isTranscribing
}) {
  const timeSinceLastClick = now - lastClickTime
  const timeSinceStop = now - lastStopTime

  // If currently streaming, stop immediately
  if (isStreaming) {
    return 'stop'
  }

  // If connecting or transcribing, ignore click
  if (isConnecting || isTranscribing) {
    return 'ignore'
  }

  // Check for double-click - two clicks within 300ms is always intentional
  if (timeSinceLastClick < DOUBLE_CLICK_THRESHOLD) {
    return 'double-click'
  }

  // Single click - but if we recently stopped, ignore to prevent accidental restart
  if (timeSinceStop < RECENTLY_STOPPED_GRACE_PERIOD) {
    return 'ignore'
  }

  // Single click - wait to see if it's a double-click
  return 'single-click-pending'
}

/**
 * Creates a stateful click handler with the shared logic.
 *
 * @param {Object} options
 * @param {Function} options.getState - Returns current voice state {isStreaming, isConnecting, isTranscribing}
 * @param {Function} options.onStop - Called when stopping streaming
 * @param {Function} options.onStartContinuous - Called to start continuous mode (double-click)
 * @param {Function} options.onStartOneShot - Called to start one-shot mode (single click)
 * @returns {Function} Click handler function
 */
export function createVoiceClickHandler({
  getState,
  onStop,
  onStartContinuous,
  onStartOneShot,
}) {
  let lastClickTime = 0
  let lastStopTime = 0

  return function handleClick() {
    const now = Date.now()
    const state = getState()

    const action = detectClickAction({
      now,
      lastClickTime,
      lastStopTime,
      isStreaming: state.isStreaming,
      isConnecting: state.isConnecting,
      isTranscribing: state.isTranscribing
    })

    lastClickTime = now

    switch (action) {
      case 'stop':
        onStop()
        lastStopTime = now
        break

      case 'double-click':
        onStartContinuous()
        break

      case 'single-click-pending':
        setTimeout(() => {
          const currentState = getState()
          const timeSinceClick = Date.now() - lastClickTime
          // Only start if no second click happened AND not already streaming/connecting
          if (timeSinceClick >= DOUBLE_CLICK_THRESHOLD && !currentState.isStreaming && !currentState.isConnecting) {
            onStartOneShot()
          }
        }, DOUBLE_CLICK_THRESHOLD)
        break

      case 'ignore':
      default:
        // Do nothing
        break
    }
  }
}

export default {
  DOUBLE_CLICK_THRESHOLD,
  RECENTLY_STOPPED_GRACE_PERIOD,
  detectClickAction,
  createVoiceClickHandler
}
