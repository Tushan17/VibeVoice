import { useEffect, useState, useCallback } from 'react'
import { Tabs, Tab, TabList, TabListContainer, TabPanel, Chip } from '@heroui/react'
import TTSTab from './components/TTSTab'
import ASRTab from './components/ASRTab'
import SettingsTab from './components/SettingsTab'
import LogsTab from './components/LogsTab'
import type { LogMessage } from './types.d'

export interface ServerState {
  running: boolean
  port: number | null
}

export default function App() {
  const [server, setServer] = useState<ServerState>({ running: false, port: null })
  const [logs, setLogs] = useState<LogMessage[]>([])
  const [activeTab, setActiveTab] = useState('tts')

  // Stable addLog so child components can call it without re-rendering App
  const addLog = useCallback((level: LogMessage['level'], text: string) => {
    setLogs(prev => [...prev.slice(-499), { level, text }])
  }, [])

  useEffect(() => {
    window.vibeAPI.onServerLog((msg) => {
      addLog(msg.level, msg.text)
    })
    window.vibeAPI.onServerStatus((status) => {
      setServer({ running: status.running, port: status.port })
    })
    // Check initial state
    window.vibeAPI.getServerStatus().then((s) => {
      setServer({ running: s.running, port: s.port })
    })
  }, [addLog])

  const badgeText = server.running
    ? `Running · :${server.port}`
    : 'Server stopped'

  return (
    <div className="flex flex-col h-screen bg-[#0f0f1a] text-foreground overflow-hidden">
      {/* ── Header ── */}
      <header className="drag-region flex items-center gap-3 px-5 py-3 bg-content1 border-b border-divider shrink-0">
        <div>
          <div
            className="text-xl font-bold bg-gradient-to-r from-violet-500 to-cyan-400 bg-clip-text text-transparent tracking-tight"
          >
            VibeVoice Desktop
          </div>
          <div className="text-xs text-foreground-400 mt-0.5">
            AI Text-to-Speech &amp; Speech-to-Text
          </div>
        </div>

        <div className="flex-1" />

        <div className="no-drag">
            <Chip color={server.running ? 'success' : 'default'} variant="soft" size="sm">
            <span className={`mr-1.5 inline-block w-2 h-2 rounded-full bg-current ${server.running ? 'animate-pulse' : ''}`} />
            {badgeText}
          </Chip>
        </div>
      </header>

      {/* ── Tabs ── */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <Tabs
          aria-label="Main navigation"
          selectedKey={activeTab}
          onSelectionChange={(k) => setActiveTab(k as string)}
          className="flex flex-col flex-1 overflow-hidden"
        >
          <TabListContainer className="shrink-0 bg-content1 border-b border-divider px-4">
            <TabList className="gap-0">
              <Tab id="tts" className="px-4 py-3 text-sm font-medium">🔊 Text-to-Speech</Tab>
              <Tab id="asr" className="px-4 py-3 text-sm font-medium">🎙️ Transcription</Tab>
              <Tab id="settings" className="px-4 py-3 text-sm font-medium">⚙️ Settings</Tab>
              <Tab id="logs" className="px-4 py-3 text-sm font-medium">📋 Logs</Tab>
            </TabList>
          </TabListContainer>

          <TabPanel id="tts" className="flex-1 overflow-y-auto p-6">
            <TTSTab server={server} onLog={addLog} />
          </TabPanel>
          <TabPanel id="asr" className="flex-1 overflow-y-auto p-6">
            <ASRTab server={server} onLog={addLog} />
          </TabPanel>
          <TabPanel id="settings" className="flex-1 overflow-y-auto p-6">
            <SettingsTab server={server} onLog={addLog} setServer={setServer} />
          </TabPanel>
          <TabPanel id="logs" className="flex-1 overflow-y-auto p-6">
            <LogsTab logs={logs} onClear={() => setLogs([])} />
          </TabPanel>
        </Tabs>
      </div>
    </div>
  )
}
