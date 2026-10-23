"""Deterministic Power BI-style DAX compatibility baseline.

Run with pytest, or execute this file directly.  Each case creates a fresh
in-memory model so data and filter context cannot leak between tests.
"""

from __future__ import annotations

import math
import pathlib
import sys

import duckdb

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from app.dax_engine import DaxError, compile_dax, diagnose_dax_definition


SALES_ROWS = [
    (101, "A", "East", 100, 20, "2026-01-01"),
    (102, "A", "West", 150, 30, "2026-01-02"),
    (103, "B", "East", 200, 50, "2026-01-03"),
    (104, "B", "West", 50, -5, "2026-01-04"),
    (105, "C", "East", 80, 10, "2026-01-05"),
    (106, "C", "West", 120, 40, "2026-01-06"),
]

SALES_MODEL = {
    "tables": {
        "Sales": {
            "physical": "Sales",
            "columns": {
                "Order ID": "Order ID",
                "Product": "Product",
                "Region": "Region",
                "Sales Amount": "Sales Amount",
                "Profit": "Profit",
                "Order Date": "Order Date",
            },
        }
    },
    "relationships": [],
    "columnTypes": {"Sales.Order Date": "date"},
    "measures": {},
}


def sales_connection():
    connection = duckdb.connect(":memory:")
    connection.execute(
        'CREATE TABLE "Sales" ("Order ID" INTEGER, "Product" VARCHAR, "Region" VARCHAR, '
        '"Sales Amount" DOUBLE, "Profit" DOUBLE, "Order Date" DATE)'
    )
    connection.executemany('INSERT INTO "Sales" VALUES (?, ?, ?, ?, ?, ?)', SALES_ROWS)
    return connection


def evaluate_sales(expression: str):
    connection = sales_connection()
    try:
        compiled = compile_dax(expression, SALES_MODEL)
        return connection.execute(
            f'SELECT {compiled.sql} AS value FROM "Sales" "Sales" LIMIT 1'
        ).fetchone()[0]
    finally:
        connection.close()


def test_01_nested_iterators_and_context_transition():
    expression = '''High Value Product Sales =
SUMX (
    FILTER (
        VALUES ( Sales[Product] ),
        CALCULATE ( SUM ( Sales[Sales Amount] ) ) >= 250
    ),
    CALCULATE ( SUM ( Sales[Sales Amount] ) )
)'''
    assert evaluate_sales(expression) == 500


def test_02_variables_iterators_and_nested_logic():
    expression = '''Product Performance =
VAR TotalSales = SUM ( Sales[Sales Amount] )
VAR TotalProfit = SUM ( Sales[Profit] )
VAR Margin = DIVIDE ( TotalProfit, TotalSales )
VAR AverageProductSales =
    AVERAGEX ( VALUES ( Sales[Product] ), CALCULATE ( SUM ( Sales[Sales Amount] ) ) )
RETURN
    IF ( ISBLANK ( Margin ), "No Data",
        IF ( Margin >= 0.2 && TotalSales > AverageProductSales,
            "High Performance", "Standard Performance" ) )'''
    assert evaluate_sales(expression) == "High Performance"


def test_03_calculate_and_removefilters():
    expression = '''East Sales Share =
VAR EastSales = CALCULATE ( SUM ( Sales[Sales Amount] ), Sales[Region] = "East" )
VAR AllRegionSales = CALCULATE ( SUM ( Sales[Sales Amount] ), REMOVEFILTERS ( Sales[Region] ) )
RETURN DIVIDE ( EastSales, AllRegionSales )'''
    assert math.isclose(evaluate_sales(expression), 380 / 700, rel_tol=1e-9)
    # Under an existing West visual filter, CALCULATE's East predicate replaces
    # the Region filter while REMOVEFILTERS clears it for the denominator.
    connection = sales_connection()
    try:
        compiled = compile_dax(expression, SALES_MODEL, [{
            "field": "Sales.Region", "operator": "equals", "value": "West"
        }])
        filtered = connection.execute(
            f'SELECT {compiled.sql} AS value FROM "Sales" "Sales" '
            'WHERE "Sales"."Region" = \'West\' LIMIT 1'
        ).fetchone()[0]
        assert math.isclose(filtered, 380 / 700, rel_tol=1e-9)
    finally:
        connection.close()


