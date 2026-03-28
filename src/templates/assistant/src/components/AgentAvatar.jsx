/**
 * AgentAvatar - Visual status indicator for the assistant
 *
 * Shows a colored circle that indicates the agent's current state.
 * The inside is a lighter/more transparent version of the border color.
 *
 * States:
 * - idle: Grey ring, gentle bounce animation (waiting for user input)
 * - working: Green ring, spinning animation (processing/generating)
 * - thinking: Blue ring, pulse animation
 * - error: Red ring, no animation (something went wrong)
 * - stale: Yellow/amber ring, no animation
 */

import { useState, useEffect } from 'react'

// Status configurations with RGB values for transparency calculations
const STATUS_CONFIG = {
  idle: {
    ringColor: '#64748b',
    fillColor: 'rgba(100, 116, 139, 0.25)', // Grey at 25% opacity
    animation: 'bounce',
    label: 'Ready'
  },
  working: {
    ringColor: '#22c55e',
    fillColor: 'rgba(34, 197, 94, 0.25)', // Green at 25% opacity
    animation: 'spin',
    label: 'Working...'
  },
  thinking: {
    ringColor: '#3b82f6',
    fillColor: 'rgba(59, 130, 246, 0.25)', // Blue at 25% opacity
    animation: 'pulse',
    label: 'Thinking...'
  },
  error: {
    ringColor: '#ef4444',
    fillColor: 'rgba(239, 68, 68, 0.25)', // Red at 25% opacity
    animation: 'none',
    label: 'Error'
  },
  stale: {
    ringColor: '#f59e0b',
    fillColor: 'rgba(245, 158, 11, 0.25)', // Amber at 25% opacity
    animation: 'none',
    label: 'Still working...'
  }
}

function AgentAvatar({
  status = 'idle',
  size = 32, // Smaller default
  showLabel = false,
  className = ''
}) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.idle

  // Calculate ring width based on size
  const ringWidth = Math.max(2, size / 8)

  return (
    <div
      className={`agent-avatar-container ${className}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '4px'
      }}
    >
      <div
        className={`agent-avatar agent-avatar--${config.animation}`}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          border: `${ringWidth}px solid ${config.ringColor}`,
          background: config.fillColor,
          boxShadow: status === 'working' || status === 'thinking'
            ? `0 0 ${size/3}px ${config.ringColor}40`
            : 'none',
          transition: 'border-color 0.3s ease, background 0.3s ease, box-shadow 0.3s ease'
        }}
      />

      {showLabel && (
        <span
          style={{
            fontSize: '10px',
            color: config.ringColor,
            fontWeight: 500,
            textTransform: 'uppercase',
            letterSpacing: '0.05em'
          }}
        >
          {config.label}
        </span>
      )}

      <style>{`
        @keyframes agent-bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }

        @keyframes agent-spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }

        @keyframes agent-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(0.95); }
        }

        .agent-avatar--bounce {
          animation: agent-bounce 2s ease-in-out infinite;
        }

        .agent-avatar--spin {
          animation: agent-spin 2s linear infinite;
        }

        .agent-avatar--pulse {
          animation: agent-pulse 1.5s ease-in-out infinite;
        }

        .agent-avatar--none {
          animation: none;
        }
      `}</style>
    </div>
  )
}

/**
 * Hook to manage agent status based on activity
 *
 * @param {boolean} isLoading - Whether a response is being awaited
 * @param {number} lastActivityTime - Timestamp of last received data
 * @param {number} staleThresholdMs - Time before showing "stale" warning (default 60s)
 * @param {number} errorThresholdMs - Time before showing error (default from config)
 */
export function useAgentStatus(isLoading, lastActivityTime, options = {}) {
  const {
    staleThresholdMs = 60000,  // 60 seconds
    errorThresholdMs = 180000  // 3 minutes (should come from config)
  } = options

  const [status, setStatus] = useState('idle')

  useEffect(() => {
    if (!isLoading) {
      setStatus('idle')
      return
    }

    // Initially set to working
    setStatus('working')

    // Set up interval to check for staleness
    const checkInterval = setInterval(() => {
      const elapsed = Date.now() - lastActivityTime

      if (elapsed > errorThresholdMs) {
        setStatus('error')
      } else if (elapsed > staleThresholdMs) {
        setStatus('stale')
      } else {
        setStatus('working')
      }
    }, 1000)

    return () => clearInterval(checkInterval)
  }, [isLoading, lastActivityTime, staleThresholdMs, errorThresholdMs])

  return status
}

export default AgentAvatar
