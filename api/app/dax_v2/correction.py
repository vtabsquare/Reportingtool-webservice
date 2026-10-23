from __future__ import annotations

"""Conservative, reviewable correction of malformed or mistyped DAX.

Correction is intentionally distinct from compatibility reconstruction:
correction repairs authoring mistakes while preserving the requested DAX;
reconstruction replaces valid-but-unsupported DAX with executable VTAB DAX.
Every correction is disclosed and the server must re-run the complete semantic,
compiler and visual preflight before the proposal can be used.
"""

from copy import deepcopy
from dataclasses import dataclass, field
import re
from typing import Any

from ..dax_registry import DAX_FUNCTION_REGISTRY
from .ast_nodes import Binary, Call, ColumnRef, Literal, MeasureDefinition, MeasureRef, Name, Node, Unary, VarBlock
from .lexer import LexError, tokenize
from .parser import ParseError, parse_measure
from .renderer import render


@dataclass
class Correction:
    available: bool = False
    expression: str = ""
    summary: str = ""
    changes: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    confidence: str = "none"

    def payload(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "expression": self.expression,
            "summary": self.summary,
            "changes": self.changes,
            "warnings": self.warnings,
            "confidence": self.confidence,
        }


def _distance(left: str, right: str) -> int:
    """Small dependency-free Levenshtein distance."""
    if left == right:
        return 0
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for row, a in enumerate(left, 1):
        current = [row]
        for column, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[column] + 1, previous[column - 1] + (a != b)))
        previous = current
    return previous[-1]


