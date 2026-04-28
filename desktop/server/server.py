#!/usr/bin/env python
"""
VibeVoice Desktop App Server
==============================
Unified FastAPI backend providing:
  - Streaming TTS via WebSocket  (/tts/stream)
  - ASR transcription via REST   (/asr/transcribe)
  - Model management endpoints   (/tts/load, /asr/load, /status)

Usage:
  python server.py [--port 3001] [--host 127.0.0.1]

Environment variables:
  TTS_MODEL_PATH   HuggingFace repo ID or local path for Realtime TTS model
  ASR_MODEL_PATH   HuggingFace repo ID or local path for ASR model
  MODEL_DEVICE     cuda | mps | cpu | auto  (default: auto)
"""

import argparse
import asyncio
import copy
import json
import os
import sys
import tempfile
import threading
import traceback
from pathlib import Path
from queue import Empty, Queue
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple, cast
import datetime

import numpy as np
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.websockets import WebSocketDisconnect, WebSocketState

# ------------------------------------------------------------------ #
# Project root: desktop/server/server.py -> VibeVoice/
# ------------------------------------------------------------------ #
_THIS_DIR = Path(__file__).resolve().parent        # desktop/server/
_PROJECT_ROOT = _THIS_DIR.parent.parent            # VibeVoice/
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from vibevoice.modular.modeling_vibevoice_streaming_inference import (
    VibeVoiceStreamingForConditionalGenerationInference,
)
from vibevoice.processor.vibevoice_streaming_processor import VibeVoiceStreamingProcessor
from vibevoice.modular.streamer import AudioStreamer
from vibevoice.modular.modeling_vibevoice_asr import VibeVoiceASRForConditionalGeneration
from vibevoice.processor.vibevoice_asr_processor import VibeVoiceASRProcessor

SAMPLE_RATE = 24_000
_VOICES_DIR = _PROJECT_ROOT / "demo" / "voices" / "streaming_model"


def _auto_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _now() -> str:
    return datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


# ================================================================== #
# Streaming TTS Service (adapted from demo/web/app.py)
# ================================================================== #

