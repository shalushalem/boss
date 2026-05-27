from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
import json
import re
import sqlite3
from typing import Any, Iterable


PHONE_RE = re.compile(r"^\+\d{8,15}$")


@dataclass(frozen=True)
class Contact:
    name: str
    phone_number: str
    display_name: str


@dataclass(frozen=True)
class Message:
    id: int
    role: str
    content: str
    meta: dict[str, Any]
    created_at: str


@dataclass(frozen=True)
class Skill:
    name: str
    category: str
    description: str
    source_repo: str
    source_path: str
    skill_md_path: str
    imported_at: str
    active: bool = False
    activated_at: str | None = None


@dataclass(frozen=True)
class Task:
    id: int
    goal: str
    skill_name: str | None
    status: str
    summary: str | None
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class TaskRun:
    id: int
    task_id: int
    phase: str
    status: str
    payload: dict[str, Any]
    created_at: str


@dataclass(frozen=True)
class AuditEvent:
    id: int
    event_type: str
    actor: str
    action: str
    target: str
    status: str
    details: dict[str, Any]
    created_at: str


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


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


def json_dumps(value: Any) -> str:
    return json.dumps(value, sort_keys=True, default=str)


def safe_json(value: str | None, fallback: Any = None) -> Any:
    if value is None:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


