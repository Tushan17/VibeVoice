/** PCM-16 streaming audio player using Web Audio API */
export class PCMAudioPlayer {
  private sampleRate: number
  private ctx: AudioContext | null = null
  private nextStart = 0
  private totalSamples = 0

  constructor(sampleRate = 24_000) {
    this.sampleRate = sampleRate
  }

  private ensureCtx() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ sampleRate: this.sampleRate })
      this.nextStart = 0
      this.totalSamples = 0
    }
    if (this.ctx.state === 'suspended') this.ctx.resume()
  }

  playChunk(arrayBuffer: ArrayBuffer): number {
    this.ensureCtx()
    const ctx = this.ctx!
    const pcm16 = new Int16Array(arrayBuffer)
    const f32 = new Float32Array(pcm16.length)
    for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32_768
    const buf = ctx.createBuffer(1, f32.length, this.sampleRate)
    buf.copyToChannel(f32, 0)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    const start = Math.max(
      this.nextStart,
      ctx.currentTime + (this.totalSamples === 0 ? 0.05 : 0),
    )
    src.start(start)
    this.nextStart = start + buf.duration
    this.totalSamples += f32.length
    return buf.duration
  }

  stop() {
    if (this.ctx) {
      this.ctx.close()
      this.ctx = null
    }
    this.nextStart = 0
    this.totalSamples = 0
  }

  get elapsedSeconds(): number {
    return this.totalSamples / this.sampleRate
  }
}

/** Append PCM-16 samples to a waveform ring buffer and redraw on a canvas */
export function appendAndDrawWaveform(
  pcmBuffer: ArrayBuffer,
  waveBuffer: Float32Array[],
  maxSamples: number,
  canvas: HTMLCanvasElement,
) {
  const pcm16 = new Int16Array(pcmBuffer)
  const step = Math.max(1, Math.floor(pcm16.length / 80))
  for (let i = 0; i < pcm16.length; i += step) {
    waveBuffer.push(new Float32Array([pcm16[i] / 32_768]))
  }
  // Trim to max
  while (waveBuffer.length > maxSamples) waveBuffer.shift()
  drawWaveform(waveBuffer, canvas)
}

export function drawWaveform(waveBuffer: Float32Array[], canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.offsetWidth || canvas.width
  const h = canvas.offsetHeight || canvas.height
  canvas.width = w
  canvas.height = h

  ctx.fillStyle = '#080812'
  ctx.fillRect(0, 0, w, h)
  if (!waveBuffer.length) return

  const midY = h / 2
  ctx.beginPath()
  ctx.strokeStyle = '#7c3aed'
  ctx.lineWidth = 1.5
  const step = waveBuffer.length / w
  for (let x = 0; x < w; x++) {
    const idx = Math.min(Math.floor(x * step), waveBuffer.length - 1)
    const val = waveBuffer[idx][0]
    const y = midY - val * midY * 0.9
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.stroke()
}
