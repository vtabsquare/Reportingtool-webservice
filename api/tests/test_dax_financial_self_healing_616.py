from __future__ import annotations

import math

import duckdb

from app.dax_v2 import analyze_measure
from app.semantic_engine import measure


MODEL = {
    "tables": {
        "Securities_Data": {
            "physical": "Securities_Data",
            "columns": {
                "NAME OF ISSUER": "NAME OF ISSUER",
                "VALUE OF AMT. OUTSTANDING (J$)": "VALUE OF AMT. OUTSTANDING (J$)",
                "RATE OF INTEREST": "RATE OF INTEREST",
                "MATURITY DATE OF OUTSTANDING ISSUES": "MATURITY DATE OF OUTSTANDING ISSUES",
            },
        }
    },
    "relationships": [],
    "columnTypes": {
        "Securities_Data.NAME OF ISSUER": "text",
        "Securities_Data.VALUE OF AMT. OUTSTANDING (J$)": "decimal",
        "Securities_Data.RATE OF INTEREST": "decimal",
        "Securities_Data.MATURITY DATE OF OUTSTANDING ISSUES": "date",
    },
    "measures": {
        "Total Outstanding (J$)": "Total Outstanding (J$) = SUM('Securities_Data'[VALUE OF AMT. OUTSTANDING (J$)])",
    },
}


def connection():
    db = duckdb.connect(":memory:")
    db.execute(
        'CREATE TABLE "Securities_Data" ('
        '"NAME OF ISSUER" VARCHAR, '
        '"VALUE OF AMT. OUTSTANDING (J$)" DOUBLE, '
        '"RATE OF INTEREST" DOUBLE, '
        '"MATURITY DATE OF OUTSTANDING ISSUES" DATE)'
    )
    db.executemany('INSERT INTO "Securities_Data" VALUES (?, ?, ?, ?)', [
        ("Issuer A", 100.0, 4.0, "2027-01-01"),
        ("Issuer A", 50.0, 6.0, "2027-01-01"),
        ("Issuer B", 50.0, 8.0, "2028-01-01"),
    ])
    return db


def evaluate(name: str, expression: str):
    subject = {**MODEL, "measures": {**MODEL["measures"], name: expression}}
    sql = measure(name, subject, context_filters=[])
    db = connection()
    try:
        return db.execute(f'SELECT {sql} AS value FROM "Securities_Data" "Securities_Data" LIMIT 1').fetchone()[0]
    finally:
        db.close()


def test_population_standard_deviation_is_supported_end_to_end():
    expression = "Return Volatility = STDEV.P('Securities_Data'[RATE OF INTEREST])"
    assert analyze_measure(expression, MODEL).valid
    assert math.isclose(evaluate("Return Volatility", expression), math.sqrt(8 / 3), rel_tol=1e-12)


def test_iterator_local_var_concentration_measure_parses_binds_and_executes():
    expression = """Risk Concentration Index =
SUMX(
    VALUES('Securities_Data'[NAME OF ISSUER]),
    VAR IssuerShare =
        DIVIDE(
            CALCULATE([Total Outstanding (J$)]),
            CALCULATE(
                [Total Outstanding (J$)],
                ALL('Securities_Data'[NAME OF ISSUER])
            ),
            0
        )
    RETURN
        IssuerShare * IssuerShare
)"""
    assert analyze_measure(expression, MODEL).valid
    assert math.isclose(evaluate("Risk Concentration Index", expression), 0.625, rel_tol=1e-12)


def test_maturity_concentration_uses_the_same_iterator_context_rules():
    expression = """Maturity Concentration Index =
SUMX(
    VALUES('Securities_Data'[MATURITY DATE OF OUTSTANDING ISSUES]),
    VAR MaturityShare =
        DIVIDE(
            CALCULATE([Total Outstanding (J$)]),
            CALCULATE(
                [Total Outstanding (J$)],
                ALL('Securities_Data'[MATURITY DATE OF OUTSTANDING ISSUES])
            ),
            0
        )
    RETURN
        MaturityShare * MaturityShare
)"""
    assert analyze_measure(expression, MODEL).valid
    assert math.isclose(evaluate("Maturity Concentration Index", expression), 0.625, rel_tol=1e-12)


def test_blank_measure_compiles_to_sql_null_instead_of_duckdb_blank_function():
    expression = "Top Quartile Return (%) = BLANK()"
    assert analyze_measure(expression, MODEL).valid
    assert evaluate("Top Quartile Return (%)", expression) is None
