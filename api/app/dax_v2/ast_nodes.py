from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from .contracts import SourceSpan


@dataclass
class Node:
    span: SourceSpan

    def payload(self) -> dict[str, Any]:
        value = asdict(self)
        value["node"] = type(self).__name__
        return value


@dataclass
class Literal(Node):
    value: Any
    value_type: str


@dataclass
class Name(Node):
    value: str


@dataclass
class QuotedName(Node):
    value: str


@dataclass
class TableRef(Node):
    table: str


@dataclass
class ColumnRef(Node):
    table: str
    column: str


@dataclass
class MeasureRef(Node):
    measure: str


@dataclass
class Unary(Node):
    operator: str
    operand: Node


@dataclass
class Binary(Node):
    operator: str
    left: Node
    right: Node


@dataclass
class Call(Node):
    function: str
    arguments: list[Node] = field(default_factory=list)


@dataclass
class Variable(Node):
    name: str
    expression: Node


@dataclass
class VarBlock(Node):
    variables: list[Variable]
    result: Node


@dataclass
class MeasureDefinition(Node):
    name: str
    expression: Node
