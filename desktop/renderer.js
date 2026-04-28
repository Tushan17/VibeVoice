'use strict'

// ================================================================ //
// State
// ================================================================ //
let serverPort = null
let serverReady = false
let ttsWs = null
let ttsPlaying = false
let selectedAudioFile = null      // File object (from drop or browse)
let mediaRecorder = null
let recordedChunks = []
let recordedBlob = null

// ================================================================ //
// Audio Player — PCM-16 streaming over Web Audio API
// ================================================================ //
class PCMAudioPlayer {
  constructor (sampleRate = 24_000) {
    this.sampleRate = sampleRate
    this.ctx = null
    this.nextStart = 0
    this.totalSamples = 0
  }

  _ensureCtx () {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ sampleRate: this.sampleRate })
      this.nextStart = 0
      this.totalSamples = 0
    }
    if (this.ctx.state === 'suspended') this.ctx.resume()
  }

  playChunk (arrayBuffer) {
    this._ensureCtx()
    const pcm16 = new Int16Array(arrayBuffer)
    const f32 = new Float32Array(pcm16.length)
    for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32_768
    const buf = this.ctx.createBuffer(1, f32.length, this.sampleRate)
    buf.copyToChannel(f32, 0)
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.ctx.destination)
    // Schedule gaplessly — add a tiny look-ahead on first chunk
    const start = Math.max(this.nextStart, this.ctx.currentTime + (this.totalSamples === 0 ? 0.05 : 0))
    src.start(start)
    this.nextStart = start + buf.duration
    this.totalSamples += f32.length
    return buf.duration
  }

  stop () {
    if (this.ctx) { this.ctx.close(); this.ctx = null }
    this.nextStart = 0
    this.totalSamples = 0
  }

  get elapsed () {
    if (!this.ctx) return 0
    return Math.max(0, this.totalSamples / this.sampleRate)
  }
}

const audioPlayer = new PCMAudioPlayer(24_000)

// ================================================================ //
// Waveform visualiser
// ================================================================ //
const canvas = document.getElementById('waveformCanvas')
const canvasCtx = canvas.getContext('2d')
const waveBuffer = []   // running list of float32 samples (downsampled)
const MAX_WAVE_SAMPLES = 4000

function appendWaveSamples (arrayBuffer) {
  const pcm16 = new Int16Array(arrayBuffer)
  const step = Math.max(1, Math.floor(pcm16.length / 80))
  for (let i = 0; i < pcm16.length; i += step) {
    waveBuffer.push(pcm16[i] / 32_768)
  }
  if (waveBuffer.length > MAX_WAVE_SAMPLES) {
    waveBuffer.splice(0, waveBuffer.length - MAX_WAVE_SAMPLES)
  }
  drawWaveform()
}

function drawWaveform () {
  const w = canvas.offsetWidth, h = canvas.offsetHeight
  canvas.width = w; canvas.height = h

  canvasCtx.fillStyle = '#080812'
  canvasCtx.fillRect(0, 0, w, h)

  if (!waveBuffer.length) return

  const midY = h / 2
  canvasCtx.beginPath()
  canvasCtx.strokeStyle = '#7c3aed'
  canvasCtx.lineWidth = 1.5

  const step = waveBuffer.length / w
  for (let x = 0; x < w; x++) {
    const idx = Math.min(Math.floor(x * step), waveBuffer.length - 1)
    const y = midY - waveBuffer[idx] * midY * 0.9
    x === 0 ? canvasCtx.moveTo(x, y) : canvasCtx.lineTo(x, y)
  }
  canvasCtx.stroke()
}

function clearWaveform () {
  waveBuffer.length = 0
  drawWaveform()
}

// ================================================================ //
// Tabs
// ================================================================ //
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.content').forEach(c => c.classList.remove('active'))
    btn.classList.add('active')
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active')
  })
})

// ================================================================ //
// Server status
// ================================================================ //
const badge = document.getElementById('serverBadge')
const badgeText = document.getElementById('serverBadgeText')

function setServerStatus (running, port) {
  serverReady = running
  serverPort = port

  badge.className = 'status-badge ' + (running ? 'running' : 'stopped')
  badgeText.textContent = running ? `Running · :${port}` : 'Stopped'

  if (running) {
    loadVoices()
    pollModelStatus()
  }
}

// Listen for events from main process
window.vibeAPI.onServerStatus(status => {
  setServerStatus(status.running, status.port)
})

