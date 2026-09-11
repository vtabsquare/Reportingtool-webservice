import pytest

from app.transform_engine import validate_native_query


def test_advanced_query_accepts_select_and_cte():
    assert validate_native_query('SELECT * FROM "SalesData";') == 'SELECT * FROM "SalesData"'
    assert validate_native_query('WITH x AS (SELECT 1 AS n) SELECT * FROM x').startswith('WITH x')


@pytest.mark.parametrize(
    'sql',
    [
        'DELETE FROM SalesData',
        'SELECT * FROM SalesData; DROP TABLE SalesData',
        "SELECT * FROM read_csv('private.csv')",
        'PRAGMA show_tables',
        'SELECT 1 -- hidden statement',
    ],
)
def test_advanced_query_rejects_non_read_only_sql(sql):
    with pytest.raises(ValueError, match='read-only|start with'):
        validate_native_query(sql)
