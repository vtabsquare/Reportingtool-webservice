from app.dax_v2 import analyze_measure, engine_health
from app.dax_v2.service import artifact


def model():
    return {
        "tables": {
            "Sales": {"physical": "sales", "columns": {"Amount": "Amount", "Region": "Region"}},
            "RS Puram": {"physical": "rs", "columns": {"Patient Name": "Patient Name", "Admission Date": "Admission Date", "Discharge Date": "Discharge Date"}},
        },
        "columnTypes": {
            "Sales.Amount": "decimal",
            "Sales.Region": "text",
            "RS Puram.Admission Date": "date",
            "RS Puram.Discharge Date": "date",
            "RS Puram.Patient Name": "text",
        },
        "measures": {"Total Sales": "SUM(Sales[Amount])"},
    }


def test_parser_binder_and_stable_dependencies():
    subject = model()
    result = analyze_measure("East Sales = CALCULATE([Total Sales], Sales[Region] = \"East\")", subject)
    assert result.valid, [item.message for item in result.diagnostics]
    assert result.result_kind == "scalar"
    assert result.dependencies["columns"][0]["name"] == "Region"
    assert result.dependencies["measures"][0]["name"] == "Total Sales"
    first_id = result.dependencies["columns"][0]["id"]
    assert analyze_measure("East Sales = CALCULATE([Total Sales], Sales[Region] = \"East\")", subject).dependencies["columns"][0]["id"] == first_id


def test_complex_average_los_formula_is_parsed_without_regex_repairs():
    source = '''Avg LOS =
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
RETURN
    FORMAT ( AvgDays, "0" ) & " Days"'''
    result = analyze_measure(source, model())
    assert result.valid, [item.message for item in result.diagnostics]
    assert result.result_type == "text"
    assert {item["name"] for item in result.dependencies["columns"]} == {"Admission Date", "Discharge Date"}


def test_table_variable_and_virtual_column_lineage_are_accepted():
    source = '''Summary LOS =
VAR PatientLOS =
    SUMMARIZE (
        'RS Puram',
        'RS Puram'[Admission Date],
        "LOS", DATEDIFF('RS Puram'[Admission Date], 'RS Puram'[Discharge Date], DAY)
    )
RETURN MAXX(PatientLOS, [LOS])'''
    result = analyze_measure(source, model())
    assert result.valid, [item.message for item in result.diagnostics]
    assert result.result_kind == "scalar"


def test_nested_summarize_aliases_are_visible_to_addcolumns_and_maxx():
    source = '''Max LOS =
VAR PatientLOS =
    ADDCOLUMNS (
        SUMMARIZE (
            ALL ( 'RS Puram' ),
            'RS Puram'[Patient Name],
            "AdmissionDate", MIN ( 'RS Puram'[Admission Date] ),
            "DischargeDate", MAX ( 'RS Puram'[Discharge Date] )
        ),
        "LOS", DATEDIFF ( [AdmissionDate], [DischargeDate], DAY )
    )
VAR MaxDays = MAXX ( PatientLOS, [LOS] )
RETURN FORMAT ( MaxDays, "0" ) & " Days"'''
    result = analyze_measure(source, model())
    assert result.valid, [item.message for item in result.diagnostics]
    assert result.result_type == "text"


def test_single_quoted_virtual_column_alias_has_a_clear_correction():
    source = "Broken = MAXX ( ADDCOLUMNS ( 'RS Puram', 'LOS', 1 ), [LOS] )"
    result = analyze_measure(source, model())
    assert not result.valid
    diagnostic = next(item for item in result.diagnostics if item.code == "DAX1014")
    assert 'double quotes' in diagnostic.message
    assert diagnostic.suggestion == 'Use "LOS" instead of \'LOS\'.'
    assert not any('Unknown measure' in item.message for item in result.diagnostics)


def test_safe_compatibility_lowering_and_honest_rejection():
    lowered = analyze_measure('Label = CONCATENATE("Sales: ", FORMAT([Total Sales], "#,##0"))', model())
    assert lowered.valid
    assert " & " in lowered.canonical_source
    assert lowered.rewrites

    unsupported = analyze_measure("Scoped = ALLSELECTED(Sales[Region])", model())
    assert not unsupported.valid
    assert any(item.code == "DAX1006" for item in unsupported.diagnostics)

    calculated_column = analyze_measure("Row Amount = Sales[Amount] * 2", model())
    assert not calculated_column.valid
    assert any(item.code == "DAX1013" and "Transform Data" in (item.suggestion or "") for item in calculated_column.diagnostics)


def test_artifact_contains_ast_dependencies_and_versions():
    result = analyze_measure("Total Amount = SUM(Sales[Amount])", model())
    compiled = artifact(result, 7)
    assert compiled["status"] == "validated"
    assert compiled["modelVersion"] == 7
    assert compiled["formulaHash"]
    assert compiled["ast"]["node"] == "MeasureDefinition"


def test_engine_health():
    assert engine_health()["healthy"] is True


def test_unknown_table_diagnostic_recommends_the_loaded_table():
    subject = {
        "tables": {
            "global_sales_map_test_data": {
                "physical": "global_sales_map_test_data",
                "columns": {"Net_Sales_USD": "Net_Sales_USD"},
            }
        },
        "columnTypes": {"global_sales_map_test_data.Net_Sales_USD": "decimal"},
        "measures": {},
    }
    result = analyze_measure("Total Net Sales = SUM(GlobalSales[Net_Sales_USD])", subject)
    diagnostic = next(item for item in result.diagnostics if item.code == "DAX1002")
    assert result.valid is False
    assert "global_sales_map_test_data" in (diagnostic.suggestion or "")
