from __future__ import annotations

from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any
import re

from ..dax_registry import DAX_FUNCTION_REGISTRY
from .ast_nodes import Binary, Call, ColumnRef, Literal, MeasureRef, Name, Node, QuotedName, Unary, VarBlock
from .contracts import Diagnostic, Severity


@dataclass
class BindState:
    model: dict[str, Any]
    catalog: dict[str, Any]
    current_measure: str
    diagnostics: list[Diagnostic] = field(default_factory=list)
    tables: dict[str, dict[str, Any]] = field(default_factory=dict)
    columns: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    measures: dict[str, dict[str, Any]] = field(default_factory=dict)
    variables: dict[str, tuple[str, str]] = field(default_factory=dict)
    virtual_columns: set[str] = field(default_factory=set)

    def error(self, code: str, message: str, node: Node, suggestion: str | None = None) -> None:
        self.diagnostics.append(Diagnostic(code, message, Severity.ERROR, node.span, suggestion))


def _lookup(mapping: dict[str, Any], name: str) -> tuple[str, Any] | None:
    wanted = name.casefold()
    return next(((key, value) for key, value in mapping.items() if key.casefold() == wanted), None)


def _lookup_measure(mapping: dict[str, Any], name: str) -> tuple[str, Any] | None:
    exact = _lookup(mapping, name)
    if exact:
        return exact
    wanted = re.sub(r"[^a-z0-9]", "", name.casefold())
    matches = [(key, value) for key, value in mapping.items() if re.sub(r"[^a-z0-9]", "", key.casefold()) == wanted]
    return matches[0] if len(matches) == 1 else None


def _closest_name(options: list[str], requested: str) -> str | None:
    if not options:
        return None
    normalized_requested = re.sub(r"[^a-z0-9]", "", requested.casefold())
    scored = []
    for option in options:
        normalized_option = re.sub(r"[^a-z0-9]", "", option.casefold())
        score = SequenceMatcher(None, normalized_requested, normalized_option).ratio()
        if normalized_requested and (normalized_option.startswith(normalized_requested) or normalized_requested.startswith(normalized_option)):
            score += 0.25
        scored.append((score, option))
    score, candidate = max(scored)
    return candidate if score >= 0.45 or len(options) == 1 else None


