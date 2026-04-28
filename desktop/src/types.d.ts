// Type declarations for the Electron preload context bridge

export interface AppSettings {
  ttsModelPath: string
  asrModelPath: string
  device: string
  pythonPath: string
  serverPort: number
}

export interface ServerStatus {
  running: boolean
  port: number | null
}

export interface StartServerResult {
  success: boolean
  port?: number
  error?: string
}

export interface LogMessage {
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface ModelInfo {
  configured: boolean
  loaded: boolean
  loading: boolean
  error: string | null
}

export interface StatusResult {
  device: string
  tts: ModelInfo
  asr: ModelInfo
}

export interface TranscriptionSegment {
  start: number
  end: number
  text?: string
  content?: string
  speaker?: string
}

export interface TranscriptionResult {
  text: string
  segments: TranscriptionSegment[]
}

declare global {
  interface Window {
    vibeAPI: {
      getSettings: () => Promise<AppSettings>
      saveSettings: (settings: AppSettings) => Promise<boolean>
      getServerStatus: () => Promise<ServerStatus>
      startServer: (settings: AppSettings) => Promise<StartServerResult>
      stopServer: () => Promise<boolean>
      browseFolder: () => Promise<string | null>
      browsePython: () => Promise<string | null>
      onServerLog: (cb: (msg: LogMessage) => void) => void
      onServerStatus: (cb: (status: ServerStatus) => void) => void
    }
  }
}