window.vibeAPI.onServerLog(msg => {
  appendLog(msg.level, msg.text)
})

// ================================================================ //
// Logging
// ================================================================ //
const logPanel = document.getElementById('logPanel')

function appendLog (level, text) {
  const line = document.createElement('div')
  line.className = 'log-line ' + (level || 'info')
  const ts = new Date().toTimeString().slice(0, 8)
  line.textContent = `[${ts}] ${text}`
  logPanel.appendChild(line)
  logPanel.scrollTop = logPanel.scrollHeight
}

document.getElementById('clearLogsBtn').addEventListener('click', () => {
  logPanel.innerHTML = ''
})

// ================================================================ //
// Toast notifications
// ================================================================ //
function showToast (message, type = 'info', durationMs = 3000) {
  const t = document.createElement('div')
  t.className = `toast ${type}`
  t.textContent = message
  document.body.appendChild(t)
  setTimeout(() => t.remove(), durationMs)
}

// ================================================================ //
// Server fetch helpers
// ================================================================ //
function apiUrl (path) {
  return `http://127.0.0.1:${serverPort}${path}`
}

async function apiFetch (path, opts = {}) {
  const res = await fetch(apiUrl(path), opts)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `HTTP ${res.status}`)
  }
  return res.json()
}

// ================================================================ //
// Voice list
// ================================================================ //
const voiceSelect = document.getElementById('voiceSelect')

async function loadVoices () {
  if (!serverReady) return
  try {
    const data = await apiFetch('/voices')
    voiceSelect.innerHTML = ''
    if (!data.voices || !data.voices.length) {
      voiceSelect.innerHTML = '<option value="">No voices found</option>'
      return
    }
    data.voices.forEach(v => {
      const opt = document.createElement('option')
      opt.value = v
      opt.textContent = formatVoiceName(v)
      opt.selected = v === data.default
      voiceSelect.appendChild(opt)
    })
  } catch (e) {
    appendLog('error', 'Failed to load voices: ' + e.message)
  }
}

function formatVoiceName (key) {
  // "en-Carter_man" → "Carter (EN, Male)"
  const match = key.match(/^([a-z]+)-([^_]+)_(.+)$/)
  if (!match) return key
  const [, lang, name, gender] = match
  return `${name} (${lang.toUpperCase()}, ${gender.charAt(0).toUpperCase() + gender.slice(1)})`
}

// ================================================================ //
// Model status polling
// ================================================================ //
const ttsModelStatus = document.getElementById('ttsModelStatus')
const asrModelStatus = document.getElementById('asrModelStatus')
let statusPollTimer = null

async function pollModelStatus () {
  if (!serverReady) return
  try {
    const s = await apiFetch('/status')
    updateModelBadge(ttsModelStatus, s.tts)
    updateModelBadge(asrModelStatus, s.asr)
    updateTTSButtons(s.tts)
    updateASRButtons(s.asr)

    // Keep polling while loading
    if ((s.tts && s.tts.loading) || (s.asr && s.asr.loading)) {
      statusPollTimer = setTimeout(pollModelStatus, 2000)
    } else {
      statusPollTimer = null
    }
  } catch (_) {}
}

function updateModelBadge (el, info) {
  if (!info) { el.textContent = 'Not configured'; el.className = 'model-status idle'; return }
  if (!info.configured) { el.textContent = 'Not configured'; el.className = 'model-status idle'; return }
  if (info.error)   { el.textContent = 'Error';   el.className = 'model-status error'; return }
  if (info.loading) { el.textContent = 'Loading…'; el.className = 'model-status loading'; return }
  if (info.loaded)  { el.textContent = 'Loaded';   el.className = 'model-status loaded'; return }
  el.textContent = 'Idle'; el.className = 'model-status idle'
}

// ================================================================ //
// TTS — controls
// ================================================================ //
const ttsPlayBtn  = document.getElementById('ttsPlayBtn')
const ttsStopBtn  = document.getElementById('ttsStopBtn')
const ttsLoadBtn  = document.getElementById('ttsLoadBtn')
const ttsInput    = document.getElementById('ttsInput')
const ttsDuration = document.getElementById('ttsDuration')
const ttsStatusEl = document.getElementById('ttsStatusText')
const cfgRange    = document.getElementById('cfgScale')
const stepsRange  = document.getElementById('inferenceSteps')

