#!/usr/bin/env python
"""
VibeVoice Hotkey Dictation — Windows voice-to-text overlay

Press Ctrl+Space to start recording.  A small toast window appears in the
bottom-right corner showing a live waveform while you speak.  Recording stops
automatically after a configurable period of silence, or when you press
Ctrl+Space again.  The recognised text is placed on the clipboard and typed
into whatever text-field currently has focus.

Requirements (install with  pip install "vibevoice[hotkey-dictation]"):
    sounddevice, keyboard, pyperclip, pyautogui

Usage:
    python demo/vibevoice_hotkey_dictation.py --model_path microsoft/VibeVoice-ASR

Optional flags:
    --hotkey            ctrl+space          Global hotkey (default: ctrl+space)
    --silence_threshold 0.01               RMS below this triggers auto-stop
    --silence_duration  1.5                Seconds of silence before auto-stop
    --device            cpu                Torch device (cpu / cuda / auto)
    --dtype             bfloat16           Torch dtype (float32 / bfloat16)
    --no_auto_type                         Only copy to clipboard, do not type
    --max_new_tokens    512                Max tokens for generation
"""

import argparse
import queue
import sys
import threading
import time
import tkinter as tk
from tkinter import font as tkfont
from typing import List, Optional

import numpy as np
import torch

# ---------------------------------------------------------------------------
# Optional heavy imports — fail with helpful messages
# ---------------------------------------------------------------------------
try:
    import sounddevice as sd
except ImportError:
    sys.exit(
        "sounddevice is required.  Install it with:\n"
        '  pip install "vibevoice[hotkey-dictation]"'
    )

try:
    import keyboard
except ImportError:
    sys.exit(
        "keyboard is required.  Install it with:\n"
        '  pip install "vibevoice[hotkey-dictation]"'
    )

try:
    import pyperclip
except ImportError:
    sys.exit(
        "pyperclip is required.  Install it with:\n"
        '  pip install "vibevoice[hotkey-dictation]"'
    )

try:
    import pyautogui
except ImportError:
    sys.exit(
        "pyautogui is required.  Install it with:\n"
        '  pip install "vibevoice[hotkey-dictation]"'
    )


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SAMPLE_RATE = 16_000          # Hz — captured by sounddevice
CHUNK_FRAMES = 1_600          # ~100 ms per callback chunk
WAVEFORM_BARS = 30            # number of bars in the toast visualiser
TOAST_WIDTH = 340
TOAST_HEIGHT = 90
DISMISS_AFTER_MS = 2_500      # ms before "Done" toast auto-closes


# ---------------------------------------------------------------------------
# Recorder
# ---------------------------------------------------------------------------

class Recorder:
    """Captures microphone audio into a thread-safe queue."""

    def __init__(
        self,
        sample_rate: int = SAMPLE_RATE,
        chunk_frames: int = CHUNK_FRAMES,
        silence_threshold: float = 0.01,
        silence_duration: float = 1.5,
        on_silence_stop=None,
    ):
        self.sample_rate = sample_rate
        self.chunk_frames = chunk_frames
        self.silence_threshold = silence_threshold
        self.silence_duration = silence_duration
        self.on_silence_stop = on_silence_stop

        self._chunk_queue: queue.Queue[np.ndarray] = queue.Queue()
        self._stream: Optional[sd.InputStream] = None
        self._recording = False
        self._silence_frames = 0
        self._silence_frames_limit = int(silence_duration * sample_rate / chunk_frames)
        self._latest_chunk: Optional[np.ndarray] = None  # updated by callback for live display

    # ------------------------------------------------------------------
    def start(self):
        self._chunk_queue = queue.Queue()
        self._latest_chunk = None
        self._silence_frames = 0
        self._recording = True
        self._stream = sd.InputStream(
            samplerate=self.sample_rate,
            channels=1,
            dtype="float32",
            blocksize=self.chunk_frames,
            callback=self._callback,
        )
        self._stream.start()

    def stop(self) -> np.ndarray:
        self._recording = False
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        chunks: List[np.ndarray] = []
        while not self._chunk_queue.empty():
            chunks.append(self._chunk_queue.get_nowait())
        if chunks:
            return np.concatenate(chunks)
        return np.zeros(0, dtype=np.float32)

    def latest_chunk(self) -> Optional[np.ndarray]:
        """Return the most recent audio chunk for waveform display (non-blocking, no side-effects)."""
        return self._latest_chunk

    def is_recording(self) -> bool:
        return self._recording

    # ------------------------------------------------------------------
    def _callback(self, indata: np.ndarray, frames: int, time_info, status):
        if not self._recording:
            return
        chunk = indata[:, 0].copy()
        self._latest_chunk = chunk
        self._chunk_queue.put(chunk)

        rms = float(np.sqrt(np.mean(chunk ** 2)))
        if rms < self.silence_threshold:
            self._silence_frames += 1
        else:
            self._silence_frames = 0

        if self._silence_frames >= self._silence_frames_limit:
            self._recording = False  # prevent further accumulation
            if self.on_silence_stop:
                threading.Thread(target=self.on_silence_stop, daemon=True).start()


