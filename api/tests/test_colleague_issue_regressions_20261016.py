"""Regression coverage for the evidence in Yasin - vignesh sir fixes.docx.

These tests deliberately use 241 records and the exact Active Patients DAX shape
from the report so a small synthetic happy path cannot hide row-count defects.
"""
from datetime import date, timedelta

import pytest

duckdb = pytest.importorskip("duckdb")

from app.semantic_engine import compile_query


def model():
    return {
        "tables": {
            "RS Puram": {
                "physical": "rs_puram",
                "columns": {
                    "Patient Name": "patient_name",
                    "Pain point": "pain_point",
                    "Admission Date": "admission_date",
                    "Discharge Date": "discharge_date",
                    "Region": "region",
                    "Revenue": "revenue",
                    "Date": "dt",
                },
            }
        },
        "relationships": [],
        "measures": {
            "Active Patients": """CALCULATE(
                DISTINCTCOUNT('RS Puram'[Patient Name]),
                FILTER('RS Puram',
                    'RS Puram'[Admission Date] <= TODAY() &&
                    (ISBLANK('RS Puram'[Discharge Date]) ||
                     'RS Puram'[Discharge Date] >= TODAY())
                )
            )""",
            "Total Revenue": "SUM('RS Puram'[Revenue])",
            "Current Month Revenue": "TOTALMTD([Total Revenue], 'RS Puram'[Date])",
            "Previous Month Revenue": "CALCULATE([Total Revenue], PREVIOUSMONTH('RS Puram'[Date]))",
        },
    }


@pytest.fixture()
def connection():
    con = duckdb.connect()
    con.execute("""CREATE TABLE rs_puram(
        patient_name VARCHAR, pain_point VARCHAR, admission_date VARCHAR,
        discharge_date VARCHAR, region VARCHAR, revenue DOUBLE, dt VARCHAR
    )""")
    today = date.today()
    current_month = today.replace(day=1)
    previous_month = (current_month - timedelta(days=1)).replace(day=15)
    rows = [
        (
            f"Patient {index}", f"Pain {index % 7}",
            str(today - timedelta(days=index % 30)), None if index % 3 else " ",
            ("North", "South", "East")[index % 3], float(index + 1),
            str(current_month if index % 2 else previous_month),
        )
        for index in range(241)
    ]
    con.executemany("INSERT INTO rs_puram VALUES (?,?,?,?,?,?,?)", rows)
    yield con
    con.close()


def query(connection, payload):
    sql, params = compile_query(model(), payload)
    return sql, connection.execute(sql, params).fetchall()


def test_exact_active_patient_measure_counts_241_distinct_people(connection):
    sql, rows = query(connection, {"dimensions": [], "measures": ["Active Patients"]})
    assert rows == [(241,)], sql


def test_table_keeps_all_241_source_records(connection):
    sql, rows = query(connection, {
        "dimensions": ["RS Puram.Patient Name", "RS Puram.Pain point"],
        "measures": [], "distinct": False, "limit": 5000,
    })
    assert "GROUP BY" not in sql
    assert len(rows) == 241


def test_map_region_supports_aggregated_measure(connection):
    _, rows = query(connection, {
        "dimensions": ["RS Puram.Region"],
        "measures": ["Total Revenue"], "limit": 5000,
    })
    assert len(rows) == 3
    assert sum(row[1] for row in rows) == sum(range(1, 242))


def test_text_column_count_and_distinct_count_do_not_numeric_cast(connection):
    sql, rows = query(connection, {
        "dimensions": [],
        "measures": ["RS Puram.Patient Name::count", "RS Puram.Patient Name::distinctcount"],
    })
    assert "TRY_CAST(\"RS Puram\".\"patient_name\" AS DOUBLE)" not in sql
    assert rows == [(241, 241)]


def test_current_and_previous_month_measures_are_not_blank(connection):
    _, rows = query(connection, {
        "dimensions": [],
        "measures": ["Current Month Revenue", "Previous Month Revenue"],
    })
    assert rows[0][0] is not None
    assert rows[0][1] is not None
