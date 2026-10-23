from __future__ import annotations

"""Deterministic recovery proposals for unsupported pasted DAX.

Reconstruction is deliberately separate from normal compatibility lowering.
Normal lowering may only make equivalence-preserving changes automatically.
This module is called after validation fails and returns a reviewable proposal;
context-dependent substitutions are never saved without the author's action.
"""

from copy import deepcopy
from dataclasses import dataclass, field

from ..dax_registry import DAX_FUNCTION_REGISTRY
from .ast_nodes import Binary, Call, ColumnRef, Literal, MeasureDefinition, Name, Node, QuotedName, Unary, VarBlock
from .parser import LexError, ParseError, parse_measure
from .renderer import render


@dataclass
class Reconstruction:
    available: bool = False
    expression: str = ""
    equivalence: str = "unavailable"
    summary: str = ""
    changes: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    unsupported_functions: list[str] = field(default_factory=list)

    def payload(self) -> dict:
        return {
            "available": self.available,
            "expression": self.expression,
            "equivalence": self.equivalence,
            "summary": self.summary,
            "changes": self.changes,
            "warnings": self.warnings,
            "unsupportedFunctions": self.unsupported_functions,
        }


def _table_node(column: ColumnRef) -> Node:
    if column.table.replace("_", "").isalnum() and " " not in column.table:
        return Name(column.span, column.table)
    return QuotedName(column.span, column.table)


def reconstruct_measure(source: str) -> Reconstruction:
    """Return a supported, reviewable DAX proposal when one can be proven useful.

    ``exact`` proposals preserve the represented calculation. ``contextual``
    proposals are valid VTAB formulas but document a Power BI context feature
    that VTAB cannot reproduce yet (for example ALLSELECTED shadow context).
    """
    try:
        definition = parse_measure(source)
    except (LexError, ParseError) as exc:
        return Reconstruction(summary=f"The formula must parse before it can be reconstructed: {exc}")

    root: MeasureDefinition = deepcopy(definition)
    changes: list[str] = []
    warnings: list[str] = []
    unresolved: set[str] = set()
    contextual = False

    def visit(value: Node, parent_function: str = "", argument_index: int = -1) -> Node:
        nonlocal contextual
        if isinstance(value, Call):
            value.arguments = [visit(item, value.function.upper(), index) for index, item in enumerate(value.arguments)]
            function = value.function.upper()
            spec = DAX_FUNCTION_REGISTRY.get(function)
            if not spec:
                unresolved.add(function)
                return value
            if spec.status != "unsupported":
                return value

            if function == "ALLSELECTED" and value.arguments:
                # In a CALCULATE filter argument REMOVEFILTERS communicates the
                # supported intent more clearly than an ALL table expression.
                replacement = "REMOVEFILTERS" if parent_function in {"CALCULATE", "CALCULATETABLE"} and argument_index > 0 else "ALL"
                contextual = True
                changes.append(f"ALLSELECTED was reconstructed as {replacement}.")
                warnings.append(
                    "Power BI ALLSELECTED preserves external slicer filters through a shadow filter context. "
                    "VTAB does not yet expose that shadow context, so this compatible version removes the target filter and may differ when an external slicer filters the same field."
                )
                return Call(value.span, replacement, value.arguments)

            if function == "DISTINCT" and len(value.arguments) == 1:
                contextual = True
                changes.append("DISTINCT was reconstructed as VALUES.")
                warnings.append("VALUES can include the model's unknown/blank member; review results if relationship integrity creates a blank member.")
                return Call(value.span, "VALUES", value.arguments)

            if function in {"COUNTA", "COUNTBLANK"} and len(value.arguments) == 1 and isinstance(value.arguments[0], ColumnRef):
                column = value.arguments[0]
                blank_test = Call(value.span, "ISBLANK", [deepcopy(column)])
                predicate: Node = blank_test if function == "COUNTBLANK" else Unary(value.span, "NOT", blank_test)
                filtered = Call(value.span, "FILTER", [_table_node(column), predicate])
                changes.append(f"{function} was reconstructed with COUNTROWS and FILTER.")
                return Call(value.span, "COUNTROWS", [filtered])

            if function == "SIGN" and len(value.arguments) == 1:
                item = value.arguments[0]
                changes.append("SIGN was reconstructed with SWITCH and comparisons.")
                return Call(value.span, "SWITCH", [
                    Call(value.span, "TRUE", []),
                    Binary(value.span, ">", deepcopy(item), Literal(value.span, 0, "integer")), Literal(value.span, 1, "integer"),
                    Binary(value.span, "<", deepcopy(item), Literal(value.span, 0, "integer")), Literal(value.span, -1, "integer"),
                    Literal(value.span, 0, "integer"),
                ])

            if function in {"ROUNDUP", "ROUNDDOWN"} and len(value.arguments) == 2:
                number, digits = value.arguments
                # Emit a literal significance for the common constant-digits
                # form. It is easier to inspect and avoids needless nested work
                # in every visual query. Dynamic digits retain POWER.
                if isinstance(digits, Literal) and digits.value_type in {"integer", "decimal"}:
                    significance: Node = Literal(value.span, 10 ** (-float(digits.value)), "decimal")
                else:
                    significance = Call(value.span, "POWER", [Literal(value.span, 10, "integer"), Unary(value.span, "-", deepcopy(digits))])
                rounding = "CEILING" if function == "ROUNDUP" else "FLOOR"
                positive = Call(value.span, rounding, [deepcopy(number), deepcopy(significance)])
                negative = Unary(value.span, "-", Call(value.span, rounding, [Call(value.span, "ABS", [deepcopy(number)]), deepcopy(significance)]))
                changes.append(f"{function} was reconstructed with {rounding}, ABS, POWER and IF.")
                return Call(value.span, "IF", [
                    Binary(value.span, ">=", deepcopy(number), Literal(value.span, 0, "integer")),
                    positive,
                    negative,
                ])

            unresolved.add(function)
            return value
        if isinstance(value, Binary):
            value.left = visit(value.left)
            value.right = visit(value.right)
        elif isinstance(value, Unary):
            value.operand = visit(value.operand)
        elif isinstance(value, VarBlock):
            for variable in value.variables:
                variable.expression = visit(variable.expression)
            value.result = visit(value.result)
        return value

    root.expression = visit(root.expression)
    unsupported = sorted(unresolved)
    if not changes:
        names = ", ".join(unsupported) if unsupported else "the unsupported syntax"
        return Reconstruction(
            summary=f"No reliable reconstruction is registered for {names}. The original formula was left unchanged.",
            unsupported_functions=unsupported,
        )
    if unresolved:
        return Reconstruction(
            summary="Part of the formula can be reconstructed, but unsupported functions remain; no partial proposal was offered.",
            changes=changes,
            warnings=warnings,
            unsupported_functions=unsupported,
        )
    return Reconstruction(
        available=True,
        expression=render(root),
        equivalence="contextual" if contextual else "exact",
        summary=(
            "A compatible formula is available, with a documented filter-context difference. Review it before use."
            if contextual else
            "An equivalent formula was reconstructed using executable VTAB functions."
        ),
        changes=changes,
        warnings=list(dict.fromkeys(warnings)),
    )
