import { useState, useEffect } from 'react'
import { Button, Card, CardHeader, CardContent, Spinner } from '@heroui/react'
import type { ServerState } from '../App'
import type { AppSettings, LogMessage } from '../types.d'

interface Props {
  server: ServerState
  onLog: (level: LogMessage['level'], text: string) => void
  setServer: (s: ServerState) => void
}

const DEVICES = [
  { key: 'auto', label: 'Auto-detect (recommended)' },
  { key: 'cuda', label: 'CUDA (NVIDIA GPU)' },
  { key: 'mps', label: 'MPS (Apple Silicon)' },
  { key: 'cpu', label: 'CPU (slow but universal)' },
]

export default function SettingsTab({ server, onLog, setServer }: Props) {
  const [settings, setSettings] = useState<AppSettings>({
    ttsModelPath: 'microsoft/VibeVoice-Realtime-0.5B',
    asrModelPath: 'microsoft/VibeVoice-ASR',
    device: 'auto',
    pythonPath: 'python',
    serverPort: 3001,
  })
  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.vibeAPI.getSettings().then((s) => setSettings(s))
  }, [])

  const set = (key: keyof AppSettings, value: string | number) =>
    setSettings((prev) => ({ ...prev, [key]: value }))

  const handleSave = async () => {
    setSaving(true)
    await window.vibeAPI.saveSettings(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
    setSaving(false)
  }

  const handleBrowseTts = async () => {
    const p = await window.vibeAPI.browseFolder()
    if (p) set('ttsModelPath', p)
  }

  const handleBrowseAsr = async () => {
    const p = await window.vibeAPI.browseFolder()
    if (p) set('asrModelPath', p)
  }

  const handleBrowsePython = async () => {
    const p = await window.vibeAPI.browsePython()
    if (p) set('pythonPath', p)
  }

  const handleRestart = async () => {
    setRestarting(true)
    await window.vibeAPI.saveSettings(settings)
    setServer({ running: false, port: null })
    onLog('info', 'Restarting server…')
    await window.vibeAPI.stopServer()
    const result = await window.vibeAPI.startServer(settings)
    if (!result.success) {
      onLog('error', `Restart failed: ${result.error}`)
    } else {
      onLog('info', `Server restarted on port ${result.port}`)
    }
    setRestarting(false)
  }

  return (
    <div className="flex flex-col gap-4 max-w-2xl mx-auto">
      {/* Model Paths */}
      <Card>
        <CardHeader>
          <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Model Paths</span>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <label className="block text-xs text-white/50 mb-1">TTS Model (VibeVoice-Realtime-0.5B)</label>
            <div className="flex gap-2">
              <input
                className="flex-1 bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/60"
                placeholder="microsoft/VibeVoice-Realtime-0.5B or /path/to/local"
                value={settings.ttsModelPath}
                onChange={e => set('ttsModelPath', e.target.value)}
              />
              <Button variant="outline" size="sm" onPress={handleBrowseTts}>Browse…</Button>
            </div>
          </div>
          <div>
            <label className="block text-xs text-white/50 mb-1">ASR Model (VibeVoice-ASR-7B)</label>
            <div className="flex gap-2">
              <input
                className="flex-1 bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/60"
                placeholder="microsoft/VibeVoice-ASR or /path/to/local"
                value={settings.asrModelPath}
                onChange={e => set('asrModelPath', e.target.value)}
              />
              <Button variant="outline" size="sm" onPress={handleBrowseAsr}>Browse…</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Compute */}
      <Card>
        <CardHeader>
          <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Compute</span>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-white/50 mb-1">Compute Device</label>
              <select
                className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/60"
                value={settings.device}
                onChange={e => set('device', e.target.value)}
              >
                {DEVICES.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">Server Port</label>
              <input
                type="number"
                min={1024}
                max={65535}
                className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/60"
                value={settings.serverPort}
                onChange={e => set('serverPort', parseInt(e.target.value) || 3001)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Python */}
      <Card>
        <CardHeader>
          <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Python Executable</span>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              className="flex-1 bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/60"
              placeholder="python  (or full path, e.g. C:\anaconda3\envs\tushanproject\python.exe)"
              value={settings.pythonPath}
              onChange={e => set('pythonPath', e.target.value)}
            />
            <Button variant="outline" size="sm" onPress={handleBrowsePython}>Browse…</Button>
          </div>
          <p className="text-xs text-white/30">
            Must be the Python from the env where vibevoice is installed
            (e.g. after <code className="bg-black/30 px-1 rounded">conda activate tushanproject</code>).
          </p>
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex gap-3">
        <Button variant={saved ? 'secondary' : 'primary'} onPress={handleSave} isDisabled={saving}>
          {saving ? <><Spinner size="sm" className="mr-2" />Saving…</> : saved ? '✓ Saved' : '💾 Save Settings'}
        </Button>
        <Button variant="outline" onPress={handleRestart} isDisabled={restarting}>
          {restarting ? <><Spinner size="sm" className="mr-2" />Restarting…</> : '🔄 Restart Server'}
        </Button>
      </div>
    </div>
  )
}