cfgRange.addEventListener('input', () => { document.getElementById('cfgVal').textContent = cfgRange.value })
stepsRange.addEventListener('input', () => { document.getElementById('stepsVal').textContent = stepsRange.value })

function updateTTSButtons (info) {
  const ready = info && info.loaded
  ttsPlayBtn.disabled = !ready || !serverReady
  ttsStopBtn.disabled = !ttsPlaying
  ttsLoadBtn.textContent = (info && info.loading) ? '⏳ Loading…' : '⬇ Load TTS Model'
  ttsLoadBtn.disabled = !!(info && (info.loading || info.loaded))
}

ttsLoadBtn.addEventListener('click', async () => {
  if (!serverReady) { showToast('Server not running', 'error'); return }
  ttsLoadBtn.disabled = true
  ttsLoadBtn.innerHTML = '<span class="spinner"></span> Loading…'
  appendLog('info', 'Loading TTS model…')
  try {
    await apiFetch('/tts/load', { method: 'POST' })
    showToast('TTS model loaded successfully!', 'success')
    appendLog('info', 'TTS model ready')
    await pollModelStatus()
    loadVoices()
  } catch (e) {
    showToast('TTS load failed: ' + e.message, 'error')
    appendLog('error', 'TTS load error: ' + e.message)
    ttsLoadBtn.disabled = false
    ttsLoadBtn.textContent = '⬇ Load TTS Model'
  }
})

ttsPlayBtn.addEventListener('click', () => {
  const text = ttsInput.value.trim()
  if (!text) { showToast('Enter some text first', 'info'); return }
  startTTS(text)
})

ttsStopBtn.addEventListener('click', stopTTS)

function startTTS (text) {
  if (ttsWs) stopTTS()
  clearWaveform()
  waveBuffer.length = 0
  audioPlayer.stop()
  ttsPlaying = true
  ttsStopBtn.disabled = false
  ttsPlayBtn.disabled = true
  ttsStatusEl.textContent = 'Synthesizing…'

  const voice = voiceSelect.value
  const cfg = cfgRange.value
  const steps = stepsRange.value
  const params = new URLSearchParams({ text, cfg, steps })
  if (voice) params.set('voice', voice)

  const wsUrl = `ws://127.0.0.1:${serverPort}/tts/stream?${params}`
  ttsWs = new WebSocket(wsUrl)
  ttsWs.binaryType = 'arraybuffer'

  let totalDur = 0

  ttsWs.onmessage = (evt) => {
    if (evt.data instanceof ArrayBuffer) {
      const dur = audioPlayer.playChunk(evt.data)
      appendWaveSamples(evt.data)
      totalDur += dur
      ttsDuration.textContent = totalDur.toFixed(1) + ' s'
    } else {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === 'error') {
          appendLog('error', 'TTS error: ' + msg.message)
          showToast('TTS error: ' + msg.message, 'error')
        }
      } catch (_) {}
    }
  }

  ttsWs.onclose = () => {
    ttsPlaying = false
    ttsWs = null
    ttsStopBtn.disabled = true
    ttsPlayBtn.disabled = false
    ttsStatusEl.textContent = 'Done'
    appendLog('info', `Synthesis complete (${totalDur.toFixed(1)}s)`)
  }

  ttsWs.onerror = (err) => {
    appendLog('error', 'WebSocket error — check the Logs tab')
    showToast('Connection error', 'error')
  }
}

function stopTTS () {
  if (ttsWs) {
    ttsWs.close()
    ttsWs = null
  }
  audioPlayer.stop()
  ttsPlaying = false
  ttsStopBtn.disabled = true
  ttsPlayBtn.disabled = false
  ttsStatusEl.textContent = 'Stopped'
}

// ================================================================ //
// ASR — file drop / browse
// ================================================================ //
const dropzone = document.getElementById('dropzone')
const fileInput = document.getElementById('audioFileInput')
const dropzoneFile = document.getElementById('dropzoneFile')

dropzone.addEventListener('click', () => fileInput.click())

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setAudioFile(fileInput.files[0])
})

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault(); dropzone.classList.add('drag-over')
})
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'))
dropzone.addEventListener('drop', (e) => {
  e.preventDefault()
  dropzone.classList.remove('drag-over')
  const file = e.dataTransfer.files[0]
  if (file) setAudioFile(file)
})

function setAudioFile (file) {
  selectedAudioFile = file
  recordedBlob = null
  dropzoneFile.textContent = '✓ ' + file.name + ` (${(file.size / 1024).toFixed(0)} KB)`
  updateASRTranscribeBtn()
}