def _normalized(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def _unique_close_match(requested: str, options: list[str]) -> str | None:
    """Return only an unambiguous typo match; never choose by loose similarity."""
    wanted = _normalized(requested)
    if not wanted:
        return None
    exact = [option for option in options if _normalized(option) == wanted]
    if len(exact) == 1:
        return exact[0]
    scored = sorted((_distance(wanted, _normalized(option)), option) for option in options)
    if not scored:
        return None
    best_distance, best = scored[0]
    threshold = 1 if len(wanted) < 6 else 2
    if best_distance == 0 or best_distance > threshold:
        return None
    if len(scored) > 1 and scored[1][0] == best_distance:
        return None
    return best


def _normalize_pasted_characters(source: str) -> tuple[str, list[str]]:
    replacements = {
        "\u201c": '"', "\u201d": '"', "\u201e": '"',
        "\u2018": "'", "\u2019": "'", "\u201a": "'",
        "\u00a0": " ", "\u2007": " ", "\u202f": " ",
        "\u2212": "-",
    }
    updated = "".join(replacements.get(character, character) for character in source)
    return updated, (["Normalized pasted smart punctuation and spaces to DAX characters."] if updated != source else [])


def _close_unterminated_token(source: str, error: Exception) -> tuple[str, str | None]:
    message = str(error)
    if "Unclosed string literal" in message:
        return source.rstrip() + '"', "Closed the unterminated text string at the end of the formula."
    if "Unclosed quoted table name" in message:
        return source.rstrip() + "'", "Closed the unterminated quoted table name at the end of the formula."
    if "Unclosed [field] reference" in message:
        return source.rstrip() + "]", "Closed the unterminated field reference at the end of the formula."
    if "Unclosed block comment" in message:
        return source.rstrip() + "*/", "Closed the unterminated block comment at the end of the formula."
    return source, None


def _balance_trailing_parentheses(source: str) -> tuple[str, list[str]]:
    tokens = tokenize(source)
    balance = 0
    first_surplus = -1
    for token in tokens:
        if token.kind == "LPAREN":
            balance += 1
        elif token.kind == "RPAREN":
            balance -= 1
            if balance < 0 and first_surplus < 0:
                first_surplus = token.span.start
    trimmed = source.rstrip()
    if balance > 0 and trimmed and trimmed[-1] not in ",=+-*/^&<>":
        label = "parenthesis" if balance == 1 else "parentheses"
        return trimmed + ("\n" if "\n" in source else "") + (" )" * balance), [f"Added {balance} missing closing {label}."]
    if balance < 0 and first_surplus >= 0:
        # Removing is safe only when every surplus token is at the very end.
        tail = trimmed[first_surplus:]
        if tail and all(character in ") \t\r\n" for character in tail):
            remove = -balance
            repaired = trimmed
            for _ in range(remove):
                index = repaired.rfind(")")
                repaired = repaired[:index] + repaired[index + 1:]
            label = "parenthesis" if remove == 1 else "parentheses"
            return repaired.rstrip(), [f"Removed {remove} extra trailing closing {label}."]
    return source, []


def _remove_separators_before_closing_parentheses(source: str) -> tuple[str, list[str]]:
    tokens = tokenize(source)
    removals = [token.span.start for index, token in enumerate(tokens[:-1]) if token.kind == "COMMA" and tokens[index + 1].kind == "RPAREN"]
    if not removals:
        return source, []
    updated = source
    for index in reversed(removals):
        updated = updated[:index] + updated[index + 1:]
    count = len(removals)
    label = "separator" if count == 1 else "separators"
    return updated, [f"Removed {count} accidental trailing {label} before a closing parenthesis."]


def _repair_structure(source: str) -> tuple[str, list[str]]:
    candidate, changes = _normalize_pasted_characters(source)
    try:
        tokenize(candidate)
    except LexError as error:
        candidate, change = _close_unterminated_token(candidate, error)
        if not change:
            return source, []
        changes.append(change)
        try:
            tokenize(candidate)
        except LexError:
            return source, []
    candidate, separator_changes = _remove_separators_before_closing_parentheses(candidate)
    candidate, parenthesis_changes = _balance_trailing_parentheses(candidate)
    return candidate, changes + separator_changes + parenthesis_changes


def correct_measure(source: str, model: dict[str, Any] | None = None) -> Correction:
    """Create a correction only when every edit has a unique, safe target."""
    candidate, changes = _repair_structure(source)
    try:
        definition = parse_measure(candidate)
    except (LexError, ParseError) as error:
        return Correction(summary=f"No unambiguous automatic correction is available: {error}")

    root: MeasureDefinition = deepcopy(definition)
    tables = (model or {}).get("tables", {})
    measures = (model or {}).get("measures", {})
    variable_scopes: list[set[str]] = []

    def visit(node: Node) -> Node:
        if isinstance(node, Call):
            if node.function.upper() not in DAX_FUNCTION_REGISTRY:
                match = _unique_close_match(node.function, list(DAX_FUNCTION_REGISTRY))
                if match:
                    changes.append(f"Corrected function {node.function} to {match}.")
                    node.function = match
            node.arguments = [visit(argument) for argument in node.arguments]
            spec = DAX_FUNCTION_REGISTRY.get(node.function.upper())
            if spec and node.arguments and isinstance(node.arguments[-1], Literal) and node.arguments[-1].value_type == "blank":
                if spec.max_args is not None and len(node.arguments) > spec.max_args and len(node.arguments) - 1 >= spec.min_args:
                    node.arguments.pop()
                    changes.append(f"Removed the accidental trailing separator from {node.function}.")
            return node
        if isinstance(node, ColumnRef):
            table_match = next((name for name in tables if name.casefold() == node.table.casefold()), None)
            if table_match is None:
                table_match = _unique_close_match(node.table, list(tables))
                if table_match:
                    changes.append(f"Corrected table '{node.table}' to '{table_match}'.")
                    node.table = table_match
            if table_match:
                columns = list((tables.get(table_match) or {}).get("columns", {}))
                column_match = next((name for name in columns if name.casefold() == node.column.casefold()), None)
                if column_match is None:
                    column_match = _unique_close_match(node.column, columns)
                    if column_match:
                        changes.append(f"Corrected column [{node.column}] to [{column_match}] in '{table_match}'.")
                        node.column = column_match
            return node
        if isinstance(node, MeasureRef):
            if not any(node.measure.casefold() in scope for scope in variable_scopes):
                exact = next((name for name in measures if name.casefold() == node.measure.casefold()), None)
                if exact is None:
                    match = _unique_close_match(node.measure, list(measures))
                    if match:
                        changes.append(f"Corrected measure [{node.measure}] to [{match}].")
                        node.measure = match
            return node
        if isinstance(node, Name):
            if not any(node.value.casefold() in scope for scope in variable_scopes):
                exact = next((name for name in tables if name.casefold() == node.value.casefold()), None)
                if exact is None:
                    match = _unique_close_match(node.value, list(tables))
                    if match:
                        changes.append(f"Corrected table {node.value} to {match}.")
                        node.value = match
            return node
        if isinstance(node, Binary):
            node.left = visit(node.left); node.right = visit(node.right)
        elif isinstance(node, Unary):
            node.operand = visit(node.operand)
        elif isinstance(node, VarBlock):
            scope = {variable.name.casefold() for variable in node.variables}
            variable_scopes.append(scope)
            for variable in node.variables:
                variable.expression = visit(variable.expression)
            node.result = visit(node.result)
            variable_scopes.pop()
        return node

    root.expression = visit(root.expression)
    if not changes:
        return Correction(summary="The formula parsed, but no high-confidence authoring mistake was found to correct.")
    expression = render(root)
    try:
        parse_measure(expression)
    except (LexError, ParseError):
        return Correction(summary="A possible correction was found but did not pass the parser, so it was not offered.")
    return Correction(
        available=True,
        expression=expression,
        summary="A high-confidence corrected formula is available. It must pass full validation before use.",
        changes=list(dict.fromkeys(changes)),
        confidence="high",
    )