class StreamingTTSService:
    """Wraps VibeVoice-Realtime for streaming text-to-speech."""

    def __init__(self, model_path: str, device: str) -> None:
        self.model_path = model_path
        self.device = device
        self._torch_device = torch.device(device)
        self.sample_rate = SAMPLE_RATE
        self.inference_steps: int = 5
        self.processor: Optional[VibeVoiceStreamingProcessor] = None
        self.model: Optional[VibeVoiceStreamingForConditionalGenerationInference] = None
        self.voice_presets: Dict[str, Path] = {}
        self.default_voice_key: Optional[str] = None
        self._voice_cache: Dict[str, Any] = {}
        self.loaded = False
        self.loading = False
        self.load_error: Optional[str] = None

    def load(self) -> None:
        if self.loaded:
            return
        self.loading = True
        self.load_error = None
        try:
            self._do_load()
            self.loaded = True
            print(f"[TTS] Model ready on {self.device}", flush=True)
        except Exception as e:
            self.load_error = str(e)
            traceback.print_exc()
            raise
        finally:
            self.loading = False

    def _do_load(self) -> None:
        print(f"[TTS] Loading processor from {self.model_path}", flush=True)
        self.processor = VibeVoiceStreamingProcessor.from_pretrained(self.model_path)

        if self.device == "mps":
            load_dtype = torch.float32
            device_map = None
            attn_impl = "sdpa"
        elif self.device == "cuda":
            load_dtype = torch.bfloat16
            device_map = "cuda"
            attn_impl = "flash_attention_2"
        else:
            load_dtype = torch.float32
            device_map = "cpu"
            attn_impl = "sdpa"

        print(f"[TTS] Loading model (dtype={load_dtype}, device={device_map}, attn={attn_impl})", flush=True)
        try:
            self.model = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
                self.model_path,
                torch_dtype=load_dtype,
                device_map=device_map,
                attn_implementation=attn_impl,
            )
        except Exception:
            if attn_impl == "flash_attention_2":
                print("[TTS] Flash attention failed, falling back to SDPA", flush=True)
                self.model = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
                    self.model_path,
                    torch_dtype=load_dtype,
                    device_map=device_map,
                    attn_implementation="sdpa",
                )
            else:
                raise

        if self.device == "mps" and self.model is not None:
            self.model.to("mps")

        self.model.eval()
        self.model.model.noise_scheduler = self.model.model.noise_scheduler.from_config(
            self.model.model.noise_scheduler.config,
            algorithm_type="sde-dpmsolver++",
            beta_schedule="squaredcos_cap_v2",
        )
        self.model.set_ddpm_inference_steps(num_steps=self.inference_steps)

        self.voice_presets = self._scan_voice_presets()
        self.default_voice_key = self._pick_default_voice(os.environ.get("VOICE_PRESET"))
        self._cache_voice(self.default_voice_key)

    def _scan_voice_presets(self) -> Dict[str, Path]:
        if not _VOICES_DIR.exists():
            print(f"[TTS] Warning: voices directory not found at {_VOICES_DIR}", flush=True)
            return {}
        presets = {p.stem: p for p in _VOICES_DIR.rglob("*.pt")}
        print(f"[TTS] Found {len(presets)} voice presets", flush=True)
        return dict(sorted(presets.items()))

    def _pick_default_voice(self, name: Optional[str]) -> Optional[str]:
        if not self.voice_presets:
            return None
        if name and name in self.voice_presets:
            return name
        preferred = "en-Carter_man"
        return preferred if preferred in self.voice_presets else next(iter(self.voice_presets))

    def _cache_voice(self, key: Optional[str]) -> Any:
        if key is None or key not in self.voice_presets:
            return None
        if key not in self._voice_cache:
            path = self.voice_presets[key]
            print(f"[TTS] Loading voice preset: {key}", flush=True)
            self._voice_cache[key] = torch.load(
                path, map_location=self._torch_device, weights_only=False
            )
        return self._voice_cache[key]

    def _resolve_voice(self, requested: Optional[str]) -> Tuple[str, Any]:
        key = (
            requested
            if (requested and requested in self.voice_presets)
            else self.default_voice_key
        )
        if key is None:
            raise RuntimeError("No voice presets available")
        return key, self._cache_voice(key)

    def _prepare_inputs(self, text: str, prefilled: Any) -> Dict[str, Any]:
        processed = self.processor.process_input_with_cached_prompt(
            text=text.strip(),
            cached_prompt=prefilled,
            padding=True,
            return_tensors="pt",
            return_attention_mask=True,
        )
        return {
            k: (v.to(self._torch_device) if hasattr(v, "to") else v)
            for k, v in processed.items()
        }

    def _generate_thread(
        self,
        inputs: Dict,
        streamer: AudioStreamer,
        errors: List,
        cfg_scale: float,
        do_sample: bool,
        temperature: float,
        top_p: float,
        refresh_negative: bool,
        prefilled: Any,
        stop: threading.Event,
    ) -> None:
        try:
            self.model.generate(
                **inputs,
                max_new_tokens=None,
                cfg_scale=cfg_scale,
                tokenizer=self.processor.tokenizer,
                generation_config={
                    "do_sample": do_sample,
                    "temperature": temperature if do_sample else 1.0,
                    "top_p": top_p if do_sample else 1.0,
                },
                audio_streamer=streamer,
                stop_check_fn=stop.is_set,
                verbose=False,
                refresh_negative=refresh_negative,
                all_prefilled_outputs=copy.deepcopy(prefilled),
            )
        except Exception as exc:
            errors.append(exc)
            traceback.print_exc()
        finally:
            streamer.end()

    def stream(
        self,
        text: str,
        cfg_scale: float = 1.5,
        do_sample: bool = False,
        temperature: float = 0.9,
        top_p: float = 0.9,
        refresh_negative: bool = True,
        inference_steps: Optional[int] = None,
        voice_key: Optional[str] = None,
        stop_event: Optional[threading.Event] = None,
    ) -> Iterator[np.ndarray]:
        if not text.strip():
            return
        text = text.replace("\u2019", "'")
        _, prefilled = self._resolve_voice(voice_key)

        steps = self.inference_steps
        if inference_steps and inference_steps > 0:
            steps = inference_steps
        self.model.set_ddpm_inference_steps(num_steps=steps)

        inputs = self._prepare_inputs(text, prefilled)
        audio_streamer = AudioStreamer(batch_size=1, stop_signal=None, timeout=None)
        errors: List = []
        stop = stop_event or threading.Event()

        t = threading.Thread(
            target=self._generate_thread,
            kwargs={
                "inputs": inputs,
                "streamer": audio_streamer,
                "errors": errors,
                "cfg_scale": cfg_scale,
                "do_sample": do_sample,
                "temperature": temperature,
                "top_p": top_p,
                "refresh_negative": refresh_negative,
                "prefilled": prefilled,
                "stop": stop,
            },
            daemon=True,
        )
        t.start()

        try:
            for chunk in audio_streamer.get_stream(0):
                if torch.is_tensor(chunk):
                    chunk = chunk.detach().cpu().to(torch.float32).numpy()
                else:
                    chunk = np.asarray(chunk, dtype=np.float32)
                if chunk.ndim > 1:
                    chunk = chunk.reshape(-1)
                peak = np.max(np.abs(chunk)) if chunk.size else 0.0
                if peak > 1.0:
                    chunk = chunk / peak
                yield chunk.astype(np.float32, copy=False)
        finally:
            stop.set()
            audio_streamer.end()
            t.join()
            if errors:
                raise errors[0]

    @staticmethod
    def to_pcm16(chunk: np.ndarray) -> bytes:
        chunk = np.clip(chunk, -1.0, 1.0)
        return (chunk * 32767.0).astype(np.int16).tobytes()


