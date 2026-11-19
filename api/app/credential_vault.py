from __future__ import annotations

import base64
import hashlib
import json
import os
from typing import Any


class CredentialConfigurationError(RuntimeError):
    pass


def _fernet():
    keys: list[str] = []
    primary = os.environ.get("VTAB_CREDENTIAL_ENCRYPTION_KEY", "").strip()
    if primary and not primary.startswith("REPLACE_WITH_"):
        if len(primary) < 32:
            raise CredentialConfigurationError("VTAB_CREDENTIAL_ENCRYPTION_KEY must contain at least 32 characters.")
        keys.append(primary)

    # Server-only fallback: SUPABASE_SERVICE_ROLE_KEY is always present on the production backend
    fallback = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if fallback and not fallback.startswith("YOUR_") and len(fallback) >= 32 and fallback not in keys:
        keys.append(fallback)

    if not keys:
        raise CredentialConfigurationError(
            "VTAB_CREDENTIAL_ENCRYPTION_KEY is not configured on the Services API. "
            "Add a private random value of at least 32 characters before saving refresh credentials."
        )

    try:
        from cryptography.fernet import Fernet, MultiFernet
    except ImportError as error:
        raise CredentialConfigurationError("The cryptography package is required for scheduled refresh.") from error

    fernets = [
        Fernet(base64.urlsafe_b64encode(hashlib.sha256(k.encode("utf-8")).digest()))
        for k in keys
    ]
    return MultiFernet(fernets) if len(fernets) > 1 else fernets[0]


def encrypt_credentials(credentials: dict[str, Any]) -> str:
    payload = json.dumps(credentials or {}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return "v1:" + _fernet().encrypt(payload).decode("ascii")


def decrypt_credentials(value: str | None) -> dict[str, Any]:
    if not value or not str(value).startswith("v1:"):
        raise CredentialConfigurationError(
            "This schedule uses legacy unencrypted credentials. Edit the schedule and save the credentials again."
        )
    try:
        decoded = _fernet().decrypt(str(value)[3:].encode("ascii"))
        result = json.loads(decoded.decode("utf-8"))
    except CredentialConfigurationError:
        raise
    except Exception as error:
        raise CredentialConfigurationError("The refresh credentials could not be decrypted.") from error
    if not isinstance(result, dict):
        raise CredentialConfigurationError("The decrypted refresh credentials are invalid.")
    return result
