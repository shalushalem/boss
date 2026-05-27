from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import struct
import tempfile
import time
from typing import Callable

import speech_recognition as sr

from core.config import AppConfig, load_config


StatusCallback = Callable[[str], None]


@dataclass(frozen=True)
class VisionResult:
    ok: bool
    message: str
    screenshot_path: Path | None = None


class SpeechSense:
    """Microphone input, local transcription, and wake-word detection."""

    def __init__(self, config: AppConfig | None = None, status_callback: StatusCallback | None = None):
        self.config = config or load_config()
        self.status_callback = status_callback
        self.recognizer = sr.Recognizer()
        self._whisper_model = None
        self._whisper_error: str | None = None

    @property
    def wake_word_enabled(self) -> bool:
        return self.config.wake_word_enabled

    @property
    def wake_word(self) -> str:
        return self.config.wake_word

    def listen(self, timeout: int = 5, phrase_limit: int = 10) -> str:
        audio = self._record_audio(timeout=timeout, phrase_limit=phrase_limit)
        if audio is None:
            return ""

        backend = self.config.stt_backend
        if backend in {"auto", "faster_whisper", "whisper"}:
            text = self._recognize_with_faster_whisper(audio)
            if text or backend in {"faster_whisper", "whisper"}:
                return text

        if backend in {"auto", "google"}:
            return self._recognize_with_google(audio)

        self._status(f"Unknown STT backend '{backend}'.")
        return ""

    def wait_for_wake_word(self, timeout: int | None = None) -> bool:
        if not self.config.wake_word_enabled:
            return True

        engine = self.config.wake_word_engine
        if engine in {"auto", "porcupine"}:
            detected = self._wait_for_porcupine(timeout=timeout)
            if detected or engine == "porcupine":
                return detected

        return self._wait_for_spoken_wake_word(timeout=timeout)

    def _record_audio(self, timeout: int, phrase_limit: int) -> sr.AudioData | None:
        with sr.Microphone() as source:
            self.recognizer.adjust_for_ambient_noise(source, duration=0.6)
            try:
                return self.recognizer.listen(source, timeout=timeout, phrase_time_limit=phrase_limit)
            except sr.WaitTimeoutError:
                return None

    def _recognize_with_faster_whisper(self, audio: sr.AudioData) -> str:
        model = self._get_whisper_model()
        if model is None:
            return ""

        wav_path = self._write_temp_wav(audio)
        try:
            segments, _ = model.transcribe(str(wav_path), beam_size=5, vad_filter=True)
            return " ".join(segment.text.strip() for segment in segments).strip()
        except Exception as exc:
            self._status(f"Faster-Whisper transcription failed: {exc}")
            return ""
        finally:
            try:
                wav_path.unlink(missing_ok=True)
            except OSError:
                pass

    def _get_whisper_model(self):
        if self._whisper_model is not None:
            return self._whisper_model
        if self._whisper_error:
            return None

        try:
            from faster_whisper import WhisperModel

            self._status(f"Loading Faster-Whisper model '{self.config.whisper_model_size}'...")
            self._whisper_model = WhisperModel(
                self.config.whisper_model_size,
                device=self.config.whisper_device,
                compute_type=self.config.whisper_compute_type,
            )
            self._status("Offline speech recognition online.")
            return self._whisper_model
        except Exception as exc:
            self._whisper_error = str(exc)
            self._status(f"Faster-Whisper unavailable: {exc}")
            return None

    def _recognize_with_google(self, audio: sr.AudioData) -> str:
        try:
            return self.recognizer.recognize_google(audio)
        except sr.UnknownValueError:
            return ""
        except sr.RequestError:
            self._status("Google speech recognition unavailable.")
            return ""

    def _wait_for_porcupine(self, timeout: int | None) -> bool:
        access_key = self.config.porcupine_access_key
        if not access_key:
            self._status("Porcupine access key missing; using speech wake fallback.")
            return False

        try:
            import pvporcupine
            import pyaudio
        except ImportError as exc:
            self._status(f"Porcupine unavailable: {exc}")
            return False

        porcupine = None
        audio = None
        stream = None
        try:
            porcupine = pvporcupine.create(access_key=access_key, keywords=[self.config.wake_word])
            audio = pyaudio.PyAudio()
            stream = audio.open(
                rate=porcupine.sample_rate,
                channels=1,
                format=pyaudio.paInt16,
                input=True,
                frames_per_buffer=porcupine.frame_length,
            )

            started_at = time.monotonic()
            while timeout is None or time.monotonic() - started_at < timeout:
                pcm = stream.read(porcupine.frame_length, exception_on_overflow=False)
                frame = struct.unpack_from("h" * porcupine.frame_length, pcm)
                if porcupine.process(frame) >= 0:
                    return True
        except Exception as exc:
            self._status(f"Porcupine wake detection failed: {exc}")
        finally:
            if stream is not None:
                stream.stop_stream()
                stream.close()
            if audio is not None:
                audio.terminate()
            if porcupine is not None:
                porcupine.delete()

        return False

    def _wait_for_spoken_wake_word(self, timeout: int | None) -> bool:
        started_at = time.monotonic()
        while timeout is None or time.monotonic() - started_at < timeout:
            phrase = self.listen(timeout=4, phrase_limit=3).lower()
            if self.config.wake_word in phrase:
                return True
        return False

    def _write_temp_wav(self, audio: sr.AudioData) -> Path:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as wav_file:
            wav_file.write(audio.get_wav_data())
            return Path(wav_file.name)

    def _status(self, message: str) -> None:
        if self.status_callback:
            self.status_callback(message)


