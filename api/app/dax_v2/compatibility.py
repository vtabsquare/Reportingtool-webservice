from __future__ import annotations

from copy import deepcopy

from ..dax_registry import canonical_function_name
from .ast_nodes import Binary, Call, Node, Unary, VarBlock


def lower_compatible(node: Node) -> tuple[Node, list[str]]:
    """Apply only equivalence-preserving compatibility rewrites.

    This is intentionally conservative. A familiar name is never translated to
    a vaguely similar database function. Unsupported behavior is reported by
    the binder instead of silently changing a business calculation.
    """
    root = deepcopy(node)
    rewrites: list[str] = []

    def visit(value: Node) -> Node:
        if isinstance(value, Call):
            value.arguments = [visit(argument) for argument in value.arguments]
            canonical = canonical_function_name(value.function)
            if canonical != value.function:
                rewrites.append(f"{value.function} was normalized to {canonical}.")
                value.function = canonical
            if value.function == "CONCATENATE" and len(value.arguments) == 2:
                rewrites.append("CONCATENATE was lowered to the equivalent DAX & operator.")
                return Binary(value.span, "&", value.arguments[0], value.arguments[1])
            if value.function == "HASONEVALUE" and len(value.arguments) == 1:
                rewrites.append("HASONEVALUE was lowered to COUNTROWS(VALUES(...)) = 1.")
                rows = Call(value.span, "COUNTROWS", [Call(value.span, "VALUES", value.arguments)])
                from .ast_nodes import Literal
                return Binary(value.span, "=", rows, Literal(value.span, 1, "integer"))
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

    return visit(root), rewrites
