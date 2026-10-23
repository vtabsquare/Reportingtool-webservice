"""DuckDB execution adapter for semantic measure definitions.

The v2 engine owns language meaning.  This module is the only bridge from the
canonical semantic formula into the existing DuckDB compiler, which keeps the
storage backend replaceable and prevents visual code from bypassing analysis.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ..dax_engine import DaxCompilation, compile_dax


def compile_for_duckdb(
    canonical_expression: str,
    model: dict[str, Any],
    context_filters: list[dict[str, Any]],
    resolve_measure: Callable[[str], str],
) -> DaxCompilation:
    """Compile already-parsed canonical DAX for the local storage engine."""

    return compile_dax(canonical_expression, model, context_filters, resolve_measure)
