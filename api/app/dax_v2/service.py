from __future__ import annotations

from dataclasses import asdict
from hashlib import sha256
from typing import Any

from .binder import bind
from .catalog import ensure_catalog
from .compatibility import lower_compatible
from .contracts import AnalysisResult, Diagnostic, Severity
from .lexer import LexError
from .parser import ParseError, parse_measure
from .renderer import render


ENGINE_VERSION = "6.1.7"
COMPATIBILITY_LEVEL = 100


def _ast_payload(value: Any) -> Any:
    if hasattr(value, "__dataclass_fields__"):
        result = {"node": type(value).__name__}
        for key in value.__dataclass_fields__:
            item = getattr(value, key)
            if key == "span":
                result[key] = asdict(item)
            else:
                result[key] = _ast_payload(item)
        return result
    if isinstance(value, list):
        return [_ast_payload(item) for item in value]
    return value


def ensure_semantic_catalog(model: dict[str, Any]) -> dict[str, Any]:
    return ensure_catalog(model)


def analyze_measure(source: str, model: dict[str, Any]) -> AnalysisResult:
    catalog = ensure_catalog(model)
    try:
        definition = parse_measure(source)
    except (LexError, ParseError) as exc:
        diagnostic = Diagnostic("DAX0001", str(exc), Severity.ERROR, getattr(exc, "span", None))
        return AnalysisResult(False, source=source, diagnostics=[diagnostic], engine_version=ENGINE_VERSION)

    lowered, rewrites = lower_compatible(definition.expression)
    definition.expression = lowered
    result_type, result_kind, state = bind(lowered, model, catalog, definition.name)
    canonical = render(definition)
    dependencies = {
        "tables": list(state.tables.values()),
        "columns": list(state.columns.values()),
        "measures": list(state.measures.values()),
    }
    valid = not any(item.severity == Severity.ERROR for item in state.diagnostics)
    return AnalysisResult(
        valid=valid,
        name=definition.name,
        source=source,
        canonical_source=canonical,
        ast=_ast_payload(definition),
        dependencies=dependencies,
        diagnostics=state.diagnostics,
        rewrites=rewrites,
        result_type=result_type,
        result_kind=result_kind,
        compatibility_level=COMPATIBILITY_LEVEL,
        engine_version=ENGINE_VERSION,
    )


def artifact(result: AnalysisResult, model_version: int | str | None = None) -> dict[str, Any]:
    payload = result.payload()
    payload.update({
        "formulaHash": sha256(result.canonical_source.encode("utf-8")).hexdigest(),
        "modelVersion": model_version,
        "status": "validated" if result.valid else "invalid",
    })
    return payload


def engine_health() -> dict[str, Any]:
    smoke_model = {"tables": {"Sales": {"physical": "sales", "columns": {"Amount": "Amount"}}}, "columnTypes": {"Sales.Amount": "decimal"}, "measures": {}}
    checks = [
        analyze_measure("Total Sales = SUM(Sales[Amount])", smoke_model),
        analyze_measure("Label = CONCATENATE(\"Sales: \", FORMAT(SUM(Sales[Amount]), \"#,##0\"))", smoke_model),
    ]
    failures = [item.payload() for item in checks if not item.valid]
    return {"healthy": not failures, "engineVersion": ENGINE_VERSION, "compatibilityLevel": COMPATIBILITY_LEVEL, "checks": len(checks), "failures": failures}
