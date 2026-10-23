"""Authoritative DAX compatibility metadata for the VTAB measure engine.

The registry is deliberately honest: ``supported`` and ``partial`` entries are
connected to compiler implementations, while known Power BI functions that are
not implemented remain discoverable as ``unsupported``.  This prevents the UI
from advertising a function merely because its name is recognized.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DaxFunctionSpec:
    name: str
    category: str
    min_args: int
    max_args: int | None
    argument_types: tuple[str, ...]
    return_type: str
    result_kind: str = "scalar"
    contexts: tuple[str, ...] = ("measure",)
    status: str = "unsupported"
    notes: str = ""


_IMPLEMENTED_BY_CATEGORY = {
    "aggregation": "SUM SUMX AVERAGE AVERAGEX MIN MINX MAX MAXX COUNT COUNTROWS DISTINCTCOUNT MEDIAN",
    "logical": "IF SWITCH AND OR NOT TRUE FALSE COALESCE BLANK",
    "information": "ISBLANK SELECTEDVALUE",
    "text": "FORMAT CONCATENATE CONCATENATEX LEFT RIGHT MID LEN SUBSTITUTE TRIM UPPER LOWER CONTAINSSTRING CONTAINSSTRINGEXACT VALUE",
    "date_time": "DATE YEAR MONTH DAY TODAY NOW DATEDIFF EDATE EOMONTH",
    "math": "ABS ROUND INT FLOOR CEILING DIVIDE POWER SQRT",
    "filter_context": "CALCULATE CALCULATETABLE FILTER ALL REMOVEFILTERS KEEPFILTERS VALUES",
    "table": "ADDCOLUMNS SUMMARIZE TOPN",
    "time_intelligence": "DATEADD DATESBETWEEN DATESINPERIOD DATESMTD DATESQTD DATESYTD TOTALMTD TOTALQTD TOTALYTD SAMEPERIODLASTYEAR STARTOFMONTH ENDOFMONTH PREVIOUSMONTH PREVIOUSQUARTER PREVIOUSYEAR PARALLELPERIOD",
    "ranking": "RANKX",
}

_PARTIAL = {
    "FORMAT": "Power BI-style numeric, percentage and common date masks are supported; named Visual Basic masks and arbitrary culture packs are not yet complete.",
    "RANKX": "Supported for visual grouping over ALL/VALUES column sets, including ASC/DESC and DENSE/SKIP ties.",
    "CALCULATE": "Boolean filters, FILTER, REMOVEFILTERS, KEEPFILTERS and supported date-table filters are implemented.",
    "CALCULATETABLE": "Implemented for table expressions with source lineage.",
    "ADDCOLUMNS": "Implemented for physical tables and supported derived tables.",
    "SUMMARIZE": "Grouping and named scalar expressions are supported.",
    "TOPN": "Constant N and supported scalar ordering expressions are implemented with boundary-tie behavior.",
    "DATEADD": "Supported for date-column filter-context calculations.",
    "DATESBETWEEN": "Supported for date-column filter-context calculations.",
    "DATESINPERIOD": "DAY, MONTH, QUARTER and YEAR are supported.",
    "SAMEPERIODLASTYEAR": "Supported for date-column filter-context calculations.",
    "PREVIOUSMONTH": "Supported for date-column filter-context calculations.",
    "PREVIOUSQUARTER": "Supported for date-column filter-context calculations.",
    "PREVIOUSYEAR": "Supported for date-column filter-context calculations.",
    "PARALLELPERIOD": "Supported for YEAR, QUARTER and MONTH date-column filter-context calculations.",
}

_SIGNATURES: dict[str, tuple[int, int | None, tuple[str, ...], str, str]] = {
    "SUM": (1, 1, ("column",), "number", "scalar"),
    "AVERAGE": (1, 1, ("column",), "number", "scalar"),
    "MIN": (1, 2, ("column_or_scalar",), "variant", "scalar"),
    "MAX": (1, 2, ("column_or_scalar",), "variant", "scalar"),
    "COUNT": (1, 1, ("column",), "integer", "scalar"),
    "COUNTROWS": (1, 1, ("table",), "integer", "scalar"),
    "DISTINCTCOUNT": (1, 1, ("column",), "integer", "scalar"),
    "MEDIAN": (1, 1, ("column",), "number", "scalar"),
    "SUMX": (2, 2, ("table", "scalar_expression"), "number", "scalar"),
    "AVERAGEX": (2, 2, ("table", "scalar_expression"), "number", "scalar"),
    "MINX": (2, 2, ("table", "scalar_expression"), "variant", "scalar"),
    "MAXX": (2, 2, ("table", "scalar_expression"), "variant", "scalar"),
    "IF": (2, 3, ("boolean", "scalar", "scalar"), "variant", "scalar"),
    "SWITCH": (3, None, ("scalar", "pairs", "optional_else"), "variant", "scalar"),
    "AND": (2, None, ("boolean",), "boolean", "scalar"),
    "OR": (2, None, ("boolean",), "boolean", "scalar"),
    "NOT": (1, 1, ("boolean",), "boolean", "scalar"),
    "TRUE": (0, 0, (), "boolean", "scalar"),
    "FALSE": (0, 0, (), "boolean", "scalar"),
    "BLANK": (0, 0, (), "blank", "scalar"),
    "COALESCE": (2, None, ("scalar",), "variant", "scalar"),
    "ISBLANK": (1, 1, ("scalar",), "boolean", "scalar"),
    "SELECTEDVALUE": (1, 2, ("column", "alternate"), "variant", "scalar"),
    "FORMAT": (2, 3, ("scalar", "format_string", "optional_locale"), "text", "scalar"),
    "CONCATENATE": (2, 2, ("scalar", "scalar"), "text", "scalar"),
    "CONCATENATEX": (3, 5, ("table", "expression", "delimiter", "order_by", "order"), "text", "scalar"),
    "LEFT": (1, 2, ("text", "count"), "text", "scalar"),
    "RIGHT": (1, 2, ("text", "count"), "text", "scalar"),
    "MID": (3, 3, ("text", "start", "count"), "text", "scalar"),
    "LEN": (1, 1, ("text",), "integer", "scalar"),
    "SUBSTITUTE": (3, 4, ("text", "old", "new", "instance"), "text", "scalar"),
    "TRIM": (1, 1, ("text",), "text", "scalar"),
    "UPPER": (1, 1, ("text",), "text", "scalar"),
    "LOWER": (1, 1, ("text",), "text", "scalar"),
    "CONTAINSSTRING": (2, 2, ("text", "text"), "boolean", "scalar"),
    "CONTAINSSTRINGEXACT": (2, 2, ("text", "text"), "boolean", "scalar"),
    "VALUE": (1, 1, ("text",), "number", "scalar"),
    "DATE": (3, 3, ("year", "month", "day"), "datetime", "scalar"),
    "YEAR": (1, 1, ("datetime",), "integer", "scalar"),
    "MONTH": (1, 1, ("datetime",), "integer", "scalar"),
    "DAY": (1, 1, ("datetime",), "integer", "scalar"),
    "TODAY": (0, 0, (), "datetime", "scalar"),
    "NOW": (0, 0, (), "datetime", "scalar"),
    "DATEDIFF": (3, 3, ("datetime", "datetime", "interval"), "integer", "scalar"),
    "EDATE": (2, 2, ("datetime", "months"), "datetime", "scalar"),
    "EOMONTH": (2, 2, ("datetime", "months"), "datetime", "scalar"),
    "DIVIDE": (2, 3, ("number", "number", "alternate"), "number", "scalar"),
    "CALCULATE": (1, None, ("scalar_expression", "filters"), "variant", "scalar"),
    "CALCULATETABLE": (1, None, ("table_expression", "filters"), "table", "table"),
    "FILTER": (2, 2, ("table", "boolean_expression"), "table", "table"),
    "ALL": (1, None, ("table_or_columns",), "table", "table"),
    "REMOVEFILTERS": (0, None, ("table_or_columns",), "table", "table"),
    "KEEPFILTERS": (1, 1, ("filter_expression",), "table", "table"),
    "VALUES": (1, 1, ("table_or_column",), "table", "table"),
    "ADDCOLUMNS": (3, None, ("table", "name_expression_pairs"), "table", "table"),
    "SUMMARIZE": (2, None, ("table", "group_columns", "name_expression_pairs"), "table", "table"),
    "TOPN": (3, None, ("integer", "table", "order_pairs"), "table", "table"),
    "RANKX": (2, 5, ("table", "expression", "value", "order", "ties"), "integer", "scalar"),
    "PREVIOUSMONTH": (1, 1, ("date_column",), "table", "table"),
    "PREVIOUSQUARTER": (1, 1, ("date_column",), "table", "table"),
    "PREVIOUSYEAR": (1, 1, ("date_column",), "table", "table"),
    "PARALLELPERIOD": (3, 3, ("date_column", "interval_count", "interval"), "table", "table"),
}

_UNSUPPORTED_BY_CATEGORY = {
    "aggregation": "COUNTA COUNTAX COUNTBLANK PRODUCT PRODUCTX MEDIANX",
    "logical": "IF.EAGER IFERROR",
    "information": "ISNUMBER ISTEXT ISLOGICAL ISERROR ISERR ISEMPTY ISINSCOPE HASONEVALUE HASONEFILTER ISFILTERED ISCROSSFILTERED",
    "text": "FIND SEARCH REPLACE CLEAN PROPER EXACT FIXED UNICHAR UNICODE",
    "date_time": "DATEVALUE TIME TIMEVALUE HOUR MINUTE SECOND WEEKDAY WEEKNUM CALENDAR CALENDARAUTO",
    "math": "ROUNDUP ROUNDDOWN TRUNC MOD EXP LN LOG LOG10 SIGN MROUND QUOTIENT RAND RANDBETWEEN",
    "filter_context": "ALLSELECTED ALLEXCEPT DISTINCT EARLIER EARLIEST USERELATIONSHIP CROSSFILTER TREATAS ALLNOBLANKROW",
    "table": "SELECTCOLUMNS SUMMARIZECOLUMNS GROUPBY CURRENTGROUP GENERATE GENERATEALL CROSSJOIN UNION INTERSECT EXCEPT NATURALINNERJOIN NATURALLEFTOUTERJOIN ROW DATATABLE",
    "ranking_statistical": "RANK PERCENTILE.INC PERCENTILE.EXC",
    "relationship_parent_child": "RELATED RELATEDTABLE LOOKUPVALUE PATH PATHITEM PATHCONTAINS PATHLENGTH",
    "time_intelligence": "NEXTMONTH NEXTQUARTER NEXTYEAR STARTOFQUARTER ENDOFQUARTER STARTOFYEAR ENDOFYEAR",
}


def _default_signature(name: str) -> tuple[int, int | None, tuple[str, ...], str, str]:
    return _SIGNATURES.get(name, (1, None, ("expression",), "variant", "scalar"))


DAX_FUNCTION_REGISTRY: dict[str, DaxFunctionSpec] = {}
for category, names in _IMPLEMENTED_BY_CATEGORY.items():
    for name in names.split():
        minimum, maximum, arguments, return_type, kind = _default_signature(name)
        status = "partial" if name in _PARTIAL else "supported"
        DAX_FUNCTION_REGISTRY[name] = DaxFunctionSpec(
            name=name,
            category=category,
            min_args=minimum,
            max_args=maximum,
            argument_types=arguments,
            return_type=return_type,
            result_kind=kind,
            contexts=("measure", "visual"),
            status=status,
            notes=_PARTIAL.get(name, ""),
        )

for category, names in _UNSUPPORTED_BY_CATEGORY.items():
    for name in names.split():
        DAX_FUNCTION_REGISTRY.setdefault(
            name,
            DaxFunctionSpec(
                name=name,
                category=category,
                min_args=0,
                max_args=None,
                argument_types=("see Microsoft DAX reference",),
                return_type="unknown",
                status="unsupported",
                notes="Recognized Power BI DAX function; no VTAB evaluator implementation is available yet.",
            ),
        )

ALIASES = {"AVG": "AVERAGE"}


def canonical_function_name(name: str) -> str:
    upper = name.upper()
    return ALIASES.get(upper, upper)


def executable_function_names() -> frozenset[str]:
    return frozenset(
        name for name, spec in DAX_FUNCTION_REGISTRY.items()
        if spec.status in {"supported", "partial"}
    )


def known_function_names() -> frozenset[str]:
    return frozenset(DAX_FUNCTION_REGISTRY) | frozenset(ALIASES)


def function_registry_payload() -> list[dict]:
    return [
        {
            "name": spec.name,
            "category": spec.category,
            "minArgs": spec.min_args,
            "maxArgs": spec.max_args,
            "argumentTypes": list(spec.argument_types),
            "returnType": spec.return_type,
            "resultKind": spec.result_kind,
            "contexts": list(spec.contexts),
            "status": spec.status,
            "notes": spec.notes,
        }
        for spec in sorted(DAX_FUNCTION_REGISTRY.values(), key=lambda item: (item.category, item.name))
    ]
