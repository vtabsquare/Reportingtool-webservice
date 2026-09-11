from __future__ import annotations

import json
import os
from pathlib import Path


def product_version() -> str:
    """Read the version owned by the website's root package manifest."""
    configured = os.environ.get("VTAB_PRODUCT_VERSION", "").strip()
    if configured:
        return configured

    package_json = Path(__file__).resolve().parents[2] / "package.json"
    try:
        value = json.loads(package_json.read_text(encoding="utf-8")).get("version")
        if value:
            return str(value)
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        pass

    # Standalone backend builds may not ship the root package manifest.
    return "5.2.1"


PRODUCT_VERSION = product_version()
