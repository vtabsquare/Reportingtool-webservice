from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import NAMESPACE_URL, uuid5


def _id(kind: str, model_id: str, *parts: str) -> str:
    return str(uuid5(NAMESPACE_URL, "vtab:" + ":".join((kind, model_id, *parts))))


def ensure_catalog(model: dict[str, Any]) -> dict[str, Any]:
    catalog = model.setdefault("semanticCatalog", {})
    model_id = str(catalog.setdefault("modelId", model.get("id") or _id("model", "local", "default")))
    catalog.setdefault("compatibilityLevel", 100)
    catalog.setdefault("version", 1)
    catalog.setdefault("createdAt", datetime.now(timezone.utc).isoformat())
    tables_meta = catalog.setdefault("tables", {})
    current_tables = model.get("tables", {}) or {}
    for table_name, table in current_tables.items():
        table_meta = tables_meta.setdefault(table_name, {"id": _id("table", model_id, table_name), "name": table_name, "columns": {}})
        # Older projects may contain a partial catalog written before stable
        # semantic IDs were introduced. Hydrate missing members in place so a
        # harmless table rename can upgrade those projects instead of failing.
        table_meta.setdefault("id", _id("table", model_id, table_name))
        table_meta["name"] = table_name
        column_meta = table_meta.setdefault("columns", {})
        for column_name, physical in (table.get("columns", {}) or {}).items():
            semantic = f"{table_name}.{column_name}"
            dtype = (model.get("columnTypes", {}) or {}).get(semantic) or (physical if isinstance(physical, str) else "unknown")
            entry = column_meta.setdefault(column_name, {"id": _id("column", model_id, table_meta["id"], column_name)})
            entry.setdefault("id", _id("column", model_id, table_meta["id"], column_name))
            entry.update({"name": column_name, "dataType": str(dtype or "unknown"), "physical": physical})
        for removed in set(column_meta) - set(table.get("columns", {})):
            column_meta[removed]["status"] = "removed"
    for removed in set(tables_meta) - set(current_tables):
        tables_meta[removed]["status"] = "removed"
    measures_meta = catalog.setdefault("measures", {})
    for measure_name in (model.get("measures", {}) or {}):
        measures_meta.setdefault(measure_name, {"id": _id("measure", model_id, measure_name), "name": measure_name, "resultType": "variant"})
    return catalog
