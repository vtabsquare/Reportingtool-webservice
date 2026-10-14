from app.dax_engine import (
    SUPPORTED_DAX_FUNCTIONS,
    compile_dax,
    dax_engine_health,
    diagnose_dax_definition,
    parse_measure_definition,
    repair_dax_definition,
)


MODEL = {
    "tables": {
        "lead_crm": {
            "physical": "lead_crm",
            "columns": {"lead_status": "lead_status", "lead_id": "lead_id"},
        }
    },
    "relationships": [],
    "measures": {"Total Leads": "Total Leads = COUNTROWS ( 'lead_crm' )"},
}


def resolver(name):
    return compile_dax(MODEL["measures"][name], MODEL, measure_resolver=resolver).sql


def test_reported_converted_leads_formula_compiles_nested_text_functions():
    expression = '''Converted Leads =
CALCULATE (
    [Total Leads],
    FILTER (
        'lead_crm',
        LOWER ( TRIM ( 'lead_crm'[lead_status] ) ) = "converted"
    )
)'''
    sql = compile_dax(expression, MODEL, measure_resolver=resolver).sql
    assert "LOWER(CAST(regexp_replace(TRIM(CAST(" in sql
    assert '"lead_crm"."lead_status"' in sql
    assert "= 'converted'" in sql
    assert "COUNT(*) FILTER" in sql


def test_text_scalar_family_compiles_recursively():
    for body, expected in [
        ('UPPER ( TRIM ( lead_crm[lead_status] ) )', 'UPPER'),
        ('LEFT ( lead_crm[lead_status], 3 )', 'LEFT'),
        ('RIGHT ( lead_crm[lead_status], 2 )', 'RIGHT'),
        ('MID ( lead_crm[lead_status], 2, 4 )', 'SUBSTR'),
        ('SUBSTITUTE ( lead_crm[lead_status], "old", "new" )', 'REPLACE'),
        ('CONCATENATE ( lead_crm[lead_status], "!" )', '||'),
        ('CONTAINSSTRING ( lead_crm[lead_status], "vert" )', 'STRPOS'),
    ]:
        sql=compile_dax(f'Test = {body}',MODEL).sql
        assert expected in sql


def test_safe_auto_repair_normalizes_locale_quotes_and_empty_first_argument():
    damaged='Converted Leads = CALCULATE (; [Total Leads]; FILTER (; \'lead_crm\'; LOWER ( TRIM ( \'lead_crm\'[lead_status] ) ) = “converted” ) )'
    repaired=repair_dax_definition(damaged)
    assert repaired['changed'] is True
    assert len(repaired['repairs']) == 3
    assert parse_measure_definition(repaired['expression'])[0] == 'Converted Leads'
    sql=compile_dax(repaired['expression'],MODEL,measure_resolver=resolver).sql
    assert "= 'converted'" in sql


def test_measure_name_percentage_remains_opaque_text():
    repaired=repair_dax_definition('Conversion % = DIVIDE ( [Total Leads], [Total Leads], 0 )')
    assert parse_measure_definition(repaired['expression'])[0] == 'Conversion %'


def test_unambiguous_function_typo_is_recovered_and_recorded():
    repaired=repair_dax_definition('Lead Count = COUNTROW ( lead_crm )')
    assert 'COUNTROWS' in repaired['expression']
    assert any('COUNTROW to COUNTROWS' in item for item in repaired['repairs'])


def test_unknown_function_fails_with_actionable_suggestions():
    diagnostic=diagnose_dax_definition('Lead Count = MYSTERYFUNC ( lead_crm[lead_id] )')
    assert diagnostic['issues'] == ['Unsupported DAX function MYSTERYFUNC.']
    assert diagnostic['unknownFunctions'] == ['MYSTERYFUNC']
    assert len(diagnostic['suggestions']['MYSTERYFUNC']) == 3


def test_engine_health_covers_every_advertised_function():
    health=dax_engine_health()
    assert health['healthy'] is True
    assert health['failures'] == []
    assert health['supportedFunctionCount'] == len(SUPPORTED_DAX_FUNCTIONS)
    assert health['checks'] >= 27


