from app.dax_engine import compile_dax


MODEL = {
    'tables': {
        'Sales': {
            'physical': 'fact_sales',
            'columns': {
                'OrderDate': 'order_date',
                'Amount': 'amount',
                'Country': 'country',
            },
        },
    },
    'relationships': [],
    'columnTypes': {'Sales.OrderDate': 'date', 'Sales.Amount': 'DOUBLE'},
    'measures': {},
}


def test_datesbetween_accepts_scalar_date_expressions():
    expression = '''Rolling =
    CALCULATE (
        SUM ( Sales[Amount] ),
        DATESBETWEEN ( Sales[OrderDate], DATE ( 2025, 1, 1 ), TODAY () )
    )'''
    compiled = compile_dax(expression, MODEL)
    assert 'make_date' in compiled.sql
    assert 'current_date' in compiled.sql
    assert 'Sales.OrderDate' in compiled.override_fields


def test_datesinperiod_accepts_expression_anchor_and_quarters():
    expression = '''Quarter Window =
    CALCULATE (
        SUM ( Sales[Amount] ),
        DATESINPERIOD ( Sales[OrderDate], EOMONTH ( TODAY (), 0 ), -2, QUARTER )
    )'''
    compiled = compile_dax(expression, MODEL)
    assert "INTERVAL '-6 month'" in compiled.sql
    assert 'last_day' in compiled.sql


def test_variables_are_case_insensitive_in_switch_and_calculate():
    expression = '''Band =
    VAR CutOff = 100
    VAR CurrentValue = SUM ( Sales[Amount] )
    RETURN
        SWITCH (
            TRUE (),
            currentvalue >= cutoff,
                CALCULATE ( CurrentValue, Sales[Country] <> "India" ),
            0
        )'''
    compiled = compile_dax(expression, MODEL)
    assert 'CASE WHEN' in compiled.sql
    assert 'FILTER (WHERE' in compiled.sql
    assert "'India'" in compiled.sql


def test_datediff_compiles_inside_a_variable_expression():
    expression = '''Days Selected =
    VAR FirstDay = MIN ( Sales[OrderDate] )
    VAR LastDay = MAX ( Sales[OrderDate] )
    RETURN DATEDIFF ( FirstDay, LastDay, DAY )'''
    compiled = compile_dax(expression, MODEL)
    assert "date_diff('day'" in compiled.sql


