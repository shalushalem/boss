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


def load_config() -> AppConfig:
    env_path = BASE_DIR / ".env"
    if load_dotenv:
        load_dotenv(env_path)

    memory_db_path = Path(os.getenv("JARVIS_MEMORY_DB", BASE_DIR / "data" / "jarvis.sqlite3"))
    legacy_memory_path = Path(os.getenv("JARVIS_LEGACY_MEMORY", BASE_DIR / "jarvis_memory.json"))

    return AppConfig(
        base_dir=BASE_DIR,
        memory_db_path=memory_db_path,
        legacy_memory_path=legacy_memory_path,
        ollama_model=os.getenv("JARVIS_OLLAMA_MODEL", "llama3"),
        speaker_rate=int(os.getenv("JARVIS_SPEAKER_RATE", "2")),
        flask_port=int(os.getenv("JARVIS_FLASK_PORT", "5000")),
    )