def test_04_rankx_dense_ties_in_grouped_visual():
    expression = '''Product Sales Rank =
RANKX ( ALL ( Sales[Product] ), CALCULATE ( SUM ( Sales[Sales Amount] ) ), , DESC, DENSE )'''
    connection = sales_connection()
    try:
        sql = compile_dax(expression, SALES_MODEL).sql
        actual = connection.execute(
            f'SELECT "Sales"."Product", {sql} AS rank FROM "Sales" "Sales" '
            'GROUP BY "Sales"."Product" ORDER BY "Sales"."Product"'
        ).fetchall()
        assert actual == [("A", 1), ("B", 1), ("C", 2)]
    finally:
        connection.close()


def test_05_topn_virtual_columns_and_sumx():
    expression = '''Top Two Product Sales =
VAR ProductTotals =
    ADDCOLUMNS ( VALUES ( Sales[Product] ), "@ProductSales", CALCULATE ( SUM ( Sales[Sales Amount] ) ) )
VAR TopProducts = TOPN ( 2, ProductTotals, [@ProductSales], DESC )
RETURN SUMX ( TopProducts, [@ProductSales] )'''
    assert evaluate_sales(expression) == 500


def test_06_format_and_concatenation_return_text():
    expression = '''Sales Summary Label =
VAR TotalSales = SUM ( Sales[Sales Amount] )
VAR TotalProfit = SUM ( Sales[Profit] )
VAR Margin = DIVIDE ( TotalProfit, TotalSales )
RETURN FORMAT ( TotalSales, "#,##0" ) & " USD | Profit: "
    & FORMAT ( TotalProfit, "#,##0" ) & " USD | Margin: "
    & FORMAT ( Margin, "0.00%" )'''
    value = evaluate_sales(expression)
    assert value == "700 USD | Profit: 145 USD | Margin: 20.71%"
    assert isinstance(value, str)


def test_07_dates_addcolumns_averagex_and_format():
    expression = '''Average Order Date Span =
VAR DateSpanTable =
    ADDCOLUMNS (
        Sales,
        "@DaysFromFirstOrder",
            DATEDIFF (
                CALCULATE ( MIN ( Sales[Order Date] ), REMOVEFILTERS ( Sales ) ),
                Sales[Order Date], DAY
            )
    )
VAR AverageSpan = AVERAGEX ( DateSpanTable, [@DaysFromFirstOrder] )
RETURN FORMAT ( AverageSpan, "0.00" ) & " Days"'''
    assert evaluate_sales(expression) == "2.50 Days"


def test_08_distinct_counts_filters_and_text():
    expression = '''Order Classification =
VAR TotalOrders = DISTINCTCOUNT ( Sales[Order ID] )
VAR NegativeProfitOrders = CALCULATE ( DISTINCTCOUNT ( Sales[Order ID] ), FILTER ( Sales, Sales[Profit] < 0 ) )
VAR PositiveProfitOrders = CALCULATE ( DISTINCTCOUNT ( Sales[Order ID] ), FILTER ( Sales, Sales[Profit] > 0 ) )
RETURN IF ( TotalOrders = 0, "No Orders",
    IF ( NegativeProfitOrders > 0,
        FORMAT ( NegativeProfitOrders, "0" ) & " Loss Order(s); "
        & FORMAT ( PositiveProfitOrders, "0" ) & " Profit Order(s)",
        "No Loss Orders" ) )'''
    assert evaluate_sales(expression) == "1 Loss Order(s); 5 Profit Order(s)"


