from app.semantic_engine import compile_query, measure


MODEL = {
    'tables': {
        'fact_sales': {'physical': 'fact_sales', 'columns': {'date_key': 'date_key', 'profit': 'profit', 'net_sales': 'net_sales', 'order_status': 'order_status'}},
        'fact_targets': {'physical': 'fact_targets', 'columns': {'date_key': 'date_key', 'profit_target': 'profit_target'}},
        'dim_date': {'physical': 'dim_date', 'columns': {'date_key': 'date_key', 'full_date': 'full_date'}},
    },
    'relationships': [
        {'fromTable': 'fact_sales', 'fromColumn': 'date_key', 'toTable': 'dim_date', 'toColumn': 'date_key', 'active': True},
        {'fromTable': 'fact_targets', 'fromColumn': 'date_key', 'toTable': 'dim_date', 'toColumn': 'date_key', 'active': True},
    ],
    'columnTypes': {'dim_date.full_date': 'date'},
    'measures': {
        'Total Profit': "CALCULATE(SUM('fact_sales'[profit]), 'fact_sales'[order_status] = \"Completed\")",
        'Total Revenue': "CALCULATE(SUM('fact_sales'[net_sales]), 'fact_sales'[order_status] = \"Completed\")",
        'Profit Target': "SUM('fact_targets'[profit_target])",
        'Profit Variance': 'Profit Variance = [Total Profit] - [Profit Target]',
        'Profit Margin %': 'Profit Margin % = DIVIDE([Total Profit], [Total Revenue], 0)',
        'Profit YTD': "Profit YTD = TOTALYTD([Total Profit], 'dim_date'[full_date])",
        'Executive KPI Status': 'Executive KPI Status = VAR TargetAchievement = DIVIDE([Total Profit], [Profit Target], 0) VAR MarginPerformance = [Profit Margin %] RETURN SWITCH(TRUE(), TargetAchievement >= 1 && MarginPerformance >= 0.25, "Strong", "Needs attention")',
    },
}


def test_published_dashboard_measure_set_compiles_without_false_dependencies():
    for name in MODEL['measures']:
        sql = measure(name, MODEL)
        assert 'TOTALYTD' not in sql.upper()


def test_nested_measure_dependencies_pull_all_related_tables_into_query_plan():
    sql, _ = compile_query(MODEL, {'dimensions': [], 'measures': ['Profit Variance'], 'filters': []})
    assert 'fact_sales' in sql
    assert 'fact_targets' in sql
    assert 'dim_date' in sql
