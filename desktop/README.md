# VibeVoice Desktop App

A cross-platform Electron desktop application for VibeVoice's AI models — streaming text-to-speech and long-form speech transcription.

## Architecture

```
Electron (Node.js renderer ↔ main)
        │
        └─ spawns ──► FastAPI server (Python)
                           ├── /tts/stream   WebSocket — PCM-16 audio chunks
                           ├── /asr/transcribe  REST — upload audio, get transcript
                           ├── /tts/load     load TTS model on demand
                           ├── /asr/load     load ASR model on demand
                           ├── /voices       list voice presets
                           └── /status       model loading status
```

The Electron app launches the Python FastAPI server on startup (port 3001 by default) and communicates with it via `http://127.0.0.1:<port>`.

## Prerequisites

| Requirement | Notes |
|---|---|
| **Python 3.10+** with vibevoice installed | `pip install -e ..` from project root |
| **Node.js 18+** | For Electron |
| **CUDA GPU** (recommended) | 6 GB VRAM for TTS · 16 GB for ASR-7B |

## Quick Start (Windows)

```bat
cd desktop
launch.bat
```

The launcher will:
1. Activate the `tushanproject` conda environment
2. Install Python server deps (`fastapi`, `uvicorn`, `python-multipart`)
3. Run `npm install` for Electron on first run
4. Open the desktop app

## Quick Start (macOS / Linux)

```bash
cd desktop
bash launch.sh
```

## Manual Start

```bash
# 1. install Node deps (once)
cd desktop
npm install

# 2. start the app (with correct Python env active)
conda activate tushanproject
npx electron .
```

## Settings

Open the **⚙️ Settings** tab to configure:

| Setting | Default | Notes |
|---|---|---|
| TTS Model Path | `microsoft/VibeVoice-Realtime-0.5B` | HuggingFace ID or local folder path |
| ASR Model Path | `microsoft/VibeVoice-ASR` | HuggingFace ID or local folder path |
| Compute Device | `auto` | `cuda` / `mps` / `cpu` / `auto` |
| Python Path | `python` | Full path if not in PATH |
| Server Port | `3001` | Change if 3001 is occupied |

Settings are saved to `%APPDATA%\vibevoice-desktop\vibevoice-settings.json` (Windows) or `~/Library/Application Support/vibevoice-desktop/` (macOS).

## Model Loading

Models are loaded **on demand** to save memory:

- Click **⬇ Load TTS Model** in the TTS tab before synthesizing speech
- Click **⬇ Load ASR Model** in the Transcription tab before transcribing

The 7B ASR model takes 5–15 minutes to load on first run (downloading weights from HuggingFace). The 0.5B TTS model loads in ~1 minute.

## Features

### Text-to-Speech
- 25+ voice presets across 10 languages
- Streaming playback (audio starts before synthesis finishes)
- Adjustable CFG scale and diffusion steps
- Waveform visualization

### Speech-to-Text (ASR)
- Upload audio files (.wav, .mp3, .flac, .ogg, .m4a, .webm)
- Record directly from the microphone
- Returns full transcript + timestamped segments + speaker labels
- Copy transcription to clipboard

## Build a Distributable Package

```bash
npm run build        # Windows NSIS installer
npm run build:mac    # macOS DMG
npm run build:linux  # Linux AppImage
```

> **Note:** The Python environment and vibevoice package must be available on the target machine. The packaged Electron app does not bundle Python — users need to configure the Python path in Settings.

## File Structure

```
desktop/
├── main.js           Electron main process (server launcher, IPC)
├── preload.js        Context bridge (secure IPC for renderer)
├── index.html        UI structure
├── renderer.js       UI logic (TTS playback, ASR, settings)
├── styles.css        Dark theme stylesheet
├── package.json      Electron dependencies
├── launch.bat        Windows one-click launcher
├── launch.sh         macOS/Linux launcher
└── server/
    ├── server.py     FastAPI backend (TTS + ASR endpoints)
    └── requirements.txt  Python deps
```