// ================================================================ //
// ASR — microphone recording
// ================================================================ //
const asrRecordBtn  = document.getElementById('asrRecordBtn')
const asrStopRecBtn = document.getElementById('asrStopRecBtn')
const recIndicator  = document.getElementById('recordingIndicator')

asrRecordBtn.addEventListener('click', startRecording)
asrStopRecBtn.addEventListener('click', stopRecording)

async function startRecording () {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    recordedChunks = []
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm'
    mediaRecorder = new MediaRecorder(stream, { mimeType: mime })
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data) }
    mediaRecorder.onstop = () => {
      recordedBlob = new Blob(recordedChunks, { type: mime })
      selectedAudioFile = null
      dropzoneFile.textContent = `✓ Recording (${(recordedBlob.size / 1024).toFixed(0)} KB, ${mime})`
      stream.getTracks().forEach(t => t.stop())
      updateASRTranscribeBtn()
    }
    mediaRecorder.start()
    asrRecordBtn.disabled = true
    asrStopRecBtn.disabled = false
    recIndicator.style.display = 'block'
  } catch (e) {
    showToast('Microphone access denied: ' + e.message, 'error')
  }
}

function stopRecording () {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
  asrRecordBtn.disabled = false
  asrStopRecBtn.disabled = true
  recIndicator.style.display = 'none'
}

// ================================================================ //
// ASR — transcription
// ================================================================ //
const asrTranscribeBtn = document.getElementById('asrTranscribeBtn')
const asrLoadBtn       = document.getElementById('asrLoadBtn')
const asrCopyBtn       = document.getElementById('asrCopyBtn')
const transcriptionBox = document.getElementById('transcriptionBox')
const segmentsBox      = document.getElementById('segmentsBox')
const segmentsList     = document.getElementById('segmentsList')

function updateASRButtons (info) {
  const ready = info && info.loaded
  updateASRTranscribeBtn()
  asrLoadBtn.textContent = (info && info.loading) ? '⏳ Loading…' : '⬇ Load ASR Model'
  asrLoadBtn.disabled = !!(info && (info.loading || info.loaded))
}

function updateASRTranscribeBtn () {
  const hasAudio = !!(selectedAudioFile || recordedBlob)
  // We need server ready too; loaded status is checked on click
  asrTranscribeBtn.disabled = !hasAudio || !serverReady
}

asrLoadBtn.addEventListener('click', async () => {
  if (!serverReady) { showToast('Server not running', 'error'); return }
  asrLoadBtn.disabled = true
  asrLoadBtn.innerHTML = '<span class="spinner"></span> Loading…'
  appendLog('info', 'Loading ASR model (this may take several minutes for 7B)…')
  showToast('ASR model loading — check Logs for progress', 'info', 5000)
  try {
    await apiFetch('/asr/load', { method: 'POST' })
    showToast('ASR model loaded successfully!', 'success')
    appendLog('info', 'ASR model ready')
    await pollModelStatus()
  } catch (e) {
    showToast('ASR load failed: ' + e.message, 'error')
    appendLog('error', 'ASR load error: ' + e.message)
    asrLoadBtn.disabled = false
    asrLoadBtn.textContent = '⬇ Load ASR Model'
  }
})

asrTranscribeBtn.addEventListener('click', async () => {
  const audioBlob = selectedAudioFile || recordedBlob
  if (!audioBlob) { showToast('No audio selected', 'info'); return }

  asrTranscribeBtn.disabled = true
  asrTranscribeBtn.innerHTML = '<span class="spinner"></span> Transcribing…'
  transcriptionBox.className = 'transcription-box placeholder'
  transcriptionBox.textContent = 'Transcribing…'
  segmentsBox.style.display = 'none'

  const form = new FormData()
  const filename = selectedAudioFile ? selectedAudioFile.name : 'recording.webm'
  form.append('file', audioBlob, filename)
  form.append('max_new_tokens', '512')

  try {
    const res = await fetch(apiUrl('/asr/transcribe'), { method: 'POST', body: form })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || `HTTP ${res.status}`)
    }
    const data = await res.json()
    displayTranscription(data)
    appendLog('info', `Transcription complete: "${data.text.slice(0, 80)}…"`)
    asrCopyBtn.disabled = false
  } catch (e) {
    transcriptionBox.className = 'transcription-box'
    transcriptionBox.textContent = '⚠ ' + e.message
    appendLog('error', 'Transcription error: ' + e.message)
    showToast('Transcription failed: ' + e.message, 'error')
  } finally {
    asrTranscribeBtn.disabled = false
    asrTranscribeBtn.textContent = '📝 Transcribe'
  }
})

