from app.transform_engine import compile_row_expression,suggest_calculated_column

COLS=['Key','Status','Story Points','Days Open','Created','Updated','Assignee']

def test_row_expression_columns_and_if():
    sql=compile_row_expression("IF([Status] = 'Done', 'Closed', 'Open')",COLS)
    assert '"Status"' in sql
    assert 'IF(' in sql

def test_row_expression_math_and_null():
    sql=compile_row_expression('COALESCE([Story Points], 0) * COALESCE([Days Open], 0)',COLS)
    assert '"Story Points"' in sql and '"Days Open"' in sql

def test_row_expression_rejects_query_sql():
    try:
        compile_row_expression('SELECT * FROM x',COLS)
    except ValueError as e:
        assert 'row-level' in str(e)
    else:
        raise AssertionError('unsafe query should be rejected')

def test_ai_if_else_grounding():
    r=suggest_calculated_column('if Status is Done then Closed else Open',COLS)
    assert '[Status]' in r['expression']
    assert 'IF(' in r['expression']

def test_ai_date_difference_grounding():
    r=suggest_calculated_column('days between Created and Updated',COLS)
    assert '[Created]' in r['expression'] and '[Updated]' in r['expression']
    assert 'DATE_DIFF' in r['expression']

def test_ai_null_replacement():
    r=suggest_calculated_column('replace null Days Open with 0',COLS)
    assert 'COALESCE' in r['expression'] and '[Days Open]' in r['expression']
