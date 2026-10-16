import pytest
duckdb = pytest.importorskip('duckdb')
from app.dax_engine import compile_dax
from app.semantic_engine import execute, compile_query

def create_sample_model():
    return {
        "tables": {
            "Lead CRM": {
                "physical": "lead_crm",
                "columns": {
                    "Patient Name": "patient_name",
                    "Location": "location",
                    "Admission Date": "admission_date",
                    "Discharge Date": "discharge_date",
                    "Amount": "amount",
                    "Date": "dt"
                }
            }
        },
        "relationships": [],
        "measures": {
            "Total_Revenue": "SUM('Lead CRM'[Amount])",
            "Active_Patients": "CALCULATE(COUNTROWS('Lead CRM'), 'Lead CRM'[Admission Date] <= TODAY() && (ISBLANK('Lead CRM'[Discharge Date]) || 'Lead CRM'[Discharge Date] >= TODAY()))",
            "Previous_Month_Revenue": "CALCULATE(SUM('Lead CRM'[Amount]), PREVIOUSMONTH('Lead CRM'[Date]))",
            "YTD_Revenue": "CALCULATE(SUM('Lead CRM'[Amount]), DATESYTD('Lead CRM'[Date]))",
            "Map_Latitude": "SWITCH('Lead CRM'[Location], 'Delhi', 28.61, 'Mumbai', 19.07, 0.0)",
            "Complex_Var_Measure": "VAR MaxDate = DATE(YEAR(MAX('Lead CRM'[Date])), 12, 31) RETURN CALCULATE(SUM('Lead CRM'[Amount]), 'Lead CRM'[Date] <= MaxDate)"
        }
    }

def setup_duckdb():
    con = duckdb.connect()
    con.execute("""
        CREATE TABLE lead_crm (
            patient_name VARCHAR,
            location VARCHAR,
            admission_date VARCHAR,
            discharge_date VARCHAR,
            amount DOUBLE,
            dt VARCHAR
        );
        INSERT INTO lead_crm VALUES
            ('John Doe', 'Delhi', '2025-01-01', '', 100.0, '2025-01-15'),
            ('Jane Smith', 'Mumbai', '2025-02-01', ' ', 200.0, '2025-02-15'),
            ('Bob Brown', 'Delhi', '2025-03-01', '2029-12-31', 150.0, '2025-03-15'),
            ('Old Patient', 'Delhi', '2020-01-01', '2021-01-01', 50.0, '2021-01-01'),
            ('Duplicate Patient', 'Delhi', '2025-01-01', NULL, 300.0, '2025-01-15'),
            ('Duplicate Patient', 'Delhi', '2025-01-01', NULL, 300.0, '2025-01-15');
    """)
    return con

def test_issue_12_active_patients():
    """Verify Active_Patients measure handles empty strings, whitespace, and NULL as blank and TRY_CAST for dates."""
    model = create_sample_model()
    con = setup_duckdb()
    sql, params = compile_query(model, {
        "dimensions": [],
        "measures": ["Active_Patients"]
    })
    rows = con.execute(sql, params).fetchall()
    # 5 active patients (John Doe, Jane Smith, Bob Brown, Duplicate Patient x2), Old Patient is discharged in 2021
    assert rows[0][0] == 5

def test_issue_13_table_visual_raw_rows_vs_slicer_distinct():
    """Verify Table visual without measures returns all raw rows (no GROUP BY), while slicer returns distinct."""
    model = create_sample_model()
    con = setup_duckdb()
    
    # Table visual query without measures
    table_req = {
        "dimensions": ["Lead CRM.Patient Name", "Lead CRM.Location"],
        "measures": [],
        "distinct": False
    }
    sql, params = compile_query(model, table_req)
    assert "GROUP BY" not in sql
    rows = con.execute(sql, params).fetchall()
    assert len(rows) == 6  # All 6 rows preserved, duplicates not collapsed
    
    # Slicer visual query with distinct=True
    slicer_req = {
        "dimensions": ["Lead CRM.Location"],
        "measures": [],
        "distinct": True
    }
    sql_slicer, params_slicer = compile_query(model, slicer_req)
    assert "GROUP BY" in sql_slicer
    rows_slicer = con.execute(sql_slicer, params_slicer).fetchall()
    assert len(rows_slicer) == 2  # Delhi, Mumbai

def test_issue_14_map_visual_unaggregated_measure():
    """Verify unaggregated measure in grouped visual query is wrapped in ANY_VALUE and does not fail DuckDB binder."""
    model = create_sample_model()
    con = setup_duckdb()
    
    map_req = {
        "dimensions": ["Lead CRM.Location"],
        "measures": ["Map_Latitude", "Total_Revenue"]
    }
    sql, params = compile_query(model, map_req)
    assert "ANY_VALUE" in sql
    rows = con.execute(sql, params).fetchall()
    assert len(rows) == 2
    # Delhi and Mumbai rows exist with latitude and revenue
    results = {r[0]: (r[1], r[2]) for r in rows}
    assert float(results["Delhi"][0]) == 28.61
    assert float(results["Mumbai"][0]) == 19.07

def test_issue_15_nested_aggregates_in_var():
    """Verify VAR with MAX(...) inside DATE() does not produce nested aggregates in CALCULATE filter."""
    model = create_sample_model()
    con = setup_duckdb()
    
    req = {
        "dimensions": ["Lead CRM.Location"],
        "measures": ["Complex_Var_Measure"]
    }
    sql, params = compile_query(model, req)
    rows = con.execute(sql, params).fetchall()
    assert len(rows) == 2

def test_issue_17_time_intelligence_previous_month():
    """Verify PREVIOUSMONTH filter compiles and executes with TRY_CAST."""
    model = create_sample_model()
    con = setup_duckdb()
    
    req = {
        "dimensions": [],
        "measures": ["Previous_Month_Revenue"]
    }
    sql, params = compile_query(model, req)
    assert "TRY_CAST" in sql
    assert "date_trunc('month'" in sql
    rows = con.execute(sql, params).fetchall()
    assert rows is not None
