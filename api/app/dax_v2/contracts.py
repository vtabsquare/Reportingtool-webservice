from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class Severity(str, Enum):
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"


@dataclass(frozen=True)
class SourceSpan:
    start: int
    end: int
    line: int
    column: int


@dataclass(frozen=True)
class Diagnostic:
    code: str
    message: str
    severity: Severity = Severity.ERROR
    span: SourceSpan | None = None
    suggestion: str | None = None

    def payload(self) -> dict[str, Any]:
        value = asdict(self)
        value["severity"] = self.severity.value
        return value


@dataclass
class AnalysisResult:
    valid: bool
    name: str = ""
    source: str = ""
    canonical_source: str = ""
    ast: dict[str, Any] | None = None
    dependencies: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    diagnostics: list[Diagnostic] = field(default_factory=list)
    rewrites: list[str] = field(default_factory=list)
    result_type: str = "unknown"
    result_kind: str = "scalar"
    compatibility_level: int = 100
    engine_version: str = "6.1.4"

    def payload(self) -> dict[str, Any]:
        return {
            "valid": self.valid,
            "name": self.name,
            "source": self.source,
            "canonicalSource": self.canonical_source,
            "ast": self.ast,
            "dependencies": self.dependencies,
            "diagnostics": [item.payload() for item in self.diagnostics],
            "rewrites": self.rewrites,
            "resultType": self.result_type,
            "resultKind": self.result_kind,
            "compatibilityLevel": self.compatibility_level,
            "engineVersion": self.engine_version,
        }
