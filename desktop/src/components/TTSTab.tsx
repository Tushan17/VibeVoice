import { useState, useEffect, useRef, useCallback } from 'react'
import { Button, Card, CardHeader, CardContent, Chip, Spinner } from '@heroui/react'
import { PCMAudioPlayer, appendAndDrawWaveform, drawWaveform } from '../audio'
import type { ServerState } from '../App'
import type { LogMessage, ModelInfo } from '../types.d'

const SAMPLE_RATE = 24_000

function formatVoiceName(key: string): string {
  const m = key.match(/^([a-z]+)-([^_]+)_(.+)$/)
  if (!m) return key
  const [, lang, name, gender] = m
  return `${name} (${lang.toUpperCase()}, ${gender.charAt(0).toUpperCase() + gender.slice(1)})`
}

interface Props {
  server: ServerState
  onLog: (level: LogMessage['level'], text: string) => void
}

export default function TTSTab({ server, onLog }: Props) {
  const [text, setText] = useState('')
  const [voices, setVoices] = useState<string[]>([])
  const [selectedVoice, setSelectedVoice] = useState<string>('')
  const [cfgScale, setCfgScale] = useState(1.5)
  const [inferenceSteps, setInferenceSteps] = useState(5)
  const [modelInfo, setModelInfo] = useState<ModelInfo>({ configured: false, loaded: false, loading: false, error: null })
  const [playing, setPlaying] = useState(false)
  const [loadingModel, setLoadingModel] = useState(false)
  const [duration, setDuration] = useState(0)
  const [statusText, setStatusText] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const waveBufferRef = useRef<Float32Array[]>([])
  const audioPlayerRef = useRef<PCMAudioPlayer>(new PCMAudioPlayer(SAMPLE_RATE))
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
      setModelInfo(data.tts ?? { configured: false, loaded: false, loading: false, error: null })
      if (data.tts?.loading) {
        pollTimerRef.current = setTimeout(pollStatus, 2000)
      }
    } catch (_) {}
  }, [server.running, apiUrl])

  const loadVoices = useCallback(async () => {
    if (!server.running) return
    try {
      const res = await fetch(apiUrl('/voices'))
      const data = await res.json()
      const list: string[] = data.voices ?? []
      setVoices(list)
      if (list.length > 0) {
        setSelectedVoice((prev) => (list.includes(prev) ? prev : (data.default ?? list[0])))
      }
    } catch (_) {}
  }, [server.running, apiUrl])

  useEffect(() => {
    if (server.running) {
      loadVoices()
      pollStatus()
    }
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    }
  }, [server.running, loadVoices, pollStatus])

  const handleLoadModel = async () => {
    setLoadingModel(true)
    onLog('info', 'Loading TTS model…')
    try {
      const res = await fetch(apiUrl('/tts/load'), { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      onLog('info', 'TTS model loaded')
      await pollStatus()
      await loadVoices()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      onLog('error', `TTS load failed: ${msg}`)
    } finally {
      setLoadingModel(false)
    }
  }

  const handleSynthesize = useCallback(() => {
    if (!text.trim()) return
    if (wsRef.current) {
      wsRef.current.close()
    }
    waveBufferRef.current = []
    audioPlayerRef.current.stop()
    audioPlayerRef.current = new PCMAudioPlayer(SAMPLE_RATE)
    setDuration(0)
    setPlaying(true)
    setStatusText('Synthesizing…')

    const params = new URLSearchParams({
      text: text.trim(),
      cfg: String(cfgScale),
      steps: String(inferenceSteps),
    })
    if (selectedVoice) params.set('voice', selectedVoice)

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/tts/stream?${params}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    let totalDur = 0

    ws.onmessage = (evt) => {
      if (evt.data instanceof ArrayBuffer) {
        const dur = audioPlayerRef.current.playChunk(evt.data)
        totalDur += dur
        setDuration(totalDur)
        if (canvasRef.current) {
          appendAndDrawWaveform(evt.data, waveBufferRef.current, 4000, canvasRef.current)
        }
      } else {
        try {
          const msg = JSON.parse(evt.data as string)
          if (msg.type === 'error') onLog('error', `TTS: ${msg.message}`)
        } catch (_) {}
      }
    }

    ws.onclose = () => {
      setPlaying(false)
      wsRef.current = null
      setStatusText('Done')
      onLog('info', `Synthesis complete (${totalDur.toFixed(1)}s)`)
    }

    ws.onerror = () => {
      onLog('error', 'TTS WebSocket error')
      setPlaying(false)
    }
  }, [text, cfgScale, inferenceSteps, selectedVoice, server.port, onLog])

  const handleStop = useCallback(() => {
    wsRef.current?.close()
    audioPlayerRef.current.stop()
    setPlaying(false)
    setStatusText('Stopped')
  }, [])

  // Draw empty waveform on mount
  useEffect(() => {
    if (canvasRef.current) drawWaveform([], canvasRef.current)
  }, [])

  const modelBadge = () => {
    if (!modelInfo.configured) return <Chip size="sm" variant="secondary" color="default">Not configured</Chip>
    if (modelInfo.error) return <Chip size="sm" variant="secondary" color="danger">Error</Chip>
    if (modelInfo.loading) return <Chip size="sm" variant="soft" color="warning">Loading…</Chip>
    if (modelInfo.loaded) return <Chip size="sm" variant="soft" color="success">Loaded</Chip>
    return <Chip size="sm" variant="secondary" color="default">Idle</Chip>
  }

  return (
    <div className="flex flex-col gap-4 max-w-3xl mx-auto">
      {/* Input */}
      <Card>
        <CardHeader className="flex justify-between items-center">
          <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Text to Synthesize</span>
          {modelBadge()}
        </CardHeader>
        <CardContent>
          <textarea
            className="w-full bg-black/20 border border-white/10 rounded-lg p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-violet-500/60 min-h-[120px]"
            placeholder="Enter text to synthesize…"
            value={text}
            onChange={e => setText(e.target.value)}
          />
        </CardContent>
      </Card>

      {/* Voice & Parameters */}
      <Card>
        <CardHeader>
          <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Voice &amp; Parameters</span>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <label className="block text-xs text-white/50 mb-1">Voice Preset</label>
            <select
              className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/60"
              value={selectedVoice}
              onChange={e => setSelectedVoice(e.target.value)}
              disabled={voices.length === 0}
            >
              {voices.length === 0 && <option value="">No voices loaded</option>}
              {voices.map(v => <option key={v} value={v}>{formatVoiceName(v)}</option>)}
            </select>
          </div>
          <div>
            <label className="flex justify-between text-xs text-white/50 mb-1">
              <span>CFG Scale</span><span className="text-white/80">{cfgScale.toFixed(1)}</span>
            </label>
            <input type="range" min={1} max={4} step={0.1} value={cfgScale}
              onChange={e => setCfgScale(parseFloat(e.target.value))} className="w-full accent-violet-500" />
          </div>
          <div>
            <label className="flex justify-between text-xs text-white/50 mb-1">
              <span>Inference Steps</span><span className="text-white/80">{inferenceSteps}</span>
            </label>
            <input type="range" min={1} max={20} step={1} value={inferenceSteps}
              onChange={e => setInferenceSteps(parseInt(e.target.value))} className="w-full accent-violet-500" />
          </div>
        </CardContent>
      </Card>

      {/* Playback */}
      <Card>
        <CardHeader>
          <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Playback</span>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2 flex-wrap">
            <Button variant="primary" isDisabled={!modelInfo.loaded || !server.running || playing || !text.trim()} onPress={handleSynthesize}>
              {playing ? <><Spinner size="sm" className="mr-2" />Synthesizing…</> : '▶ Synthesize & Play'}
            </Button>
            <Button variant="danger" isDisabled={!playing} onPress={handleStop}>⏹ Stop</Button>
            <Button variant="outline" isDisabled={loadingModel || modelInfo.loaded || !server.running} onPress={handleLoadModel}>
              {loadingModel ? <><Spinner size="sm" className="mr-2" />Loading…</> : '⬇ Load TTS Model'}
            </Button>
          </div>
          <div className="waveform-container rounded-lg border border-white/10">
            <canvas ref={canvasRef} style={{ width: '100%', height: '80px', display: 'block' }} />
          </div>
          <div className="flex gap-4 text-xs text-white/40">
            <span>Duration: <strong className="text-white/80">{duration.toFixed(1)} s</strong></span>
            {statusText && <span>{statusText}</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