# ================================================================== #
# ASR Service (adapted from demo/vibevoice_asr_inference_from_file.py)
# ================================================================== #

class ASRService:
    """Wraps VibeVoice-ASR for single-file transcription."""

    def __init__(self, model_path: str, device: str) -> None:
        self.model_path = model_path
        self.device = device
        self.processor: Optional[VibeVoiceASRProcessor] = None
        self.model: Optional[VibeVoiceASRForConditionalGeneration] = None
        self._effective_device: Optional[str] = None
        self.loaded = False
        self.loading = False
        self.load_error: Optional[str] = None

    def load(self) -> None:
        if self.loaded:
            return
        self.loading = True
        self.load_error = None
        try:
            self._do_load()
            self.loaded = True
            print(f"[ASR] Model ready on {self._effective_device}", flush=True)
        except Exception as e:
            self.load_error = str(e)
            traceback.print_exc()
            raise
        finally:
            self.loading = False

    def _do_load(self) -> None:
        print(f"[ASR] Loading processor from {self.model_path}", flush=True)
        self.processor = VibeVoiceASRProcessor.from_pretrained(
            self.model_path,
            language_model_pretrained_name="Qwen/Qwen2.5-7B",
        )

        dtype = torch.bfloat16 if self.device == "cuda" else torch.float32
        use_device_map = self.device == "auto"
        print(
            f"[ASR] Loading model (dtype={dtype}, "
            f"{'device_map=auto' if use_device_map else f'device={self.device}'})",
            flush=True,
        )
        self.model = VibeVoiceASRForConditionalGeneration.from_pretrained(
            self.model_path,
            dtype=dtype,
            device_map="auto" if use_device_map else None,
            attn_implementation="sdpa",
            trust_remote_code=True,
        )
        if not use_device_map:
            self.model = self.model.to(self.device)

        self._effective_device = (
            str(next(self.model.parameters()).device)
            if use_device_map
            else self.device
        )
        self.model.eval()

    def transcribe(self, audio_path: str, max_new_tokens: int = 512) -> Dict[str, Any]:
        if not self.loaded or self.processor is None or self.model is None:
            raise RuntimeError("ASR model not loaded")

        inputs = self.processor(
            audio=[audio_path],
            sampling_rate=None,
            return_tensors="pt",
            padding=True,
            add_generation_prompt=True,
        )
        inputs = {
            k: (v.to(self._effective_device) if isinstance(v, torch.Tensor) else v)
            for k, v in inputs.items()
        }

        gen_config = {
            "max_new_tokens": max_new_tokens,
            "pad_token_id": self.processor.pad_id,
            "eos_token_id": self.processor.tokenizer.eos_token_id,
            "do_sample": False,
        }

        with torch.no_grad():
            output_ids = self.model.generate(**inputs, **gen_config)

        input_len = inputs["input_ids"].shape[1]
        generated_ids = output_ids[0, input_len:]
        eos_pos = (
            generated_ids == self.processor.tokenizer.eos_token_id
        ).nonzero(as_tuple=True)[0]
        if len(eos_pos) > 0:
            generated_ids = generated_ids[: eos_pos[0] + 1]

        raw_text = self.processor.decode(generated_ids, skip_special_tokens=True)
        segments: List = []
        try:
            segments = self.processor.post_process_transcription(raw_text)
        except Exception:
            pass

        return {"text": raw_text, "segments": segments}


