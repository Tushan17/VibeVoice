'use strict'

const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')
const net = require('net')

// ------------------------------------------------------------------ //
// Paths
// ------------------------------------------------------------------ //
const PROJECT_ROOT = path.join(__dirname, '..')          // desktop/../ = VibeVoice/
const SERVER_SCRIPT = path.join(__dirname, 'server', 'server.py')
const SETTINGS_FILE = path.join(app.getPath('userData'), 'vibevoice-settings.json')

const DEFAULT_SETTINGS = {
  ttsModelPath: 'microsoft/VibeVoice-Realtime-0.5B',
  asrModelPath: 'microsoft/VibeVoice-ASR',
  device: 'auto',
  pythonPath: 'python',
  serverPort: 3001,
}

let mainWindow = null
let pythonProcess = null
let serverPort = DEFAULT_SETTINGS.serverPort
let serverRunning = false

// ------------------------------------------------------------------ //
// Settings persistence
// ------------------------------------------------------------------ //

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8')
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
    }
  } catch (e) {
    console.error('[settings] Load error:', e.message)
  }
  return { ...DEFAULT_SETTINGS }
}

function saveSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8')
  } catch (e) {
    console.error('[settings] Save error:', e.message)
  }
}

// ------------------------------------------------------------------ //
// Port utilities
// ------------------------------------------------------------------ //

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => { server.close(); resolve(true) })
    server.listen(port, '127.0.0.1')
  })
}

async function findFreePort(startPort) {
  for (let p = startPort; p < startPort + 50; p++) {
    if (await isPortFree(p)) return p
  }
  throw new Error(`No free port found starting from ${startPort}`)
}

function waitForServer(port, maxWaitMs = 90_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxWaitMs
    function attempt() {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        if (res.statusCode === 200) {
          resolve()
        } else {
          res.resume()
          retry()
        }
      })
      req.on('error', retry)
      req.setTimeout(2000, () => { req.destroy(); retry() })
    }
    function retry() {
      if (Date.now() > deadline) {
        reject(new Error('Server did not start within 90 seconds'))
      } else {
        setTimeout(attempt, 1500)
      }
    }
    attempt()
  })
}

// ------------------------------------------------------------------ //
// Python server lifecycle
// ------------------------------------------------------------------ //

function sendLog(level, text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('server-log', { level, text })
  }
}

function sendStatus(running, port) {
  serverRunning = running
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('server-status', { running, port: running ? port : null })
  }
}

async function startPythonServer(settings) {
  if (pythonProcess) {
    return serverPort
  }

  const port = await findFreePort(settings.serverPort || DEFAULT_SETTINGS.serverPort)
  serverPort = port

  const env = {
    ...process.env,
    TTS_MODEL_PATH: settings.ttsModelPath || '',
    ASR_MODEL_PATH: settings.asrModelPath || '',
    MODEL_DEVICE: settings.device || 'auto',
    SERVER_PORT: String(port),
    PYTHONUNBUFFERED: '1',
  }

  const pythonExe = settings.pythonPath || 'python'

  sendLog('info', `Starting VibeVoice server on port ${port}...`)
  sendLog('info', `Python: ${pythonExe}`)

  pythonProcess = spawn(pythonExe, [SERVER_SCRIPT, '--port', String(port)], {
    env,
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  pythonProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim()
    if (msg) sendLog('info', msg)
  })

  pythonProcess.stderr.on('data', (data) => {
    // Python typically logs to stderr — treat as info unless it looks like an error
    const msg = data.toString().trim()
    if (!msg) return
    const isError = /error|exception|traceback/i.test(msg)
    sendLog(isError ? 'error' : 'info', msg)
  })

  pythonProcess.on('exit', (code) => {
    console.log(`[server] Python process exited (code ${code})`)
    pythonProcess = null
    sendStatus(false, null)
    if (code !== 0 && code !== null) {
      sendLog('error', `Server process exited unexpectedly (code ${code})`)
    }
  })

  pythonProcess.on('error', (err) => {
    sendLog('error', `Failed to start Python: ${err.message}`)
    sendLog('error', 'Check that the Python path in Settings is correct and the vibevoice package is installed.')
    pythonProcess = null
    sendStatus(false, null)
  })

  sendLog('info', 'Waiting for server to become ready...')
  try {
    await waitForServer(port)
    sendStatus(true, port)
    sendLog('info', `Server ready at http://127.0.0.1:${port}`)
    return port
  } catch (err) {
    stopPythonServer()
    throw err
  }
}

function stopPythonServer() {
  if (pythonProcess) {
    pythonProcess.kill()
    // On Windows, also force-kill in case SIGTERM is ignored
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(pythonProcess.pid), '/F', '/T'], { stdio: 'ignore' })
      } catch (_) {}
    }
    pythonProcess = null
    sendStatus(false, null)
  }
}

// ------------------------------------------------------------------ //
// Browser window
// ------------------------------------------------------------------ //

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: 'VibeVoice Desktop',
    backgroundColor: '#0f0f1a',
    show: false,
    autoHideMenuBar: true,
  })

  // Load the React app (Vite dev server or built dist)
  const devUrl = process.env.VITE_DEV_SERVER_URL
  const distIndex = path.join(__dirname, 'dist', 'index.html')
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(distIndex)
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ------------------------------------------------------------------ //
// IPC handlers
// ------------------------------------------------------------------ //

ipcMain.handle('get-settings', () => loadSettings())

ipcMain.handle('save-settings', (_event, settings) => {
  saveSettings(settings)
  return true
})

ipcMain.handle('get-server-status', () => ({
  running: serverRunning,
  port: serverRunning ? serverPort : null,
}))

ipcMain.handle('start-server', async (_event, settings) => {
  try {
    const port = await startPythonServer(settings)
    return { success: true, port }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('stop-server', () => {
  stopPythonServer()
  return true
})

ipcMain.handle('get-project-root', () => PROJECT_ROOT)

ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select model directory',
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

ipcMain.handle('browse-python', async () => {
  const filters =
    process.platform === 'win32'
      ? [{ name: 'Executable', extensions: ['exe'] }]
      : [{ name: 'All Files', extensions: ['*'] }]
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Select Python executable',
    filters,
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

// ------------------------------------------------------------------ //
// App lifecycle
// ------------------------------------------------------------------ //

app.whenReady().then(() => {
  createWindow()

  // Auto-start with saved settings
  const settings = loadSettings()
  startPythonServer(settings).catch((err) => {
    console.error('[startup] Server auto-start failed:', err.message)
    sendLog('error', `Auto-start failed: ${err.message}`)
  })
})

app.on('window-all-closed', () => {
  stopPythonServer()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('before-quit', () => {
  stopPythonServer()
})
