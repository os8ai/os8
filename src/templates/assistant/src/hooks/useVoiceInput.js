import { useState, useCallback, useRef, useEffect } from 'react'

/**
 * Voice input hook - thin wrapper around OS8 voice API
 *
 * Handles MediaRecorder locally (required for browser audio capture),
 * delegates transcription to /api/voice/transcribe which handles:
 * - Local whisper.cpp (auto-installs on first use)
 * - OpenAI API fallback
 */
export function useVoiceInput({ onTranscript, onAutoSend, onError } = {}) {
  const [isListening, setIsListening] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)

  const mediaRecorderRef = useRef(null)
  const chunksRef = useRef([])
  const streamRef = useRef(null)
  const timerRef = useRef(null)

  const isSupported = typeof MediaRecorder !== 'undefined' && navigator?.mediaDevices?.getUserMedia

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop())
    timerRef.current = null
    streamRef.current = null
    mediaRecorderRef.current = null
    chunksRef.current = []
  }, [])

  const stopListening = useCallback(() => {
    if (mediaRecorderRef.current?.state !== 'inactive') {
      mediaRecorderRef.current?.stop()
    }
  }, [])

  const startListening = useCallback(async () => {
    if (!isSupported || isListening || isTranscribing) return false

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000 }
      })
      streamRef.current = stream

      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        if (timerRef.current) clearInterval(timerRef.current)
        setIsListening(false)
        setRecordingTime(0)

        if (streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.stop())
          streamRef.current = null
        }

        const blob = new Blob(chunksRef.current, { type: mimeType })
        chunksRef.current = []

        if (blob.size < 1000) return // Too short

        setIsTranscribing(true)
        onTranscript?.('Transcribing...')

        try {
          const formData = new FormData()
          formData.append('audio', blob, `recording.${mimeType.includes('webm') ? 'webm' : 'mp4'}`)

          const port = window.location.port || '8888'
          const res = await fetch(`http://localhost:${port}/api/voice/transcribe`, {
            method: 'POST',
            body: formData
          })

          const data = await res.json()
          if (data.error) throw new Error(data.error)

          if (data.text?.trim()) {
            onAutoSend?.(data.text.trim())
          }
        } catch (err) {
          onError?.(err.message)
        } finally {
          setIsTranscribing(false)
          onTranscript?.('')
        }
      }

      recorder.start(1000)
      setIsListening(true)
      setRecordingTime(0)
      timerRef.current = setInterval(() => setRecordingTime(t => t + 1), 1000)

      return true
    } catch (err) {
      cleanup()
      onError?.(err.name === 'NotAllowedError' ? 'Microphone permission denied' : err.message)
      return false
    }
  }, [isSupported, isListening, isTranscribing, onTranscript, onAutoSend, onError, cleanup])

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopListening()
      return false
    }
    if (!isTranscribing) {
      startListening()
      return true
    }
    return false
  }, [isListening, isTranscribing, startListening, stopListening])

  useEffect(() => cleanup, [cleanup])

  return { isListening, isTranscribing, recordingTime, isSupported, toggleListening }
}

export default useVoiceInput