# ================================================================== #
# FastAPI application
# ================================================================== #

app = FastAPI(title="VibeVoice Desktop Server", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # local-only server; restrict to localhost is fine
    allow_methods=["*"],
    allow_headers=["*"],
)

# Service singletons — populated on startup
_tts_service: Optional[StreamingTTSService] = None
_asr_service: Optional[ASRService] = None
_ws_lock: Optional[asyncio.Lock] = None
_device: str = "cpu"


@app.on_event("startup")
async def _startup() -> None:
    global _tts_service, _asr_service, _ws_lock, _device

    raw_device = os.environ.get("MODEL_DEVICE", "auto").strip()
    _device = _auto_device() if raw_device == "auto" else raw_device
    _ws_lock = asyncio.Lock()

    tts_path = os.environ.get("TTS_MODEL_PATH", "").strip()
    asr_path = os.environ.get("ASR_MODEL_PATH", "").strip()

    if tts_path:
        _tts_service = StreamingTTSService(model_path=tts_path, device=_device)
    if asr_path:
        _asr_service = ASRService(model_path=asr_path, device=_device)

    print(
        f"[startup] Server ready — "
        f"TTS={'configured' if tts_path else 'not configured'}, "
        f"ASR={'configured' if asr_path else 'not configured'}, "
        f"device={_device}",
        flush=True,
    )


# ------------------------------------------------------------------ #
# Health / status
# ------------------------------------------------------------------ #

@app.get("/health")
async def health():
    return {"status": "ok", "timestamp": _now()}


@app.get("/status")
async def status():
    return {
        "device": _device,
        "tts": {
            "configured": _tts_service is not None,
            "loaded": _tts_service.loaded if _tts_service else False,
            "loading": _tts_service.loading if _tts_service else False,
            "error": _tts_service.load_error if _tts_service else None,
        },
        "asr": {
            "configured": _asr_service is not None,
            "loaded": _asr_service.loaded if _asr_service else False,
            "loading": _asr_service.loading if _asr_service else False,
            "error": _asr_service.load_error if _asr_service else None,
        },
    }


# ------------------------------------------------------------------ #
# Voices
# ------------------------------------------------------------------ #

@app.get("/voices")
async def list_voices():
    if _tts_service and _tts_service.loaded:
        return {
            "voices": sorted(_tts_service.voice_presets.keys()),
            "default": _tts_service.default_voice_key,
        }
    # Scan without needing the model loaded
    if _VOICES_DIR.exists():
        voices = sorted(p.stem for p in _VOICES_DIR.rglob("*.pt"))
        default = (
            "en-Carter_man"
            if "en-Carter_man" in voices
            else (voices[0] if voices else None)
        )
        return {"voices": voices, "default": default}
    return {"voices": [], "default": None}


# ------------------------------------------------------------------ #
# Model loading (explicit, on-demand)
# ------------------------------------------------------------------ #