def bind(root: Node, model: dict[str, Any], catalog: dict[str, Any], current_measure: str) -> tuple[str, str, BindState]:
    state = BindState(model, catalog, current_measure)

    def discover_virtual_columns(node: Node) -> None:
        if isinstance(node, Call):
            if node.function in {"ADDCOLUMNS", "SUMMARIZE", "SELECTCOLUMNS"}:
                for argument in node.arguments[1:]:
                    if isinstance(argument, Literal) and argument.value_type == "text":
                        state.virtual_columns.add(str(argument.value).casefold())
                    elif isinstance(argument, QuotedName) and not _lookup(model.get("tables", {}), argument.value):
                        # Power BI uses double-quoted text for extension-column
                        # names. A single-quoted token is a table identifier and
                        # previously produced the misleading "Unknown measure"
                        # error when that alias was referenced later.
                        state.virtual_columns.add(str(argument.value).casefold())
                        state.error(
                            "DAX1014",
                            f"Calculated table column name '{argument.value}' must use double quotes.",
                            argument,
                            f'Use "{argument.value}" instead of \'{argument.value}\'.',
                        )
            for argument in node.arguments:
                discover_virtual_columns(argument)
        elif isinstance(node, Binary):
            discover_virtual_columns(node.left);discover_virtual_columns(node.right)
        elif isinstance(node, Unary):
            discover_virtual_columns(node.operand)
        elif isinstance(node, VarBlock):
            for variable in node.variables:discover_virtual_columns(variable.expression)
            discover_virtual_columns(node.result)

    discover_virtual_columns(root)

    def visit(node: Node, expected: str | None = None, allow_row_column: bool = False) -> tuple[str, str]:
        if isinstance(node, Literal):
            return node.value_type, "scalar"
        if isinstance(node, ColumnRef):
            table_hit = _lookup(model.get("tables", {}), node.table)
            if not table_hit:
                table_names = list(model.get("tables", {}))
                candidate = _closest_name(table_names, node.table)
                suggestion = (
                    f"Use '{candidate}'[Column] instead."
                    if candidate
                    else "Available tables: " + ", ".join(table_names[:8]) + ("…" if len(table_names) > 8 else ".")
                    if table_names
                    else "Import a table before creating this measure."
                )
                state.error("DAX1002", f"Unknown table '{node.table}'.", node, suggestion)
                return "unknown", "scalar"
            table_name, table = table_hit
            columns = table.get("columns", {})
            column_hit = _lookup(columns, node.column)
            if not column_hit:
                candidate = _closest_name(list(columns), node.column)
                suggestion = f"Use '{table_name}'[{candidate}] instead." if candidate else "Choose a current column from the model field list."
                state.error("DAX1003", f"Unknown column '{node.column}' in table '{table_name}'.", node, suggestion)
                return "unknown", "scalar"
            column_name, _ = column_hit
            table_meta = catalog["tables"][table_name]
            column_meta = table_meta["columns"][column_name]
            state.tables[table_name] = {"id": table_meta["id"], "name": table_name}
            state.columns[(table_name, column_name)] = {"id": column_meta["id"], "tableId": table_meta["id"], "table": table_name, "name": column_name, "dataType": column_meta["dataType"]}
            if not allow_row_column:
                state.error(
                    "DAX1013",
                    f"A single value for '{table_name}[{column_name}]' cannot be determined in a measure.",
                    node,
                    "Aggregate the column (for example SUM/MIN/MAX/SELECTEDVALUE), use it inside an iterator row expression, or create the derived column in Transform Data.",
                )
            return column_meta["dataType"], "scalar"
        if isinstance(node, MeasureRef):
            hit = _lookup_measure(model.get("measures", {}), node.measure)
            if not hit:
                if node.measure.casefold() in state.virtual_columns:
                    return "variant", "scalar"
                state.error("DAX1004", f"Unknown measure '[{node.measure}]'.", node, "Create the measure first or select one from the measure list.")
                return "unknown", "scalar"
            name, _ = hit
            if name.casefold() == current_measure.casefold():
                state.error("DAX1010", f"Measure '{current_measure}' references itself.", node)
            measure_id = catalog.get("measures", {}).get(name, {}).get("id")
            state.measures[name] = {"id": measure_id, "name": name}
            return catalog.get("measures", {}).get(name, {}).get("resultType", "variant"), "scalar"
        if isinstance(node, Name):
            variable = state.variables.get(node.value.casefold())
            if variable:
                return variable
            table_hit = _lookup(model.get("tables", {}), node.value)
            if table_hit:
                table_name, _ = table_hit
                meta = catalog["tables"][table_name]
                state.tables[table_name] = {"id": meta["id"], "name": table_name}
                return "table", "table"
            # Date intervals and ordering words are represented as names by some pasted formulas.
            if node.value.upper() in {"ASC", "DESC", "DENSE", "SKIP", "DAY", "MONTH", "QUARTER", "YEAR", "WEEK", "HOUR", "MINUTE", "SECOND"}:
                return "enum", "scalar"
            state.error("DAX1005", f"Unknown identifier '{node.value}'.", node)
            return "unknown", "scalar"
        if isinstance(node, QuotedName):
            table_hit = _lookup(model.get("tables", {}), node.value)
            if table_hit:
                table_name, _ = table_hit
                meta = catalog["tables"][table_name]
                state.tables[table_name] = {"id": meta["id"], "name": table_name}
                return "table", "table"
            return "text", "scalar"
        if isinstance(node, Unary):
            value_type, _ = visit(node.operand, allow_row_column=allow_row_column)
            return ("boolean" if node.operator == "NOT" else value_type), "scalar"
        if isinstance(node, Binary):
            left_type, _ = visit(node.left, allow_row_column=allow_row_column)
            right_type, _ = visit(node.right, allow_row_column=allow_row_column)
            if node.operator in {"=", "==", "<>", "<", ">", "<=", ">=", "&&", "||", "AND", "OR"}:
                return "boolean", "scalar"
            if node.operator == "&":
                return "text", "scalar"
            return ("decimal" if "decimal" in {left_type, right_type} else left_type), "scalar"
        if isinstance(node, VarBlock):
            for variable in node.variables:
                value_type, kind = visit(variable.expression, allow_row_column=allow_row_column)
                state.variables[variable.name.casefold()] = (value_type, kind)
            return visit(node.result)
        if isinstance(node, Call):
            spec = DAX_FUNCTION_REGISTRY.get(node.function.upper())
            function=node.function.upper()
            column_functions={"SUM","AVERAGE","MIN","MAX","COUNT","DISTINCTCOUNT","MEDIAN","VALUES","ALL","REMOVEFILTERS","SELECTEDVALUE","HASONEVALUE"}
            iterator_functions={"SUMX","AVERAGEX","MINX","MAXX","FILTER","CONCATENATEX","RANKX","ADDCOLUMNS","SUMMARIZE","TOPN"}
            for index,argument in enumerate(node.arguments):
                argument_row_scope=allow_row_column
                if function in column_functions and index==0:argument_row_scope=True
                elif function in iterator_functions and index>0:argument_row_scope=True
                elif function in {"CALCULATE","CALCULATETABLE"} and index>0:argument_row_scope=True
                elif function in {"DATEADD","DATESBETWEEN","DATESINPERIOD","DATESMTD","DATESQTD","DATESYTD","SAMEPERIODLASTYEAR","PREVIOUSMONTH","PREVIOUSQUARTER","PREVIOUSYEAR","PARALLELPERIOD","STARTOFMONTH","ENDOFMONTH","TOTALYTD","TOTALMTD","TOTALQTD"}:argument_row_scope=True
                visit(argument,allow_row_column=argument_row_scope)
            if spec is None:
                state.error("DAX1001", f"Unknown DAX function {node.function}.", node, "Check the function spelling or use a function shown as supported in the editor.")
                return "unknown", "scalar"
            if spec.status == "unsupported":
                state.error("DAX1006", f"{node.function} is recognized but is not executable in VTAB compatibility level 100.", node, spec.notes)
            count = len(node.arguments)
            if count < spec.min_args or (spec.max_args is not None and count > spec.max_args):
                expected_count = str(spec.min_args) if spec.min_args == spec.max_args else f"{spec.min_args}..{spec.max_args or '*'}"
                state.error("DAX1007", f"{node.function} expects {expected_count} arguments; received {count}.", node)
            return spec.return_type, spec.result_kind
        state.error("DAX1099", f"Unsupported syntax node {type(node).__name__}.", node)
        return "unknown", "scalar"

    result_type, result_kind = visit(root)
    return result_type, result_kind, state
