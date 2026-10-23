import pytest

duckdb = pytest.importorskip("duckdb")

from app.dax_engine import diagnose_dax_definition
from app.semantic_engine import compile_query


MODEL = {
    "tables": {
        "RS Puram": {
            "physical": "rs_puram",
            "columns": {
                "Patient Name": "Patient Name",
                "Ward": "Ward",
                "Admission Date": "Admission Date",
                "Discharge Date": "Discharge Date",
            },
        }
    },
    "relationships": [],
    "measures": {
        "Max LOS": """
            Max LOS =
            VAR AdmitDate = CALCULATE ( MIN ( 'RS Puram'[Admission Date] ) )
            VAR DischargeDate = CALCULATE ( MAX ( 'RS Puram'[Discharge Date] ) )
            RETURN
                IF (
                    NOT ISBLANK ( AdmitDate )
                        && NOT ISBLANK ( DischargeDate )
                        && DischargeDate >= AdmitDate,
                    DATEDIFF ( AdmitDate, DischargeDate, DAY ),
                    BLANK ()
                )
        """,
        "Maximum Patient LOS": """
            Maximum Patient LOS =
            MAXX (
                FILTER (
                    'RS Puram',
                    NOT ISBLANK ( 'RS Puram'[Admission Date] )
                        && NOT ISBLANK ( 'RS Puram'[Discharge Date] )
                ),
                DATEDIFF (
                    'RS Puram'[Admission Date],
                    'RS Puram'[Discharge Date],
                    DAY
                )
            )
        """,
        "Summary Max LOS": """
            Summary Max LOS =
            VAR PatientLOS =
                SUMMARIZE (
                    'RS Puram',
                    'RS Puram'[Patient Name],
                    "AdmissionDate", MIN ( 'RS Puram'[Admission Date] ),
                    "DischargeDate", MAX ( 'RS Puram'[Discharge Date] ),
                    "LOS", DATEDIFF (
                        'RS Puram'[Admission Date],
                        'RS Puram'[Discharge Date],
                        DAY
                    )
                )
            RETURN MAXX ( PatientLOS, [LOS] )
        """,
        "Nested Summary Max LOS": """
            Nested Summary Max LOS =
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
            RETURN FORMAT ( MaxDays, "0" ) & " Days"
        """,
    },
}


@pytest.fixture()
def connection():
    con = duckdb.connect()
    con.execute('''
        CREATE TABLE rs_puram (
            "Patient Name" VARCHAR,
            "Ward" VARCHAR,
            "Admission Date" VARCHAR,
            "Discharge Date" VARCHAR
        );
        INSERT INTO rs_puram VALUES
            ('A', 'North', '2026-01-01', '2026-01-06'),
            ('B', 'North', '2026-02-01', '2026-02-04'),
            ('C', 'South', '2026-03-01', '2026-03-11');
    ''')
    try:
        yield con
    finally:
        con.close()


@pytest.mark.parametrize(
    ("measure_name", "expected"),
    [("Max LOS", 69), ("Maximum Patient LOS", 10)],
)
def test_los_measure_validates_and_executes_in_card(connection, measure_name, expected):
    diagnostic = diagnose_dax_definition(MODEL["measures"][measure_name])
    assert diagnostic["issues"] == []

    sql, params = compile_query(
        MODEL,
        {"dimensions": [], "measures": [measure_name], "filters": [], "limit": 10},
    )
    assert "ANY_VALUE" not in sql
    row = connection.execute(sql, params).fetchone()
    assert row is not None
    assert int(row[0]) == expected


def test_var_calculate_los_respects_grouped_visual_context(connection):
    sql, params = compile_query(
        MODEL,
        {
            "dimensions": ["RS Puram.Ward"],
            "measures": ["Max LOS"],
            "filters": [],
            "sort": [{"field": "RS Puram.Ward", "direction": "asc"}],
            "limit": 10,
        },
    )
    rows = connection.execute(sql, params).fetchall()
    assert rows == [("North", 34), ("South", 10)]


def test_los_card_sql_never_leaks_raw_date_columns_outside_aggregates(connection):
    sql, params = compile_query(
        MODEL,
        {"dimensions": [], "measures": ["Max LOS"], "filters": [], "limit": 10},
    )
    # Execution is the definitive regression check for the GROUP BY binder
    # failure shown by the desktop card visual.
    connection.execute(sql, params).fetchall()
    assert 'MIN("RS Puram"."Admission Date")' in sql
    assert 'MAX("RS Puram"."Discharge Date")' in sql


def test_summarize_extension_columns_are_safe_in_card_and_chart(connection):
    diagnostic = diagnose_dax_definition(MODEL["measures"]["Summary Max LOS"])
    assert diagnostic["issues"] == []
    card_sql, card_params = compile_query(
        MODEL,
        {"dimensions": [], "measures": ["Summary Max LOS"], "filters": [], "limit": 10},
    )
    assert int(connection.execute(card_sql, card_params).fetchone()[0]) == 10
    assert "date_diff('day',CAST(MIN(" in card_sql
    assert ",CAST(MAX(" in card_sql

    chart_sql, chart_params = compile_query(
        MODEL,
        {
            "dimensions": ["RS Puram.Ward"],
            "measures": ["Summary Max LOS"],
            "filters": [],
            "limit": 10,
        },
    )
    rows = connection.execute(chart_sql, chart_params).fetchall()
    assert len(rows) == 2


def test_nested_summarize_aliases_execute_in_a_card(connection):
    diagnostic = diagnose_dax_definition(MODEL["measures"]["Nested Summary Max LOS"])
    assert diagnostic["issues"] == []
    sql, params = compile_query(
        MODEL,
        {"dimensions": [], "measures": ["Nested Summary Max LOS"], "filters": [], "limit": 10},
    )
    row = connection.execute(sql, params).fetchone()
    assert row is not None
    assert row[0] == "10 Days"
