# VibeVoice Hotkey Dictation (Windows)

A lightweight overlay that lets you dictate text into any application on Windows by pressing a global hotkey.

## How it works

1. Press **Ctrl+Space** — a small toast notification appears in the bottom-right corner of your screen with a live waveform showing your audio input.
2. Speak naturally.
3. Recording stops automatically after a configurable period of silence **or** when you press **Ctrl+Space** again.
4. VibeVoice-ASR transcribes the audio.
5. The transcribed text is copied to your clipboard **and** typed into whatever text field currently has keyboard focus.

## Installation

### 1. Install VibeVoice with the `hotkey-dictation` extras

```bash
pip install -e ".[hotkey-dictation]"
```

This installs the four additional libraries the feature relies on:

| Library | Purpose |
|---|---|
| `sounddevice` | Captures microphone audio |
| `keyboard` | Registers the system-wide hotkey |
| `pyperclip` | Writes the result to the clipboard |
| `pyautogui` | Types the result into the active window |

### 2. (Windows only) Run as Administrator

The `keyboard` library requires elevated privileges to intercept global hotkeys. Right-click your terminal and choose **Run as Administrator**, or run:

```powershell
Start-Process python -ArgumentList "demo/vibevoice_hotkey_dictation.py --model_path microsoft/VibeVoice-ASR" -Verb RunAs
```

## Quick start

```bash
python demo/vibevoice_hotkey_dictation.py --model_path microsoft/VibeVoice-ASR
```

On the first run the model weights (~14 GB for the 7B variant) are downloaded from HuggingFace and cached locally. Subsequent runs are much faster.

## Options

| Flag | Default | Description |
|---|---|---|
| `--model_path` | `microsoft/VibeVoice-ASR` | HuggingFace model ID or local path |
| `--hotkey` | `ctrl+space` | Global hotkey (any combo supported by the `keyboard` library) |
| `--silence_threshold` | `0.01` | RMS amplitude below which audio is considered silence |
| `--silence_duration` | `1.5` | Seconds of silence required to auto-stop recording |
| `--device` | `cpu` | Torch device: `cpu`, `cuda`, or `auto` |
| `--dtype` | `bfloat16` | Model weight dtype: `float32`, `bfloat16`, or `float16` |
| `--attn_implementation` | `sdpa` | Attention backend: `sdpa`, `flash_attention_2`, or `eager` |
| `--no_auto_type` | *(off)* | Copy to clipboard only; do not type into the active window |
| `--max_new_tokens` | `512` | Maximum tokens to generate during transcription |

### Example — GPU inference, custom hotkey, clipboard only

```bash
python demo/vibevoice_hotkey_dictation.py \
    --model_path microsoft/VibeVoice-ASR \
    --device cuda \
    --dtype bfloat16 \
    --hotkey "ctrl+shift+space" \
    --no_auto_type
```

## Toast UI reference

| State | Indicator | Description |
|---|---|---|
| 🎙 Recording… | Live blue waveform bars | Microphone is active |
| ⚙ Transcribing… | Static grey bars | ASR model is running |
| ✅ Done! | Green bars | Text placed on clipboard / typed |

The toast dismisses automatically ~2.5 seconds after transcription completes.

## Troubleshooting

### "keyboard" requires admin rights
On Windows, global hotkey listening requires the process to run with elevated privileges.  Start your terminal as Administrator.

### No audio captured
Check that your default microphone is set correctly in Windows Sound settings.  You can also pass `--silence_threshold 0.005` to make the silence detector less aggressive.

### Model takes too long on CPU
Use `--device cuda` if a CUDA-capable GPU is available.  Alternatively, consider quantising the model or using a smaller model variant.

### Auto-type produces garbled characters
`pyautogui.typewrite` uses keyboard scan codes, which may not handle all Unicode characters.  In that case, use `--no_auto_type` and paste from the clipboard manually (Ctrl+V).