class VisionSense:
    """Screen capture plus local visual analysis and OCR fallback."""

    def __init__(self, config: AppConfig | None = None, status_callback: StatusCallback | None = None):
        self.config = config or load_config()
        self.status_callback = status_callback

    def analyze_screen(self, question: str = "") -> VisionResult:
        try:
            screenshot_path = self.capture_screen()
        except Exception as exc:
            return VisionResult(False, f"I could not capture the screen, Boss: {exc}")

        backend = self.config.vision_backend
        if backend in {"auto", "ollama", "vision"}:
            result = self._analyze_with_ollama(screenshot_path, question)
            if result.ok or backend in {"ollama", "vision"}:
                return result

        if backend in {"auto", "ocr"}:
            return self._analyze_with_ocr(screenshot_path, question)

        return VisionResult(False, f"Unknown vision backend '{backend}', Boss.", screenshot_path)

    def capture_screen(self) -> Path:
        self.config.screenshots_dir.mkdir(parents=True, exist_ok=True)
        screenshot_path = self.config.screenshots_dir / f"screen_{time.strftime('%Y%m%d_%H%M%S')}.png"
        backend = self.config.screen_capture_backend

        errors: list[str] = []
        if backend in {"auto", "mss"}:
            try:
                self._capture_with_mss(screenshot_path)
                return screenshot_path
            except Exception as exc:
                errors.append(f"mss: {exc}")
                if backend == "mss":
                    raise

        if backend in {"auto", "pyautogui"}:
            try:
                self._capture_with_pyautogui(screenshot_path)
                return screenshot_path
            except Exception as exc:
                errors.append(f"pyautogui: {exc}")
                if backend == "pyautogui":
                    raise

        if backend in {"auto", "pil", "imagegrab"}:
            try:
                self._capture_with_imagegrab(screenshot_path)
                return screenshot_path
            except Exception as exc:
                errors.append(f"imagegrab: {exc}")
                if backend in {"pil", "imagegrab"}:
                    raise

        raise RuntimeError("; ".join(errors) or f"unknown capture backend '{backend}'")

    def _capture_with_mss(self, screenshot_path: Path) -> None:
        import mss
        from PIL import Image

        with mss.mss() as screen_capture:
            monitor = screen_capture.monitors[0]
            image = screen_capture.grab(monitor)
            png = Image.frombytes("RGB", image.size, image.bgra, "raw", "BGRX")
            png.save(screenshot_path)

    def _capture_with_pyautogui(self, screenshot_path: Path) -> None:
        import pyautogui

        screenshot = pyautogui.screenshot()
        screenshot.save(screenshot_path)

    def _capture_with_imagegrab(self, screenshot_path: Path) -> None:
        from PIL import ImageGrab

        screenshot = ImageGrab.grab(all_screens=True)
        screenshot.save(screenshot_path)

    def _analyze_with_ollama(self, screenshot_path: Path, question: str) -> VisionResult:
        prompt = (
            question.strip()
            or "Describe what is visible on this screen. Focus on windows, readable text, errors, and actionable UI."
        )
        prompt = f"{prompt}\nAnswer concisely as J.A.R.V.I.S. and address the user as Boss."

        try:
            import ollama

            self._status(f"Analyzing screen with {self.config.vision_model}...")
            response = ollama.chat(
                model=self.config.vision_model,
                messages=[
                    {
                        "role": "user",
                        "content": prompt,
                        "images": [str(screenshot_path)],
                    }
                ],
            )
            message = response["message"]["content"].strip()
            return VisionResult(True, message, screenshot_path)
        except Exception as exc:
            self._status(f"Ollama vision unavailable: {exc}")
            return VisionResult(False, f"Vision model unavailable: {exc}", screenshot_path)

    def _analyze_with_ocr(self, screenshot_path: Path, question: str) -> VisionResult:
        text = self._extract_screen_text(screenshot_path)
        if not text:
            return VisionResult(
                False,
                f"I captured the screen, but OCR could not read visible text, Boss. Screenshot: {screenshot_path}",
                screenshot_path,
            )

        answer = self._answer_from_ocr_text(text, question)
        return VisionResult(True, answer, screenshot_path)

    def _extract_screen_text(self, screenshot_path: Path) -> str:
        try:
            import pytesseract
            from PIL import Image

            if self.config.tesseract_cmd:
                pytesseract.pytesseract.tesseract_cmd = self.config.tesseract_cmd
            self._status("Reading screen text with OCR...")
            return pytesseract.image_to_string(Image.open(screenshot_path)).strip()
        except Exception as exc:
            self._status(f"OCR unavailable: {exc}")
            return ""

    def _answer_from_ocr_text(self, screen_text: str, question: str) -> str:
        compact_text = " ".join(screen_text.split())
        if len(compact_text) > 2500:
            compact_text = compact_text[:2500] + "..."

        if not question.strip():
            return f"Boss, I can read this on the screen: {compact_text}"

        try:
            import ollama

            response = ollama.chat(
                model=self.config.ollama_model,
                messages=[
                    {
                        "role": "system",
                        "content": "Answer the user's screen question using only OCR text. Be concise and address them as Boss.",
                    },
                    {
                        "role": "user",
                        "content": f"Question: {question}\n\nOCR text from screen:\n{compact_text}",
                    },
                ],
            )
            return response["message"]["content"].strip()
        except Exception:
            return f"Boss, OCR found this visible text: {compact_text}"

    def _status(self, message: str) -> None:
        if self.status_callback:
            self.status_callback(message)