function displayTranscription (data) {
  transcriptionBox.className = 'transcription-box'
  transcriptionBox.textContent = data.text || '(empty)'

  if (data.segments && data.segments.length > 0) {
    segmentsList.innerHTML = ''
    data.segments.forEach(seg => {
      const div = document.createElement('div')
      div.className = 'segment'
      const timeStr = `${formatTime(seg.start)} → ${formatTime(seg.end)}`
      div.innerHTML = `
        <span class="segment-time">${timeStr}</span>
        <span class="segment-text">${esc(seg.text || seg.content || '')}</span>
        ${seg.speaker ? `<span class="segment-speaker">${esc(seg.speaker)}</span>` : ''}
      `
      segmentsList.appendChild(div)
    })
    segmentsBox.style.display = 'block'
  } else {
    segmentsBox.style.display = 'none'
  }
}

function formatTime (sec) {
  if (typeof sec !== 'number') return '?'
  const m = Math.floor(sec / 60)
  const s = (sec - m * 60).toFixed(1).padStart(4, '0')
  return `${m}:${s}`
}

function esc (str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

asrCopyBtn.addEventListener('click', () => {
  const text = transcriptionBox.textContent
  if (text) {
    navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success'))
  }
})

// ================================================================ //
// Settings
// ================================================================ //
const ttsPathInput  = document.getElementById('ttsModelPath')
const asrPathInput  = document.getElementById('asrModelPath')
const deviceSel     = document.getElementById('deviceSelect')
const portInput     = document.getElementById('serverPort')
const pythonInput   = document.getElementById('pythonPath')

async function loadSettingsIntoUI () {
  const s = await window.vibeAPI.getSettings()
  ttsPathInput.value  = s.ttsModelPath  || ''
  asrPathInput.value  = s.asrModelPath  || ''
  deviceSel.value     = s.device        || 'auto'
  portInput.value     = s.serverPort    || 3001
  pythonInput.value   = s.pythonPath    || 'python'
}

document.getElementById('browseTtsBtn').addEventListener('click', async () => {
  const p = await window.vibeAPI.browseFolder()
  if (p) ttsPathInput.value = p
})

document.getElementById('browseAsrBtn').addEventListener('click', async () => {
  const p = await window.vibeAPI.browseFolder()
  if (p) asrPathInput.value = p
})

document.getElementById('browsePythonBtn').addEventListener('click', async () => {
  const p = await window.vibeAPI.browsePython()
  if (p) pythonInput.value = p
})

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const settings = {
    ttsModelPath: ttsPathInput.value.trim(),
    asrModelPath: asrPathInput.value.trim(),
    device:       deviceSel.value,
    serverPort:   parseInt(portInput.value, 10) || 3001,
    pythonPath:   pythonInput.value.trim() || 'python',
  }
  await window.vibeAPI.saveSettings(settings)
  showToast('Settings saved. Restart the server to apply changes.', 'info', 4000)
})

document.getElementById('restartServerBtn').addEventListener('click', async () => {
  const settings = {
    ttsModelPath: ttsPathInput.value.trim(),
    asrModelPath: asrPathInput.value.trim(),
    device:       deviceSel.value,
    serverPort:   parseInt(portInput.value, 10) || 3001,
    pythonPath:   pythonInput.value.trim() || 'python',
  }
  await window.vibeAPI.saveSettings(settings)
  badge.className = 'status-badge starting'
  badgeText.textContent = 'Restarting…'
  appendLog('info', 'Restarting server…')
  await window.vibeAPI.stopServer()
  const result = await window.vibeAPI.startServer(settings)
  if (!result.success) {
    showToast('Failed to start: ' + result.error, 'error')
    appendLog('error', 'Restart failed: ' + result.error)
  }
})

// ================================================================ //
// Init
// ================================================================ //
async function init () {
  await loadSettingsIntoUI()

  // Check if server is already running (race with auto-start)
  const status = await window.vibeAPI.getServerStatus()
  if (status.running) {
    setServerStatus(true, status.port)
  } else {
    badge.className = 'status-badge starting'
    badgeText.textContent = 'Starting…'
  }
}

init()