class JarvisMemory:
    """SQLite-backed memory for contacts, messages, tasks, skills, and audits."""

    def __init__(self, db_path: Path, legacy_memory_path: Path | None = None, max_messages: int = 500):
        self.db_path = Path(db_path)
        self.legacy_memory_path = Path(legacy_memory_path) if legacy_memory_path else None
        self.max_messages = max_messages
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._setup()
        if self.legacy_memory_path:
            self.import_legacy_contacts(self.legacy_memory_path)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
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

                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    meta_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS profile (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS skills (
                    name TEXT PRIMARY KEY,
                    category TEXT NOT NULL,
                    description TEXT NOT NULL,
                    source_repo TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    skill_md_path TEXT NOT NULL,
                    imported_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS active_skills (
                    name TEXT PRIMARY KEY,
                    activated_at TEXT NOT NULL,
                    FOREIGN KEY(name) REFERENCES skills(name) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    goal TEXT NOT NULL,
                    skill_name TEXT,
                    status TEXT NOT NULL,
                    summary TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS task_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id INTEGER NOT NULL,
                    phase TEXT NOT NULL,
                    status TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS audit_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    action TEXT NOT NULL,
                    target TEXT NOT NULL,
                    status TEXT NOT NULL,
                    details_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
                CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
                CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id);
                CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON audit_logs(event_type);
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
        return self._map_contact(row) if row else None

    def list_contacts(self) -> list[Contact]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT name, display_name, phone_number FROM contacts ORDER BY name"
            ).fetchall()
        return [self._map_contact(row) for row in rows]

    def contact_names_for_prompt(self, limit: int = 20) -> str:
        names = [contact.name for contact in self.list_contacts()[:limit]]
        return ", ".join(names) if names else "none"

    def bulk_save_contacts(self, contacts: Iterable[tuple[str, str]]) -> None:
        for name, phone_number in contacts:
            self.save_contact(name, phone_number)

    def log_interaction(self, role: str, content: str, meta: dict[str, Any] | None = None) -> Message:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO conversation_log (role, content) VALUES (?, ?)",
                (role, content),
            )
        return self.add_message(role, content, meta or {"source": "conversation_log"})

    def log_action(self, action: str, parameters: dict, status: str, message: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO action_log (action, parameters_json, status, message)
                VALUES (?, ?, ?, ?)
                """,
                (action, json_dumps(parameters), status, message),
            )
        self.add_audit_event(
            event_type="tool",
            actor="jarvis",
            action=action,
            target=action,
            status=status,
            details={"parameters": parameters, "message": message},
        )

    def add_message(self, role: str, content: str, meta: dict[str, Any] | None = None) -> Message:
        created_at = utc_now()
        with self._connect() as conn:
            cursor = conn.execute(
                "INSERT INTO messages(role, content, meta_json, created_at) VALUES (?, ?, ?, ?)",
                (role, content, json_dumps(meta or {}), created_at),
            )
            message_id = int(cursor.lastrowid)
            self._trim_messages(conn)
        return Message(message_id, role, content, meta or {}, created_at)

    def _trim_messages(self, conn: sqlite3.Connection) -> None:
        row = conn.execute("SELECT COUNT(*) AS count FROM messages").fetchone()
        over_by = int(row["count"]) - self.max_messages
        if over_by > 0:
            conn.execute(
                "DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY id ASC LIMIT ?)",
                (over_by,),
            )

    def get_recent_messages(self, limit: int = 20) -> list[Message]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, role, content, meta_json, created_at FROM messages ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [self._map_message(row) for row in reversed(rows)]

    def set_profile_value(self, key: str, value: Any) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO profile(key, value_json) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
                """,
                (key, json_dumps(value)),
            )

    def get_profile(self) -> dict[str, Any]:
        with self._connect() as conn:
            rows = conn.execute("SELECT key, value_json FROM profile ORDER BY key").fetchall()
        return {row["key"]: safe_json(row["value_json"], {}) for row in rows}

    def upsert_skill(
        self,
        *,
        name: str,
        category: str = "general",
        description: str = "",
        source_repo: str = "local",
        source_path: str = "",
        skill_md_path: str = "",
    ) -> Skill:
        imported_at = utc_now()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO skills(name, category, description, source_repo, source_path, skill_md_path, imported_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    category = excluded.category,
                    description = excluded.description,
                    source_repo = excluded.source_repo,
                    source_path = excluded.source_path,
                    skill_md_path = excluded.skill_md_path,
                    imported_at = excluded.imported_at
                """,
                (name, category, description or "No description", source_repo, source_path, skill_md_path, imported_at),
            )
        return self.get_skill(name) or Skill(name, category, description, source_repo, source_path, skill_md_path, imported_at)

    def get_skill(self, name: str) -> Skill | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT s.name, s.category, s.description, s.source_repo, s.source_path, s.skill_md_path,
                       s.imported_at, a.activated_at,
                       CASE WHEN a.name IS NULL THEN 0 ELSE 1 END AS active
                FROM skills s
                LEFT JOIN active_skills a ON a.name = s.name
                WHERE s.name = ?
                """,
                (name,),
            ).fetchone()
        return self._map_skill(row) if row else None

    def list_skills(self, category: str | None = None, q: str | None = None, limit: int = 100, offset: int = 0) -> list[Skill]:
        filters = []
        params: list[Any] = []
        if category:
            filters.append("s.category = ?")
            params.append(category)
        if q:
            filters.append("(s.name LIKE ? OR s.description LIKE ?)")
            params.extend([f"%{q}%", f"%{q}%"])
        where = f"WHERE {' AND '.join(filters)}" if filters else ""
        params.extend([limit, offset])
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT s.name, s.category, s.description, s.source_repo, s.source_path, s.skill_md_path,
                       s.imported_at, a.activated_at,
                       CASE WHEN a.name IS NULL THEN 0 ELSE 1 END AS active
                FROM skills s
                LEFT JOIN active_skills a ON a.name = s.name
                {where}
                ORDER BY s.category ASC, s.name ASC
                LIMIT ? OFFSET ?
                """,
                params,
            ).fetchall()
        return [self._map_skill(row) for row in rows]

    def activate_skill(self, name: str) -> Skill:
        if not self.get_skill(name):
            raise ValueError(f"Skill not found: {name}")
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO active_skills(name, activated_at) VALUES (?, ?)
                ON CONFLICT(name) DO UPDATE SET activated_at = excluded.activated_at
                """,
                (name, utc_now()),
            )
        skill = self.get_skill(name)
        if skill is None:
            raise ValueError(f"Skill not found after activation: {name}")
        return skill

    def deactivate_skill(self, name: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM active_skills WHERE name = ?", (name,))

    def get_active_skills(self) -> list[Skill]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT s.name, s.category, s.description, s.source_repo, s.source_path, s.skill_md_path,
                       s.imported_at, a.activated_at, 1 AS active
                FROM active_skills a
                JOIN skills s ON s.name = a.name
                ORDER BY a.activated_at DESC
                """
            ).fetchall()
        return [self._map_skill(row) for row in rows]

    def create_task(
        self,
        *,
        goal: str,
        skill_name: str | None = None,
        status: str = "planned",
        summary: str | None = None,
    ) -> Task:
        now = utc_now()
        with self._connect() as conn:
            cursor = conn.execute(
                "INSERT INTO tasks(goal, skill_name, status, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (goal, skill_name, status, summary, now, now),
            )
            task_id = int(cursor.lastrowid)
        task = self.get_task(task_id)
        if task is None:
            raise RuntimeError(f"Task creation failed for goal: {goal}")
        return task

    def update_task(self, task_id: int, *, status: str | None = None, summary: str | None = None) -> Task:
        existing = self.get_task(task_id)
        if not existing:
            raise ValueError(f"Task not found: {task_id}")
        with self._connect() as conn:
            conn.execute(
                "UPDATE tasks SET status = ?, summary = ?, updated_at = ? WHERE id = ?",
                (status or existing.status, summary if summary is not None else existing.summary, utc_now(), task_id),
            )
        updated = self.get_task(task_id)
        if updated is None:
            raise RuntimeError(f"Task update failed: {task_id}")
        return updated

    def get_task(self, task_id: int) -> Task | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id, goal, skill_name, status, summary, created_at, updated_at FROM tasks WHERE id = ?",
                (task_id,),
            ).fetchone()
        return self._map_task(row) if row else None

    def list_tasks(self, status: str | None = None, limit: int = 50, offset: int = 0) -> list[Task]:
        if status:
            sql = """
                SELECT id, goal, skill_name, status, summary, created_at, updated_at
                FROM tasks WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?
            """
            params = (status, limit, offset)
        else:
            sql = """
                SELECT id, goal, skill_name, status, summary, created_at, updated_at
                FROM tasks ORDER BY id DESC LIMIT ? OFFSET ?
            """
            params = (limit, offset)
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._map_task(row) for row in rows]

    def add_task_run(
        self,
        task_id: int,
        *,
        phase: str = "step",
        status: str = "ok",
        payload: dict[str, Any] | None = None,
    ) -> TaskRun:
        created_at = utc_now()
        with self._connect() as conn:
            cursor = conn.execute(
                "INSERT INTO task_runs(task_id, phase, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
                (task_id, phase, status, json_dumps(payload or {}), created_at),
            )
            run_id = int(cursor.lastrowid)
        return TaskRun(run_id, task_id, phase, status, payload or {}, created_at)

    def get_task_runs(self, task_id: int) -> list[TaskRun]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, task_id, phase, status, payload_json, created_at FROM task_runs WHERE task_id = ? ORDER BY id ASC",
                (task_id,),
            ).fetchall()
        return [self._map_task_run(row) for row in rows]

    def add_audit_event(
        self,
        *,
        event_type: str = "system",
        actor: str = "jarvis-core",
        action: str = "unknown",
        target: str = "-",
        status: str = "info",
        details: dict[str, Any] | None = None,
    ) -> AuditEvent:
        created_at = utc_now()
        with self._connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO audit_logs(event_type, actor, action, target, status, details_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (event_type, actor, action, target, status, json_dumps(details or {}), created_at),
            )
            audit_id = int(cursor.lastrowid)
        return AuditEvent(audit_id, event_type, actor, action, target, status, details or {}, created_at)

    def list_audit_logs(self, event_type: str | None = None, limit: int = 200, offset: int = 0) -> list[AuditEvent]:
        if event_type:
            sql = """
                SELECT id, event_type, actor, action, target, status, details_json, created_at
                FROM audit_logs WHERE event_type = ? ORDER BY id DESC LIMIT ? OFFSET ?
            """
            params = (event_type, limit, offset)
        else:
            sql = """
                SELECT id, event_type, actor, action, target, status, details_json, created_at
                FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?
            """
            params = (limit, offset)
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._map_audit(row) for row in rows]

    def get_counters(self) -> dict[str, int]:
        tables = ["messages", "contacts", "skills", "active_skills", "tasks", "task_runs", "audit_logs"]
        with self._connect() as conn:
            return {
                table: int(conn.execute(f"SELECT COUNT(*) AS count FROM {table}").fetchone()["count"])
                for table in tables
            }

    def get_state(self) -> dict[str, Any]:
        return {
            "messages": [message.__dict__ for message in self.get_recent_messages(50)],
            "profile": self.get_profile(),
            "contacts": [contact.__dict__ for contact in self.list_contacts()],
            "activeSkills": [skill.__dict__ for skill in self.get_active_skills()],
            "counters": self.get_counters(),
            "persistence": {"type": "sqlite", "path": str(self.db_path)},
        }

    def _map_contact(self, row: sqlite3.Row) -> Contact:
        return Contact(row["name"], row["phone_number"], row["display_name"])

    def _map_message(self, row: sqlite3.Row) -> Message:
        return Message(row["id"], row["role"], row["content"], safe_json(row["meta_json"], {}) or {}, row["created_at"])

    def _map_skill(self, row: sqlite3.Row) -> Skill:
        return Skill(
            name=row["name"],
            category=row["category"],
            description=row["description"],
            source_repo=row["source_repo"],
            source_path=row["source_path"],
            skill_md_path=row["skill_md_path"],
            imported_at=row["imported_at"],
            active=bool(row["active"]),
            activated_at=row["activated_at"],
        )

    def _map_task(self, row: sqlite3.Row) -> Task:
        return Task(
            id=row["id"],
            goal=row["goal"],
            skill_name=row["skill_name"],
            status=row["status"],
            summary=row["summary"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def _map_task_run(self, row: sqlite3.Row) -> TaskRun:
        return TaskRun(
            id=row["id"],
            task_id=row["task_id"],
            phase=row["phase"],
            status=row["status"],
            payload=safe_json(row["payload_json"], {}) or {},
            created_at=row["created_at"],
        )

    def _map_audit(self, row: sqlite3.Row) -> AuditEvent:
        return AuditEvent(
            id=row["id"],
            event_type=row["event_type"],
            actor=row["actor"],
            action=row["action"],
            target=row["target"],
            status=row["status"],
            details=safe_json(row["details_json"], {}) or {},
            created_at=row["created_at"],
        )
