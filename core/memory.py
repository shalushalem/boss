from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import json
import re
import sqlite3
from typing import Iterable


PHONE_RE = re.compile(r"^\+\d{8,15}$")


@dataclass(frozen=True)
class Contact:
    name: str
    phone_number: str
    display_name: str


def normalize_contact_name(name: str) -> str:
    return " ".join(name.strip().lower().split())


def normalize_phone_number(raw_number: str) -> str:
    compact = raw_number.strip().replace(" ", "").replace("-", "").replace("(", "").replace(")", "")
    if compact.startswith("00"):
        compact = "+" + compact[2:]
    if not compact.startswith("+") and compact.isdigit():
        compact = "+" + compact
    return compact


def is_valid_phone_number(phone_number: str) -> bool:
    return bool(PHONE_RE.match(phone_number))


class JarvisMemory:
    def __init__(self, db_path: Path, legacy_memory_path: Path | None = None):
        self.db_path = Path(db_path)
        self.legacy_memory_path = Path(legacy_memory_path) if legacy_memory_path else None
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._setup()
        if self.legacy_memory_path:
            self.import_legacy_contacts(self.legacy_memory_path)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _setup(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS contacts (
                    name TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    phone_number TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS conversation_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS action_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    action TEXT NOT NULL,
                    parameters_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    message TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """
            )

    def import_legacy_contacts(self, json_path: Path) -> None:
        if not json_path.exists():
            return

        try:
            legacy_contacts = json.loads(json_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return

        if not isinstance(legacy_contacts, dict):
            return

        for name, number in legacy_contacts.items():
            normalized_number = normalize_phone_number(str(number))
            if is_valid_phone_number(normalized_number):
                self.save_contact(str(name), normalized_number)

    def save_contact(self, name: str, phone_number: str) -> Contact:
        normalized_name = normalize_contact_name(name)
        normalized_number = normalize_phone_number(phone_number)
        if not normalized_name:
            raise ValueError("Contact name cannot be empty.")
        if not is_valid_phone_number(normalized_number):
            raise ValueError("Phone number must include country code, for example +919876543210.")

        display_name = name.strip()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO contacts (name, display_name, phone_number)
                VALUES (?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    display_name = excluded.display_name,
                    phone_number = excluded.phone_number,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (normalized_name, display_name, normalized_number),
            )
        return Contact(normalized_name, normalized_number, display_name)

    def get_contact(self, name: str) -> Contact | None:
        normalized_name = normalize_contact_name(name)
        with self._connect() as conn:
            row = conn.execute(
                "SELECT name, display_name, phone_number FROM contacts WHERE name = ?",
                (normalized_name,),
            ).fetchone()
        if not row:
            return None
        return Contact(row["name"], row["phone_number"], row["display_name"])

    def list_contacts(self) -> list[Contact]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT name, display_name, phone_number FROM contacts ORDER BY name"
            ).fetchall()
        return [Contact(row["name"], row["phone_number"], row["display_name"]) for row in rows]

    def contact_names_for_prompt(self, limit: int = 20) -> str:
        names = [contact.name for contact in self.list_contacts()[:limit]]
        return ", ".join(names) if names else "none"

    def log_interaction(self, role: str, content: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO conversation_log (role, content) VALUES (?, ?)",
                (role, content),
            )

    def log_action(self, action: str, parameters: dict, status: str, message: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO action_log (action, parameters_json, status, message)
                VALUES (?, ?, ?, ?)
                """,
                (action, json.dumps(parameters, sort_keys=True), status, message),
            )

    def bulk_save_contacts(self, contacts: Iterable[tuple[str, str]]) -> None:
        for name, phone_number in contacts:
            self.save_contact(name, phone_number)

