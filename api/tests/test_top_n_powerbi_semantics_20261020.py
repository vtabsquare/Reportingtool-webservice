import pytest

duckdb = pytest.importorskip("duckdb")

from app.semantic_engine import compile_query


MODEL = {
    "tables": {
        "Sales": {
            "physical": "sales",
            "columns": {
                "Product": "product",
                "Region": "region",
                "Category": "category",
                "Sales Amount": "sales_amount",
                "Profit": "profit",
                "Order ID": "order_id",
            },
        }
    },
    "relationships": [],
    "measures": {
        "Total Sales": "SUM('Sales'[Sales Amount])",
        "Total Profit": "SUM('Sales'[Profit])",
        "Order Count": "DISTINCTCOUNT('Sales'[Order ID])",
    },
}


@pytest.fixture()
def connection():
    con = duckdb.connect()
    con.execute("""CREATE TABLE sales(
        product VARCHAR, region VARCHAR, category VARCHAR,
        sales_amount DOUBLE, profit DOUBLE, order_id VARCHAR
    )""")
    rows = [
        ("Alpha", "North", "A", 50, 5, "A1"),
        ("Alpha", "North", "A", 50, 5, "A2"),
        ("Beta", "North", "A", 90, -10, "B1"),
        ("Gamma", "North", "B", 80, 20, "G1"),
        ("Delta", "North", "B", 70, 0, "D1"),
        ("Echo", "South", "A", 500, 50, "E1"),
        ("Foxtrot", "South", "B", 400, None, "F1"),
        ("Golf", "South", "B", 100, -30, "H1"),
        ("Tie A", "North", "C", 60, 1, "T1"),
        ("Tie B", "North", "C", 60, 1, "T2"),
    ]
    con.executemany("INSERT INTO sales VALUES (?,?,?,?,?,?)", rows)
    yield con
    con.close()


def run(connection, dimensions, measures, filters, sort=None):
    sql, params = compile_query(MODEL, {
        "dimensions": dimensions,
        "measures": measures,
        "filters": filters,
        "sort": sort or [],
        "limit": 5000,
    })
    return sql, connection.execute(sql, params).fetchall()


def top_n(value, ranking="Total Sales", direction="top"):
    return {
        "field": "Sales.Product", "operator": "top_n", "value": value,
        "rankingField": ranking, "rankingDirection": direction,
    }


def test_top_three_aggregates_duplicate_transactions(connection):
    _, rows = run(connection, ["Sales.Product"], ["Total Sales"], [top_n(3)])
    assert {row[0] for row in rows} == {"Echo", "Foxtrot", "Alpha"}
    assert next(row[1] for row in rows if row[0] == "Alpha") == 100


def test_bottom_three_profit_excludes_null_ranks(connection):
    _, rows = run(connection, ["Sales.Product"], ["Total Profit"], [top_n(3, "Total Profit", "bottom")])
    assert {row[0] for row in rows} == {"Golf", "Beta", "Delta"}
    assert "Foxtrot" not in {row[0] for row in rows}


def test_n_larger_than_available_returns_all_non_null_members(connection):
    _, rows = run(connection, ["Sales.Product"], ["Total Profit"], [top_n(100, "Total Profit")])
    assert len(rows) == 8


def test_nth_place_ties_are_broken_by_dimension_ascending(connection):
    _, rows = run(connection, ["Sales.Product"], ["Total Sales"], [top_n(8)])
    products = {row[0] for row in rows}
    assert "Tie A" in products and "Tie B" not in products


def test_region_context_recalculates_the_rank(connection):
    region = {"field": "Sales.Region", "operator": "equals", "value": "North"}
    _, rows = run(connection, ["Sales.Product"], ["Total Sales"], [region, top_n(3)])
    assert {row[0] for row in rows} == {"Alpha", "Beta", "Gamma"}


def test_changing_ranking_measure_changes_members(connection):
    _, sales_rows = run(connection, ["Sales.Product"], ["Total Sales"], [top_n(2)])
    _, profit_rows = run(connection, ["Sales.Product"], ["Total Profit"], [top_n(2, "Total Profit")])
    assert {row[0] for row in sales_rows} != {row[0] for row in profit_rows}


def test_hidden_ranking_dimension_filters_the_visible_aggregation(connection):
    _, rows = run(connection, ["Sales.Category"], ["Total Sales"], [top_n(2)])
    assert sum(row[1] for row in rows) == 900


def test_visual_sort_is_independent_from_top_n_rank_order(connection):
    _, rows = run(connection, ["Sales.Product"], ["Total Sales"], [top_n(3)], [{"field": "Total Sales", "direction": "asc"}])
    assert [row[1] for row in rows] == sorted(row[1] for row in rows)


def test_raw_numeric_aggregation_suffixes_are_supported(connection):
    _, rows = run(connection, ["Sales.Product"], ["Sales.Sales Amount::avg"], [top_n(1, "Sales.Sales Amount::avg")])
    assert rows == [("Echo", 500.0)]


def test_removing_top_n_restores_unfiltered_members(connection):
    _, filtered = run(connection, ["Sales.Product"], ["Total Sales"], [top_n(3)])
    _, restored = run(connection, ["Sales.Product"], ["Total Sales"], [])
    assert len(filtered) == 3 and len(restored) == 9

