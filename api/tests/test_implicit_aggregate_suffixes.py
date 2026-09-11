from app.semantic_engine import compile_query, measure


MODEL = {
    "tables": {
        "sales_dataset_100_rows_multi_year_1_Copy": {
            "physical": "sales_dataset_100_rows_multi_year_1_Copy",
            "columns": {
                "OrderID": "OrderID",
                "Region": "Region",
                "Amount": "Amount",
            },
        }
    },
    "measures": {},
    "relationships": [],
}


def test_count_suffix_from_published_visual_is_an_implicit_measure():
    binding = "sales_dataset_100_rows_multi_year_1_Copy.OrderID::count"

    sql = measure(binding, MODEL)

    assert sql == 'COUNT("sales_dataset_100_rows_multi_year_1_Copy"."OrderID")'


def test_distinct_count_and_average_aliases_are_supported():
    distinct = measure(
        "sales_dataset_100_rows_multi_year_1_Copy.OrderID::distinctcount", MODEL
    )
    average = measure(
        "sales_dataset_100_rows_multi_year_1_Copy.Amount::avg", MODEL
    )

    assert distinct == (
        'COUNT(DISTINCT "sales_dataset_100_rows_multi_year_1_Copy"."OrderID")'
    )
    assert average == (
        'AVG(TRY_CAST("sales_dataset_100_rows_multi_year_1_Copy"."Amount" AS DOUBLE))'
    )


def test_compile_query_keeps_the_aggregate_binding_as_the_result_alias():
    binding = "sales_dataset_100_rows_multi_year_1_Copy.OrderID::count"

    sql, params = compile_query(
        MODEL,
        {
            "dimensions": ["sales_dataset_100_rows_multi_year_1_Copy.Region"],
            "measures": [binding],
            "filters": [],
            "sort": [],
            "limit": 500,
        },
    )

    assert f'AS "{binding}"' in sql
    assert 'COUNT("sales_dataset_100_rows_multi_year_1_Copy"."OrderID")' in sql
    assert params == []
