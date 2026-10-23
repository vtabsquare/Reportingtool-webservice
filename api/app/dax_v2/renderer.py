from __future__ import annotations

from .ast_nodes import Binary, Call, ColumnRef, Literal, MeasureDefinition, MeasureRef, Name, Node, QuotedName, TableRef, Unary, VarBlock


_PREC = {"||": 1, "OR": 1, "&&": 2, "AND": 2, "=": 3, "==": 3, "<>": 3, "<": 3, ">": 3, "<=": 3, ">=": 3, "&": 4, "+": 5, "-": 5, "*": 6, "/": 6, "^": 7}


def quote_table(value: str) -> str:
    if value.replace("_", "").isalnum() and " " not in value:
        return value
    return "'" + value.replace("'", "''") + "'"


def render(node: Node, parent_precedence: int = 0) -> str:
    if isinstance(node, MeasureDefinition):
        return f"{node.name} =\n{render(node.expression)}"
    if isinstance(node, Literal):
        if node.value_type == "text":
            return '"' + str(node.value).replace('"', '""') + '"'
        if node.value_type == "boolean":
            return "TRUE ()" if node.value else "FALSE ()"
        if node.value_type == "blank":
            return "BLANK ()"
        return str(node.value)
    if isinstance(node, ColumnRef):
        return f"{quote_table(node.table)}[{node.column.replace(']', ']]')}]"
    if isinstance(node, MeasureRef):
        return f"[{node.measure.replace(']', ']]')}]"
    if isinstance(node, TableRef):
        return quote_table(node.table)
    if isinstance(node, Name):
        return node.value
    if isinstance(node, QuotedName):
        return "'" + node.value.replace("'", "''") + "'"
    if isinstance(node, Unary):
        return f"{node.operator} {render(node.operand, 8)}"
    if isinstance(node, Binary):
        precedence = _PREC.get(node.operator, 0)
        text = f"{render(node.left, precedence)} {node.operator} {render(node.right, precedence + 1)}"
        return f"( {text} )" if precedence < parent_precedence else text
    if isinstance(node, Call):
        if not node.arguments:
            return f"{node.function} ()"
        args = ",\n".join("    " + render(argument).replace("\n", "\n    ") for argument in node.arguments)
        return f"{node.function} (\n{args}\n)"
    if isinstance(node, VarBlock):
        variables = "\n".join(f"VAR {item.name} =\n    {render(item.expression).replace(chr(10), chr(10) + '    ')}" for item in node.variables)
        return f"{variables}\nRETURN\n    {render(node.result).replace(chr(10), chr(10) + '    ')}"
    raise TypeError(f"No renderer for {type(node).__name__}")