@app.post("/tts/load")
async def load_tts():
    if _tts_service is None:
        raise HTTPException(status_code=400, detail="TTS model path not configured. Set TTS_MODEL_PATH.")
    if _tts_service.loaded:
        return {"status": "already_loaded"}
    if _tts_service.loading:
        return {"status": "loading"}
    await asyncio.to_thread(_tts_service.load)
    return {"status": "loaded"}


@app.post("/asr/load")
async def load_asr():
    if _asr_service is None:
        raise HTTPException(status_code=400, detail="ASR model path not configured. Set ASR_MODEL_PATH.")
    if _asr_service.loaded:
        return {"status": "already_loaded"}
    if _asr_service.loading:
        return {"status": "loading"}
    await asyncio.to_thread(_asr_service.load)
    return {"status": "loaded"}


# ------------------------------------------------------------------ #
# ASR transcription
# ------------------------------------------------------------------ #

@app.post("/asr/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    max_new_tokens: int = Form(512),
):
    if _asr_service is None:
        raise HTTPException(status_code=400, detail="ASR model not configured.")
    if not _asr_service.loaded:
        raise HTTPException(
            status_code=503,
            detail="ASR model not loaded. Call POST /asr/load first.",
        )

    suffix = Path(file.filename).suffix if file.filename else ".wav"
    tmp_path: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp_path = tmp.name
            content = await file.read()
            tmp.write(content)
        result = await asyncio.to_thread(_asr_service.transcribe, tmp_path, max_new_tokens)
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    return result


# ------------------------------------------------------------------ #
# TTS WebSocket streaming
# ------------------------------------------------------------------ #

@app.websocket("/tts/stream")
async def tts_stream(ws: WebSocket) -> None:
    await ws.accept()

    text = ws.query_params.get("text", "")
    voice = ws.query_params.get("voice") or None
    cfg_str = ws.query_params.get("cfg", "1.5")
    steps_str = ws.query_params.get("steps", "")

    try:
        cfg_scale = float(cfg_str)
        if cfg_scale <= 0:
            cfg_scale = 1.5
    except ValueError:
        cfg_scale = 1.5

    inference_steps: Optional[int] = None
    if steps_str.isdigit():
        v = int(steps_str)
        if v > 0:
            inference_steps = v

    if _tts_service is None:
        await ws.send_text(json.dumps({"type": "error", "message": "TTS model not configured"}))
        await ws.close(code=1011)
        return

    if not _tts_service.loaded:
        await ws.send_text(json.dumps({"type": "error", "message": "TTS model not loaded. Call POST /tts/load first."}))
        await ws.close(code=1011)
        return

    if _ws_lock and _ws_lock.locked():
        await ws.send_text(json.dumps({"type": "error", "message": "Server busy — another request is in progress"}))
        await ws.close(code=1013)
        return

    async with _ws_lock:
        stop_signal = threading.Event()
        iterator = _tts_service.stream(
            text,
            cfg_scale=cfg_scale,
            inference_steps=inference_steps,
            voice_key=voice,
            stop_event=stop_signal,
        )
        sentinel = object()
        try:
            while ws.client_state == WebSocketState.CONNECTED:
                chunk = await asyncio.to_thread(next, iterator, sentinel)
                if chunk is sentinel:
                    break
                payload = StreamingTTSService.to_pcm16(cast(np.ndarray, chunk))
                await ws.send_bytes(payload)
        except WebSocketDisconnect:
            stop_signal.set()
        except Exception:
            traceback.print_exc()
            stop_signal.set()
        finally:
            stop_signal.set()
            closer = getattr(iterator, "close", None)
            if callable(closer):
                closer()
            try:
                if ws.client_state == WebSocketState.CONNECTED:
                    await ws.close()
            except Exception:
                pass


# ------------------------------------------------------------------ #
# CLI entry point
# ------------------------------------------------------------------ #

if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description="VibeVoice Desktop Server")
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("SERVER_PORT", "3001")),
        help="Port to listen on (default: 3001)",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host to bind to (default: 127.0.0.1)",
    )
    args = parser.parse_args()

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
