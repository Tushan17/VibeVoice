# How to Run VibeVoice

This guide covers how to run each of the demos and features included in VibeVoice.

---

## Table of Contents

1. [Requirements](#requirements)
2. [VibeVoice-ASR — Inference from file](#vibevoice-asr--inference-from-file)
3. [VibeVoice-ASR — Gradio demo](#vibevoice-asr--gradio-demo)
4. [VibeVoice Hotkey Dictation (Windows)](#vibevoice-hotkey-dictation-windows)
5. [VibeVoice-Realtime — Streaming TTS](#vibevoice-realtime--streaming-tts)

---

## Requirements

- Python 3.10 or later
- [Git](https://git-scm.com/)
- A HuggingFace account (free) to download model weights

Clone the repository first:

```bash
git clone https://github.com/microsoft/VibeVoice.git
cd VibeVoice
```

---

## VibeVoice-ASR — Inference from file

Transcribe a local audio file using VibeVoice-ASR.

### Install

```bash
pip install -e "."
```

### Run

```bash
python demo/vibevoice_asr_inference_from_file.py \
    --model_path microsoft/VibeVoice-ASR \
    --audio_path /path/to/your/audio.wav
```

The first run downloads model weights (~14 GB). Subsequent runs use the local cache.

See [vibevoice-asr.md](vibevoice-asr.md) for the full flag reference.

---

## VibeVoice-ASR — Gradio demo

Launch a browser-based UI that lets you upload audio or record from a microphone.

### Install

```bash
pip install -e ".[gradio]"
```

### Run

```bash
python demo/vibevoice_asr_gradio_demo.py --model_path microsoft/VibeVoice-ASR
```

Open the URL printed in the terminal (usually `http://127.0.0.1:7860`) in your browser.

See [setup_gradio_demo.md](setup_gradio_demo.md) for additional configuration options.

---

## VibeVoice Hotkey Dictation (Windows)

Dictate text into **any application** with a global hotkey. An overlay in the bottom-right corner shows recording state and a live waveform.

### Install

```bash
pip install -e ".[hotkey-dictation]"
```

This adds four extra libraries:

| Library | Purpose |
|---|---|
| `sounddevice` | Captures microphone audio |
| `keyboard` | Registers the system-wide hotkey |
| `pyperclip` | Copies the result to the clipboard |
| `pyautogui` | Types the result into the active window |

### Open an Administrator terminal (required on Windows)

The `keyboard` library must intercept system-wide key events, which requires elevated privileges.

**Option A — GUI:** right-click *Command Prompt* or *PowerShell* and choose **Run as administrator**.

**Option B — PowerShell:**

```powershell
Start-Process powershell -Verb RunAs
```

Then navigate back to the repo directory inside the elevated window:

```powershell
cd C:\path\to\VibeVoice
```

### Start the dictation listener

```bash
python demo/vibevoice_hotkey_dictation.py --model_path microsoft/VibeVoice-ASR
```

Once the model has loaded you will see:

```
[VibeVoice] Model ready on cpu
[VibeVoice] Listening for hotkey: ctrl+space
[VibeVoice] Press Ctrl+C to quit.
```

### Dictate

1. Click into any text field in any application (Notepad, a browser address bar, an email window, etc.).
2. Press **Ctrl+Space**. The overlay appears:

   ```
   🎙  Recording…
   ▁▃▆█▅▂▁ …  (live waveform)
   ```

3. Speak clearly.
4. Recording stops automatically after ~1.5 s of silence, or immediately when you press **Ctrl+Space** again.
5. The overlay switches to `⚙ Transcribing…` while the ASR model runs.
6. `✅ Done!` confirms the text has been typed into the focused field and copied to your clipboard.

### Stop

Press **Ctrl+C** in the terminal to exit.

### Common flags

| Flag | Default | Description |
|---|---|---|
| `--model_path` | `microsoft/VibeVoice-ASR` | HuggingFace model ID or local path |
| `--hotkey` | `ctrl+space` | Global hotkey |
| `--silence_threshold` | `0.01` | RMS level below which audio is treated as silence |
| `--silence_duration` | `1.5` | Seconds of silence before auto-stop |
| `--device` | `cpu` | `cpu`, `cuda`, or `auto` |
| `--dtype` | `bfloat16` | `float32`, `bfloat16`, or `float16` |
| `--no_auto_type` | *(off)* | Clipboard only; do not type into the active window |

**Example — GPU, custom hotkey, clipboard only:**

```bash
python demo/vibevoice_hotkey_dictation.py \
    --model_path microsoft/VibeVoice-ASR \
    --device cuda \
    --hotkey "ctrl+shift+space" \
    --no_auto_type
```

Full documentation: [vibevoice-hotkey-dictation.md](vibevoice-hotkey-dictation.md)

---

## VibeVoice-Realtime — Streaming TTS

Generate speech from text in real time with sub-300 ms first-audio latency.

### Install

```bash
pip install -e "."
```

### Run (from file)

```bash
python demo/realtime_model_inference_from_file.py \
    --model_path microsoft/VibeVoice-Realtime-0.5B \
    --text "Hello, this is a streaming TTS demo."
```

### Run (interactive demo)

```bash
python demo/vibevoice_realtime_demo.py \
    --model_path microsoft/VibeVoice-Realtime-0.5B
```

Or try the hosted [Colab notebook](https://colab.research.google.com/github/microsoft/VibeVoice/blob/main/demo/vibevoice_realtime_colab.ipynb) for a no-install experience.

Full documentation: [vibevoice-realtime-0.5b.md](vibevoice-realtime-0.5b.md)