def test_09_multistage_virtual_table_filtering():
    expression = '''High Margin Sales =
VAR QualifyingProducts =
    FILTER (
        ADDCOLUMNS (
            VALUES ( Sales[Product] ),
            "@ProductSales", CALCULATE ( SUM ( Sales[Sales Amount] ) ),
            "@ProductProfit", CALCULATE ( SUM ( Sales[Profit] ) )
        ),
        DIVIDE ( [@ProductProfit], [@ProductSales] ) >= 0.2
    )
RETURN SUMX ( QualifyingProducts, [@ProductSales] )'''
    assert evaluate_sales(expression) == 450


def test_10_nested_table_variables_above_average():
    expression = '''Product Sales Above Average =
VAR ProductTotals =
    ADDCOLUMNS ( VALUES ( Sales[Product] ), "@Sales", CALCULATE ( SUM ( Sales[Sales Amount] ) ) )
VAR AverageProductSales = AVERAGEX ( ProductTotals, [@Sales] )
VAR AboveAverageProducts = FILTER ( ProductTotals, [@Sales] > AverageProductSales )
RETURN SUMX ( AboveAverageProducts, [@Sales] )'''
    assert evaluate_sales(expression) == 500


def test_11_average_length_of_stay_integration():
    model = {
        "tables": {"RS Puram": {"physical": "RS Puram", "columns": {
            "Admission Date": "Admission Date", "Discharge Date": "Discharge Date"
        }}},
        "relationships": [],
        "columnTypes": {"RS Puram.Admission Date": "date", "RS Puram.Discharge Date": "date"},
        "measures": {},
    }
    expression = '''Avg LOS =
VAR AvgDays =
    AVERAGEX (
        FILTER (
            'RS Puram',
            NOT ISBLANK ( 'RS Puram'[Admission Date] )
                && NOT ISBLANK ( 'RS Puram'[Discharge Date] )
                && 'RS Puram'[Discharge Date] >= 'RS Puram'[Admission Date]
        ),
        DATEDIFF ( 'RS Puram'[Admission Date], 'RS Puram'[Discharge Date], DAY )
    )
RETURN FORMAT ( AvgDays, "0" ) & " Days"'''
    connection = duckdb.connect(":memory:")
    try:
        connection.execute('CREATE TABLE "RS Puram" ("Admission Date" DATE, "Discharge Date" DATE)')
        connection.executemany('INSERT INTO "RS Puram" VALUES (?, ?)', [
            ("2026-01-01", "2026-01-04"), ("2026-01-01", "2026-01-06"),
            ("2026-01-02", "2026-01-03"), (None, "2026-01-04"),
            ("2026-01-05", "2026-01-03"),
        ])
        sql = compile_dax(expression, model).sql
        value = connection.execute(
            f'SELECT {sql} AS value FROM "RS Puram" "RS Puram" LIMIT 1'
        ).fetchone()[0]
        assert value == "3 Days"
    finally:
        connection.close()


def test_measure_mode_explains_calculated_column_limitations():
    direct = diagnose_dax_definition("Bad Measure = Sales[Profit]")
    assert any("calculated column" in issue.lower() for issue in direct["issues"])
    earlier = diagnose_dax_definition("Bad Measure = EARLIER(Sales[Profit])")
    assert any("calculated-column row context" in issue.lower() for issue in earlier["issues"])
    try:
        compile_dax("Bad Measure = EARLIER(Sales[Profit])", SALES_MODEL)
    except DaxError as error:
        assert "calculated-column row context" in str(error).lower()
    else:
        raise AssertionError("Unsupported calculated-column function was accepted")


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    failures = []
    for test in tests:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception as error:  # pragma: no cover - direct runner diagnostics
            failures.append((test.__name__, error))
            print(f"FAIL {test.__name__}: {type(error).__name__}: {error}")
    if failures:
        raise SystemExit(1)
    print(f"{len(tests)} Power BI-style DAX compatibility checks passed.")
