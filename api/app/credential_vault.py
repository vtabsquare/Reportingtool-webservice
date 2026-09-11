from __future__ import annotations

import base64
import hashlib
import json
import os
from typing import Any


class CredentialConfigurationError(RuntimeError):
    pass


def _fernet():
    secret = os.environ.get("VTAB_CREDENTIAL_ENCRYPTION_KEY", "").strip()
    if not secret or secret.startswith("REPLACE_WITH_"):
        raise CredentialConfigurationError(
            "VTAB_CREDENTIAL_ENCRYPTION_KEY is not configured on the Services API. "
            "Add a private random value of at least 32 characters before saving refresh credentials."
        )
    if len(secret) < 32:
        raise CredentialConfigurationError("VTAB_CREDENTIAL_ENCRYPTION_KEY must contain at least 32 characters.")
    try:
        from cryptography.fernet import Fernet
    except ImportError as error:
        raise CredentialConfigurationError("The cryptography package is required for scheduled refresh.") from error
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode("utf-8")).digest())
    return Fernet(key)


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