def test_known_power_bi_function_is_never_misrepaired_to_different_semantics():
    repaired=repair_dax_definition('Ranking = RANKX ( ALL ( lead_crm[source] ), [Total Leads] )')
    assert 'RANKX' in repaired['expression']
    assert not any('Corrected function name RANKX' in item for item in repaired['repairs'])


def test_three_argument_concatenate_recovers_to_concatenatex():
    repaired=repair_dax_definition('Top Source = CONCATENATE ( SourceSummary, lead_crm[source], ", " )')
    assert 'CONCATENATEX' in repaired['expression']
    assert repaired['repairs'] == ['Corrected three-argument CONCATENATE to CONCATENATEX.']


def test_topn_addcolumns_filter_and_concatenatex_compile_together():
    model={**MODEL,'measures':{'Total Enquiries':"Total Enquiries = COUNTROWS ( 'lead_crm' )"}}
    expression='''Most Enquired Source =
VAR SourceSummary =
    TOPN ( 1, FILTER ( ADDCOLUMNS ( ALL ( 'lead_crm'[lead_status] ), "EnquiryCount", [Total Enquiries] ), NOT ISBLANK ( 'lead_crm'[lead_status] ) && TRIM ( 'lead_crm'[lead_status] ) <> "" ), [EnquiryCount], DESC, 'lead_crm'[lead_status], ASC )
RETURN
    CONCATENATEX ( SourceSummary, 'lead_crm'[lead_status], ", " )'''
    def local_resolver(name):
        return compile_dax(model['measures'][name],model,measure_resolver=local_resolver).sql
    sql=compile_dax(expression,model,measure_resolver=local_resolver).sql
    assert 'string_agg' in sql
    assert 'GROUP BY' in sql
    assert 'ORDER BY' in sql
    assert 'LIMIT 1' in sql


def test_summarize_table_variables_and_virtual_iterators_compile():
    model={**MODEL}
    expression='''Most Enquired Area =
VAR AreaEnquiries = SUMMARIZE ( 'lead_crm', 'lead_crm'[lead_status], "EnquiryCount", COUNTROWS ( 'lead_crm' ) )
VAR MaxEnquiryCount = MAXX ( AreaEnquiries, [EnquiryCount] )
VAR TopAreas = FILTER ( AreaEnquiries, [EnquiryCount] = MaxEnquiryCount )
RETURN MINX ( TopAreas, 'lead_crm'[lead_status] )'''
    sql=compile_dax(expression,model).sql
    assert 'SELECT MIN' in sql and 'SELECT MAX' in sql and 'GROUP BY' in sql


def test_values_topn_calculate_context_transition_and_pasted_repairs():
    model={**MODEL,'measures':{'Total Enquiries':"Total Enquiries = COUNTROWS ( 'lead_crm' )"}}
    expression='''Most Enquired Area =
VAR AreaTable = FILTER ( VALUE ( 'lead_crm'[lead_status] ), NOT ISBLANK ( 'lead_crm'[lead_status] ) && 'lead_crm'[lead_status] <> "" )
VAR TopArea = TOPN ( 1, AreaTable, CALCULATE ( [Total Enquiries] ), DESC, 'lead_crm'[lead_status], ASC )
RETURN CONCATENATE ( TopArea, 'lead_crm'[lead_status], ", " )'''
    repaired=repair_dax_definition(expression)
    assert repaired['repairs']==[
        'Corrected scalar VALUE to table-valued VALUES inside FILTER.',
        'Corrected three-argument CONCATENATE to CONCATENATEX.',
    ]
    def local_resolver(name):
        return compile_dax(model['measures'][name],model,measure_resolver=local_resolver).sql
    sql=compile_dax(repaired['expression'],model,measure_resolver=local_resolver).sql
    assert 'SELECT DISTINCT' in sql
    assert 'IS NOT DISTINCT FROM' in sql
    assert 'ORDER BY' in sql and 'LIMIT 1' in sql and 'string_agg' in sql


def test_values_is_not_misrepaired_to_value():
    expression='Area = CONCATENATEX ( VALUES ( lead_crm[lead_status] ), lead_crm[lead_status], ", " )'
    repaired=repair_dax_definition(expression)
    assert 'VALUES' in repaired['expression']
    assert 'Corrected function name VALUES to VALUE' not in repaired['repairs']
