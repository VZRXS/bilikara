from __future__ import annotations

import hashlib
import json
import secrets
import threading
import time
from pathlib import Path


class RemoteIdentityStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.lock = threading.RLock()
        self.session_id = ""
        self.identities: dict[str, dict[str, object]] = {}
        self._load_or_create()

    def snapshot_session_id(self) -> str:
        with self.lock:
            return self.session_id

    def issue(self, name: str) -> str:
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self.lock:
            self.identities[self._token_digest(token)] = {
                "name": str(name or "").strip(),
                "created_at": now,
                "updated_at": now,
            }
            self._save_unlocked()
        return token

    def resolve(self, token: str) -> str:
        digest = self._token_digest(token)
        if not digest:
            return ""
        with self.lock:
            identity = self.identities.get(digest)
            return str(identity.get("name") or "").strip() if isinstance(identity, dict) else ""

    def rename(self, token: str, name: str) -> bool:
        digest = self._token_digest(token)
        if not digest:
            return False
        with self.lock:
            identity = self.identities.get(digest)
            if not isinstance(identity, dict):
                return False
            identity["name"] = str(name or "").strip()
            identity["updated_at"] = time.time()
            self._save_unlocked()
            return True

    def revoke_name(self, name: str) -> int:
        normalized = str(name or "").strip()
        if not normalized:
            return 0
        with self.lock:
            digests = [
                digest
                for digest, identity in self.identities.items()
                if str(identity.get("name") or "").strip() == normalized
            ]
            for digest in digests:
                self.identities.pop(digest, None)
            if digests:
                self._save_unlocked()
            return len(digests)

    def revoke_token(self, token: str) -> bool:
        digest = self._token_digest(token)
        if not digest:
            return False
        with self.lock:
            removed = self.identities.pop(digest, None) is not None
            if removed:
                self._save_unlocked()
            return removed

    def rotate_session(self) -> str:
        with self.lock:
            self.session_id = secrets.token_urlsafe(18)
            self.identities = {}
            self._save_unlocked()
            return self.session_id

    @staticmethod
    def _token_digest(token: str) -> str:
        normalized = str(token or "").strip()
        if not normalized:
            return ""
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def _load_or_create(self) -> None:
        payload: dict[str, object] = {}
        if self.path.exists():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    payload = loaded
            except (OSError, json.JSONDecodeError):
                payload = {}
        session_id = str(payload.get("session_id") or "").strip()
        raw_identities = payload.get("identities")
        identities: dict[str, dict[str, object]] = {}
        if isinstance(raw_identities, dict):
            for digest, identity in raw_identities.items():
                if len(str(digest)) != 64 or not isinstance(identity, dict):
                    continue
                name = str(identity.get("name") or "").strip()
                if not name:
                    continue
                identities[str(digest)] = {
                    "name": name,
                    "created_at": self._safe_timestamp(identity.get("created_at")),
                    "updated_at": self._safe_timestamp(identity.get("updated_at")),
                }
        self.session_id = session_id or secrets.token_urlsafe(18)
        self.identities = identities
        self._save_unlocked()

    def _save_unlocked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "session_id": self.session_id,
            "identities": self.identities,
            "updated_at": time.time(),
        }
        temporary = self.path.with_name(f".{self.path.name}.tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.path)

    @staticmethod
    def _safe_timestamp(value: object) -> float:
        try:
            return float(value or 0.0)
        except (TypeError, ValueError):
            return 0.0
