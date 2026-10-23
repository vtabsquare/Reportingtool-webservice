"""VTAB semantic measure engine v2.

The package owns language parsing, semantic binding, compatibility lowering and
measure metadata.  Physical execution is supplied by a storage adapter; the
existing DuckDB adapter is used during the migration period.
"""

from .service import analyze_measure, ensure_semantic_catalog, engine_health
from .reconstruction import reconstruct_measure
from .correction import correct_measure

__all__ = ["analyze_measure", "correct_measure", "ensure_semantic_catalog", "engine_health", "reconstruct_measure"]