# ---------------------------------------------------------------------------
# Toast UI
# ---------------------------------------------------------------------------

class ToastWindow:
    """
    Small, borderless, always-on-top window anchored to the bottom-right
    corner of the primary monitor.
    """

    _STATE_RECORDING = "recording"
    _STATE_TRANSCRIBING = "transcribing"
    _STATE_DONE = "done"

    def __init__(self, recorder: Recorder):
        self._recorder = recorder
        self._root: Optional[tk.Tk] = None
        self._canvas: Optional[tk.Canvas] = None
        self._label: Optional[tk.Label] = None
        self._state = self._STATE_RECORDING
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    def show(self):
        self._state = self._STATE_RECORDING
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def set_transcribing(self):
        self._state = self._STATE_TRANSCRIBING

    def set_done(self):
        self._state = self._STATE_DONE

    def close(self):
        if self._root is not None:
            try:
                self._root.after(0, self._root.destroy)
            except Exception:
                pass

    # ------------------------------------------------------------------
    def _run(self):
        root = tk.Tk()
        self._root = root
        root.overrideredirect(True)          # borderless
        root.attributes("-topmost", True)    # always on top
        root.attributes("-alpha", 0.92)
        root.configure(bg="#1e1e2e")

        screen_w = root.winfo_screenwidth()
        screen_h = root.winfo_screenheight()
        x = screen_w - TOAST_WIDTH - 20
        y = screen_h - TOAST_HEIGHT - 60    # above taskbar
        root.geometry(f"{TOAST_WIDTH}x{TOAST_HEIGHT}+{x}+{y}")

        # Label
        lbl_font = tkfont.Font(family="Segoe UI", size=11, weight="bold")
        self._label = tk.Label(
            root,
            text="🎙  Recording…",
            font=lbl_font,
            fg="#cdd6f4",
            bg="#1e1e2e",
            anchor="w",
            padx=12,
        )
        self._label.pack(fill="x", pady=(10, 2))

        # Waveform canvas
        self._canvas = tk.Canvas(
            root,
            width=TOAST_WIDTH - 24,
            height=34,
            bg="#313244",
            highlightthickness=0,
            relief="flat",
        )
        self._canvas.pack(padx=12, pady=(0, 8))

        root.after(50, self._tick)
        root.mainloop()

    def _tick(self):
        """Called every 50 ms inside the Tk event loop."""
        if self._root is None:
            return

        if self._state == self._STATE_RECORDING:
            self._label.configure(text="🎙  Recording…", fg="#cdd6f4")
            self._draw_waveform()
        elif self._state == self._STATE_TRANSCRIBING:
            self._label.configure(text="⚙  Transcribing…", fg="#f9e2af")
            self._draw_idle_bars()
        elif self._state == self._STATE_DONE:
            self._label.configure(text="✅  Done!", fg="#a6e3a1")
            self._draw_idle_bars(color="#a6e3a1")
            self._root.after(DISMISS_AFTER_MS, self._root.destroy)
            return

        self._root.after(50, self._tick)

    def _draw_waveform(self):
        canvas = self._canvas
        canvas.delete("all")
        w = TOAST_WIDTH - 24
        h = 34
        bar_w = max(2, w // WAVEFORM_BARS - 1)
        gap = (w - bar_w * WAVEFORM_BARS) // (WAVEFORM_BARS + 1)

        chunk = self._recorder.latest_chunk()
        if chunk is not None and len(chunk) > 0:
            # Pad chunk to a multiple of WAVEFORM_BARS then reshape for vectorised max
            n = len(chunk)
            pad = (-n) % WAVEFORM_BARS
            padded = np.pad(np.abs(chunk), (0, pad), constant_values=0.0)
            amps = padded.reshape(WAVEFORM_BARS, -1).max(axis=1).tolist()
        else:
            amps = [0.0] * WAVEFORM_BARS

        max_amp = max(amps) if max(amps) > 0 else 1.0
        cy = h // 2

        for i, amp in enumerate(amps):
            norm = amp / max_amp
            bar_h = max(2, int(norm * (h - 6)))
            x0 = gap + i * (bar_w + gap)
            x1 = x0 + bar_w
            canvas.create_rectangle(
                x0, cy - bar_h // 2,
                x1, cy + bar_h // 2,
                fill="#89b4fa", outline="",
            )

    def _draw_idle_bars(self, color="#585b70"):
        canvas = self._canvas
        canvas.delete("all")
        w = TOAST_WIDTH - 24
        h = 34
        bar_w = max(2, w // WAVEFORM_BARS - 1)
        gap = (w - bar_w * WAVEFORM_BARS) // (WAVEFORM_BARS + 1)
        cy = h // 2
        for i in range(WAVEFORM_BARS):
            x0 = gap + i * (bar_w + gap)
            x1 = x0 + bar_w
            canvas.create_rectangle(x0, cy - 2, x1, cy + 2, fill=color, outline="")


# ---------------------------------------------------------------------------
# ASR engine
# ---------------------------------------------------------------------------

def load_asr(model_path: str, device: str, dtype: torch.dtype, attn: str):
    """Load VibeVoice ASR model and processor."""
    from vibevoice.modular.modeling_vibevoice_asr import VibeVoiceASRForConditionalGeneration
    from vibevoice.processor.vibevoice_asr_processor import VibeVoiceASRProcessor

    print(f"[VibeVoice] Loading ASR model from {model_path} …")
    processor = VibeVoiceASRProcessor.from_pretrained(
        model_path,
        language_model_pretrained_name="Qwen/Qwen2.5-7B",
    )
    model = VibeVoiceASRForConditionalGeneration.from_pretrained(
        model_path,
        dtype=dtype,
        device_map=device if device == "auto" else None,
        attn_implementation=attn,
        trust_remote_code=True,
    )
    if device != "auto":
        model = model.to(device)
    actual_device = device if device != "auto" else next(model.parameters()).device
    model.eval()
    print(f"[VibeVoice] Model ready on {actual_device}")
    return processor, model, actual_device


def transcribe(
    audio: np.ndarray,
    sample_rate: int,
    processor,
    model,
    device,
    dtype: torch.dtype,
    max_new_tokens: int = 512,
) -> str:
    """Run ASR on a float32 audio array and return plain text."""
    import librosa

    # Resample to model's target sample rate if necessary
    target_sr = processor.target_sample_rate
    if sample_rate != target_sr:
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=target_sr)

    # The processor accepts (array, sampling_rate) tuples or bare numpy arrays
    # (when sampling_rate=None the processor uses target_sample_rate)
    inputs = processor(
        audio=[(audio, target_sr)],
        sampling_rate=None,
        return_tensors="pt",
        padding=True,
        add_generation_prompt=True,
    )
    inputs = {
        k: v.to(device) if isinstance(v, torch.Tensor) else v
        for k, v in inputs.items()
    }

    gen_cfg = {
        "max_new_tokens": max_new_tokens,
        "pad_token_id": processor.pad_id,
        "eos_token_id": processor.tokenizer.eos_token_id,
        "do_sample": False,
    }

    with torch.no_grad():
        output_ids = model.generate(**inputs, **gen_cfg)

    input_length = inputs["input_ids"].shape[1]
    generated_ids = output_ids[0, input_length:]
    eos_pos = (generated_ids == processor.tokenizer.eos_token_id).nonzero(as_tuple=True)[0]
    if len(eos_pos) > 0:
        generated_ids = generated_ids[: eos_pos[0] + 1]

    raw_text = processor.decode(generated_ids, skip_special_tokens=True)

    # Extract plain text from structured JSON output
    try:
        segments = processor.post_process_transcription(raw_text)
        if segments:
            return " ".join(seg.get("text", "") for seg in segments).strip()
    except Exception:
        pass

    return raw_text.strip()


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

class DictationOrchestrator:
    """
    Ties together the hotkey, recorder, toast, ASR engine, and output actions.
    """

    def __init__(
        self,
        processor,
        model,
        device,
        dtype: torch.dtype,
        hotkey: str = "ctrl+space",
        silence_threshold: float = 0.01,
        silence_duration: float = 1.5,
        auto_type: bool = True,
        max_new_tokens: int = 512,
    ):
        self._processor = processor
        self._model = model
        self._device = device
        self._dtype = dtype
        self._hotkey = hotkey
        self._auto_type = auto_type
        self._max_new_tokens = max_new_tokens

        self._recorder = Recorder(
            sample_rate=SAMPLE_RATE,
            silence_threshold=silence_threshold,
            silence_duration=silence_duration,
            on_silence_stop=self._on_silence_stop,
        )
        self._toast: Optional[ToastWindow] = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    def run(self):
        print(f"[VibeVoice] Listening for hotkey: {self._hotkey}")
        print("[VibeVoice] Press Ctrl+C to quit.")
        keyboard.add_hotkey(self._hotkey, self._on_hotkey, suppress=True)
        keyboard.wait()

    # ------------------------------------------------------------------
    def _on_hotkey(self):
        with self._lock:
            if self._recorder.is_recording():
                self._stop_and_transcribe()
            else:
                self._start_recording()

    def _on_silence_stop(self):
        with self._lock:
            if self._recorder.is_recording():
                self._stop_and_transcribe()

    # ------------------------------------------------------------------
    def _start_recording(self):
        self._toast = ToastWindow(self._recorder)
        self._toast.show()
        self._recorder.start()
        print("[VibeVoice] Recording started.")

    def _stop_and_transcribe(self):
        audio = self._recorder.stop()
        print(f"[VibeVoice] Recording stopped — {len(audio) / SAMPLE_RATE:.1f}s captured.")

        if self._toast:
            self._toast.set_transcribing()

        # Run transcription in a background thread so the UI stays responsive
        threading.Thread(
            target=self._transcribe_and_output,
            args=(audio,),
            daemon=True,
        ).start()

    def _transcribe_and_output(self, audio: np.ndarray):
        if len(audio) < SAMPLE_RATE * 0.25:
            print("[VibeVoice] Audio too short — skipping transcription.")
            if self._toast:
                self._toast.close()
            return

        try:
            text = transcribe(
                audio=audio,
                sample_rate=SAMPLE_RATE,
                processor=self._processor,
                model=self._model,
                device=self._device,
                dtype=self._dtype,
                max_new_tokens=self._max_new_tokens,
            )
        except Exception as exc:
            print(f"[VibeVoice] Transcription error: {exc}")
            if self._toast:
                self._toast.close()
            return

        if not text:
            print("[VibeVoice] Empty transcription.")
            if self._toast:
                self._toast.close()
            return

        print(f"[VibeVoice] Transcribed: {text}")

        # Copy to clipboard
        try:
            pyperclip.copy(text)
        except Exception as exc:
            print(f"[VibeVoice] Clipboard error: {exc}")

        # Type into active window
        if self._auto_type:
            try:
                # Small pause so the window that was focused before the hotkey
                # can regain focus after any toast window activity
                time.sleep(0.15)
                pyautogui.write(text, interval=0.02)
            except Exception as exc:
                print(f"[VibeVoice] Auto-type error: {exc}")

        if self._toast:
            self._toast.set_done()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_args():
    parser = argparse.ArgumentParser(
        description="VibeVoice Hotkey Dictation — press a hotkey to dictate into any text field"
    )
    parser.add_argument(
        "--model_path",
        default="microsoft/VibeVoice-ASR",
        help="Path or HuggingFace model ID for VibeVoice-ASR (default: microsoft/VibeVoice-ASR)",
    )
    parser.add_argument(
        "--hotkey",
        default="ctrl+space",
        help="Global hotkey to toggle recording (default: ctrl+space)",
    )
    parser.add_argument(
        "--silence_threshold",
        type=float,
        default=0.01,
        help="RMS amplitude below which audio is considered silence (default: 0.01)",
    )
    parser.add_argument(
        "--silence_duration",
        type=float,
        default=1.5,
        help="Seconds of silence required to auto-stop recording (default: 1.5)",
    )
    parser.add_argument(
        "--device",
        default="cpu",
        help="Torch device: cpu / cuda / auto (default: cpu)",
    )
    parser.add_argument(
        "--dtype",
        default="bfloat16",
        choices=["float32", "bfloat16", "float16"],
        help="Model weight dtype (default: bfloat16)",
    )
    parser.add_argument(
        "--attn_implementation",
        default="sdpa",
        choices=["sdpa", "flash_attention_2", "eager"],
        help="Attention implementation (default: sdpa)",
    )
    parser.add_argument(
        "--no_auto_type",
        action="store_true",
        help="Only copy text to clipboard; do not auto-type into the active window",
    )
    parser.add_argument(
        "--max_new_tokens",
        type=int,
        default=512,
        help="Maximum tokens to generate during transcription (default: 512)",
    )
    return parser.parse_args()


def main():
    args = _parse_args()

    dtype_map = {
        "float32": torch.float32,
        "bfloat16": torch.bfloat16,
        "float16": torch.float16,
    }
    dtype = dtype_map[args.dtype]

    processor, model, device = load_asr(
        model_path=args.model_path,
        device=args.device,
        dtype=dtype,
        attn=args.attn_implementation,
    )

    orchestrator = DictationOrchestrator(
        processor=processor,
        model=model,
        device=device,
        dtype=dtype,
        hotkey=args.hotkey,
        silence_threshold=args.silence_threshold,
        silence_duration=args.silence_duration,
        auto_type=not args.no_auto_type,
        max_new_tokens=args.max_new_tokens,
    )
    orchestrator.run()


if __name__ == "__main__":
    main()
