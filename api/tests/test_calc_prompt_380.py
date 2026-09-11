import pytest
from app.transform_engine import suggest_calculated_column, compile_row_expression

COLS=['OrderID','OrderDate','ShipDate','CustomerID','ProductID','Quantity']

def test_customer_id_three_chars_from_left_is_grounded_exactly():
    r=suggest_calculated_column('Delimit CustomerID 3 digit from left',COLS)
    assert r['grounding']==['CustomerID']
    assert r['expression']=='LEFT(CAST([CustomerID] AS VARCHAR), 3)'
    assert 'LEFT(CAST("CustomerID" AS VARCHAR), 3)'==compile_row_expression(r['expression'],COLS)

def test_last_chars_are_supported():
    r=suggest_calculated_column('extract last 3 chars from OrderID',COLS)
    assert r['grounding']==['OrderID']
    assert r['expression']=='RIGHT(CAST([OrderID] AS VARCHAR), 3)'

def test_ambiguous_prompt_fails_safe_instead_of_identity_formula():
    with pytest.raises(ValueError,match='could not determine'):
        suggest_calculated_column('do something with CustomerID',COLS)

def test_business_language_arithmetic_compiles_without_false_validation_error():
    cols=['Quantity','UnitPrice','OrderDate']
    result=suggest_calculated_column('Create Total Cost by multiplying Quantity by UnitPrice',cols)
    assert result['grounding']==['Quantity','UnitPrice']
    compiled=compile_row_expression(result['expression'],cols)
    assert '"Quantity"' in compiled and '"UnitPrice"' in compiled and '*' in compiled

def test_numeric_difference_is_not_misclassified_as_date_difference():
    cols=['Quantity','UnitPrice','OrderDate']
    result=suggest_calculated_column('difference between Quantity and UnitPrice',cols)
    assert result['grounding']==['Quantity','UnitPrice']
    assert '-' in compile_row_expression(result['expression'],cols)
