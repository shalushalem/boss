from dataclasses import dataclass
from pathlib import Path
import os

try:
    from dotenv import load_dotenv
except ImportError:  # Keeps the app bootable before dependencies are installed.
    load_dotenv = None


BASE_DIR = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class AppConfig:
    base_dir: Path
    memory_db_path: Path
    legacy_memory_path: Path
    ollama_model: str
    speaker_rate: int
    flask_port: int
    stt_backend: str
    whisper_model_size: str
    whisper_device: str
    whisper_compute_type: str
    wake_word_enabled: bool
    wake_word_engine: str
    wake_word: str
    porcupine_access_key: str
    screenshots_dir: Path
    screen_capture_backend: str
    vision_backend: str
    vision_model: str
    ocr_backend: str
    tesseract_cmd: str


def load_config() -> AppConfig:
    env_path = BASE_DIR / ".env"
    if load_dotenv:
        load_dotenv(env_path)

    memory_db_path = Path(os.getenv("JARVIS_MEMORY_DB", BASE_DIR / "data" / "jarvis.sqlite3"))
    legacy_memory_path = Path(os.getenv("JARVIS_LEGACY_MEMORY", BASE_DIR / "jarvis_memory.json"))
    screenshots_dir = Path(os.getenv("JARVIS_SCREENSHOTS_DIR", BASE_DIR / "data" / "screenshots"))

    return AppConfig(
        base_dir=BASE_DIR,
        memory_db_path=memory_db_path,
        legacy_memory_path=legacy_memory_path,
        ollama_model=os.getenv("JARVIS_OLLAMA_MODEL", "llama3"),
        speaker_rate=int(os.getenv("JARVIS_SPEAKER_RATE", "2")),
        flask_port=int(os.getenv("JARVIS_FLASK_PORT", "5000")),
        stt_backend=os.getenv("JARVIS_STT_BACKEND", "auto").lower(),
        whisper_model_size=os.getenv("JARVIS_WHISPER_MODEL_SIZE", "base"),
        whisper_device=os.getenv("JARVIS_WHISPER_DEVICE", "cpu"),
        whisper_compute_type=os.getenv("JARVIS_WHISPER_COMPUTE_TYPE", "int8"),
        wake_word_enabled=os.getenv("JARVIS_WAKE_WORD_ENABLED", "true").lower() in {"1", "true", "yes", "on"},
        wake_word_engine=os.getenv("JARVIS_WAKE_WORD_ENGINE", "auto").lower(),
        wake_word=os.getenv("JARVIS_WAKE_WORD", "jarvis").lower(),
        porcupine_access_key=os.getenv("PICOVOICE_ACCESS_KEY", ""),
        screenshots_dir=screenshots_dir,
        screen_capture_backend=os.getenv("JARVIS_SCREEN_CAPTURE_BACKEND", "auto").lower(),
        vision_backend=os.getenv("JARVIS_VISION_BACKEND", "auto").lower(),
        vision_model=os.getenv("JARVIS_VISION_MODEL", "llava"),
        ocr_backend=os.getenv("JARVIS_OCR_BACKEND", "auto").lower(),
        tesseract_cmd=os.getenv("TESSERACT_CMD", ""),
    )
