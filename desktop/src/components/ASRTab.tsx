import { useState, useEffect, useRef, useCallback } from 'react'
import { Button, Card, CardHeader, CardContent, Chip, Separator, Spinner } from '@heroui/react'
import type { ServerState } from '../App'
import type { LogMessage, ModelInfo, TranscriptionSegment } from '../types.d'

interface Props {
  server: ServerState
  onLog: (level: LogMessage['level'], text: string) => void
}

export default function ASRTab({ server, onLog }: Props) {
  const [modelInfo, setModelInfo] = useState<ModelInfo>({ configured: false, loaded: false, loading: false, error: null })
  const [loadingModel, setLoadingModel] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [transcription, setTranscription] = useState('')
  const [segments, setSegments] = useState<TranscriptionSegment[]>([])
  const [dragOver, setDragOver] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const apiUrl = useCallback(
    (path: string) => `http://127.0.0.1:${server.port}${path}`,
    [server.port],
  )

  const pollStatus = useCallback(async () => {
    if (!server.running) return
    try {
      const res = await fetch(apiUrl('/status'))
      const data = await res.json()
      setModelInfo(data.asr ?? { configured: false, loaded: false, loading: false, error: null })
      if (data.asr?.loading) {
        pollTimerRef.current = setTimeout(pollStatus, 2000)
      }
    } catch (_) {}
  }, [server.running, apiUrl])

  useEffect(() => {
    if (server.running) pollStatus()
    return () => { if (pollTimerRef.current) clearTimeout(pollTimerRef.current) }
  }, [server.running, pollStatus])

  const handleLoadModel = async () => {
    setLoadingModel(true)
    onLog('info', 'Loading ASR model (this may take several minutes for the 7B model)…')
    try {
      const res = await fetch(apiUrl('/asr/load'), { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      onLog('info', 'ASR model loaded')
      await pollStatus()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      onLog('error', `ASR load failed: ${msg}`)
    } finally {
      setLoadingModel(false)
    }
  }

  const handleFileSelected = (file: File) => {
    setSelectedFile(file)
    setRecordedBlob(null)
  }

  const handleDropzoneDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFileSelected(file)
  }

  const handleTranscribe = async () => {
    const audioBlob: Blob | null = selectedFile ?? recordedBlob
    if (!audioBlob) return
    setTranscribing(true)
    setTranscription('')
    setSegments([])
    const form = new FormData()
    const name = selectedFile ? selectedFile.name : 'recording.webm'
    form.append('file', audioBlob, name)
    form.append('max_new_tokens', '512')
    try {
      const res = await fetch(apiUrl('/asr/transcribe'), { method: 'POST', body: form })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setTranscription(data.text ?? '')
      setSegments(data.segments ?? [])
      onLog('info', `Transcription: "${(data.text ?? '').slice(0, 80)}…"`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      onLog('error', `Transcription error: ${msg}`)
      setTranscription(`Error: ${msg}`)
    } finally {
      setTranscribing(false)
    }
  }

  const handleStartRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      recordedChunksRef.current = []
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const mr = new MediaRecorder(stream, { mimeType: mime })
      mr.ondataavailable = (e) => { if (e.data.size > 0) recordedChunksRef.current.push(e.data) }
      mr.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: mime })
        setRecordedBlob(blob)
        setSelectedFile(null)
        stream.getTracks().forEach((t) => t.stop())
      }
      mr.start()
      mediaRecorderRef.current = mr
      setRecording(true)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      onLog('error', `Microphone error: ${msg}`)
    }
  }

  const handleStopRecording = () => {
    mediaRecorderRef.current?.stop()
    setRecording(false)
  }

  const handleCopy = () => {
    if (transcription) navigator.clipboard.writeText(transcription)
  }

  const hasAudio = !!(selectedFile ?? recordedBlob)
  const audioLabel = selectedFile
    ? `${selectedFile.name} (${(selectedFile.size / 1024).toFixed(0)} KB)`
    : recordedBlob
    ? `Recording (${(recordedBlob.size / 1024).toFixed(0)} KB)`
    : null

  function formatTime(sec: number | undefined): string {
    if (typeof sec !== 'number') return '?'
    const m = Math.floor(sec / 60)
    const s = (sec - m * 60).toFixed(1).padStart(4, '0')
    return `${m}:${s}`
  }

  const modelBadge = () => {
    if (!modelInfo.configured) return <Chip size="sm" variant="secondary" color="default">Not configured</Chip>
    if (modelInfo.error) return <Chip size="sm" variant="secondary" color="danger">Error</Chip>
    if (modelInfo.loading) return <Chip size="sm" variant="soft" color="warning">Loading…</Chip>
    if (modelInfo.loaded) return <Chip size="sm" variant="soft" color="success">Loaded</Chip>
    return <Chip size="sm" variant="secondary" color="default">Idle</Chip>
  }

  return (
    <div className="flex flex-col gap-4 max-w-3xl mx-auto">
      {/* Audio Source */}
      <Card>
        <CardHeader className="flex justify-between items-center">
          <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Audio Source</span>
          {modelBadge()}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div
            role="button"
            tabIndex={0}
            className={`rounded-lg border-2 border-dashed transition-colors cursor-pointer p-8 text-center
              ${dragOver ? 'border-violet-500 bg-violet-500/10' : 'border-white/10 hover:border-white/30 hover:bg-white/5'}`}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDropzoneDrop}
          >
            <div className="text-4xl mb-2">📂</div>
            <p className="text-white/50 text-sm">Drop an audio file here, or click to browse</p>
            <p className="text-white/30 text-xs mt-1">.wav · .mp3 · .flac · .ogg · .m4a · .webm</p>
            {audioLabel && <p className="text-cyan-400 text-sm font-medium mt-2">✓ {audioLabel}</p>}
          </div>
          <input ref={fileInputRef} type="file" accept=".wav,.mp3,.flac,.ogg,.m4a,.webm" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileSelected(f) }} />

          <Separator />

          <div className="flex items-center gap-3 justify-center flex-wrap">
            <Button variant="secondary" isDisabled={recording} onPress={handleStartRecording}>
              🎙️ Record from Microphone
            </Button>
            <Button variant="danger" isDisabled={!recording} onPress={handleStopRecording}>
              ⏹ Stop Recording
            </Button>
            {recording && (
              <span className="flex items-center gap-1.5 text-xs text-red-400">
                <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />Recording…
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Transcription */}
      <Card>
        <CardHeader>
          <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Transcription</span>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2 flex-wrap">
            <Button variant="primary" isDisabled={!hasAudio || !modelInfo.loaded || !server.running || transcribing} onPress={handleTranscribe}>
              {transcribing ? <><Spinner size="sm" className="mr-2" />Transcribing…</> : '📝 Transcribe'}
            </Button>
            <Button variant="outline" isDisabled={loadingModel || modelInfo.loaded || !server.running} onPress={handleLoadModel}>
              {loadingModel ? <><Spinner size="sm" className="mr-2" />Loading…</> : '⬇ Load ASR Model'}
            </Button>
            <Button variant="ghost" isDisabled={!transcription} onPress={handleCopy}>
              📋 Copy Text
            </Button>
          </div>

          <div className={`rounded-lg border border-white/10 bg-black/20 p-4 min-h-[80px] text-sm leading-relaxed whitespace-pre-wrap
            ${transcription ? '' : 'text-white/30 italic'}`}>
            {transcription || 'Transcription will appear here…'}
          </div>

          {segments.length > 0 && (
            <div className="flex flex-col gap-1 mt-1">
              <p className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-1">Segments with Timestamps</p>
              {segments.map((seg, i) => (
                <div key={i} className="flex gap-3 py-2 border-b border-white/5 last:border-0 text-sm">
                  <span className="text-xs text-cyan-400 font-mono whitespace-nowrap min-w-[120px]">
                    {formatTime(seg.start)} → {formatTime(seg.end)}
                  </span>
                  <span className="flex-1">{seg.text ?? seg.content}</span>
                  {seg.speaker && <span className="text-xs text-white/30 whitespace-nowrap">{seg.speaker}</span>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
