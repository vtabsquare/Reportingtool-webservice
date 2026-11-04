from app.dax_engine import compile_dax


MODEL = {
    "tables": {
        "Sales": {
            "physical": "sales",
            "columns": {"Date": "dt", "Net Sales": "net_sales"},
        }
    },
    "relationships": [],
    "columnTypes": {"Sales.Date": "date", "Sales.Net Sales": "double"},
    "measures": {
        "Net Sales": "SUM(Sales[Net Sales])",
        "Previous Month Net Sales": "CALCULATE([Net Sales], PREVIOUSMONTH(Sales[Date]))",
        "KPI Variance": "[Net Sales] - [Previous Month Net Sales]",
        "KPI Color": """SWITCH(
            TRUE(),
            ISBLANK([Previous Month Net Sales]), "#808080",
            [KPI Variance] > 0, "#16A34A",
            [KPI Variance] < 0, "#DC2626",
            "#EAB308"
        )""",
    },
}


def _resolver(name: str) -> str:
    return compile_dax(MODEL["measures"][name], MODEL, measure_resolver=_resolver).sql


def test_numeric_kpi_with_previous_month_filter_is_not_coerced_to_date():
    sql = compile_dax(MODEL["measures"]["KPI Color"], MODEL, measure_resolver=_resolver).sql
    assert "INTERVAL '1 month'" in sql
    assert "TRY_CAST(0 AS DATE)" not in sql
    assert "TRY_CAST((SUM" not in sql
    assert "> 0" in sql and "< 0" in sql

