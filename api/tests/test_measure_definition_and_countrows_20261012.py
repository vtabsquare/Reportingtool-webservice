from pathlib import Path
import sys
from types import ModuleType

from app.dax_engine import compile_dax, parse_measure_definition

# semantic_engine imports the physical DuckDB/Pandas adapter, but these compiler
# regressions are intentionally pure and do not open a database.
local_engine_stub=ModuleType("app.local_engine")
local_engine_stub.connect=lambda: None
local_engine_stub.ensure_analytics_ready=lambda: None
sys.modules.setdefault("app.local_engine",local_engine_stub)
from app.semantic_engine import measure, required


MODEL = {
    "tables": {
        "fact_transaction": {
            "physical": "fact_transaction",
            "columns": {
                "transaction_status": "transaction_status",
                "transaction_id": "transaction_id",
            },
        },
        "fact_attendance": {
            "physical": "fact_attendance",
            "columns": {
                "attendance_status": "attendance_status",
                "attendance_id": "attendance_id",
            },
        },
    },
    "relationships": [],
    "measures": {
        "Total Transactions": "Total Transactions = COUNTROWS ( fact_transaction )",
        "Total Attendance Records": "Total Attendance Records = COUNTROWS ( fact_attendance )",
        "Successful Transactions": """Successful Transactions =
CALCULATE (
    [Total Transactions],
    fact_transaction[transaction_status] = "Success"
)""",
        "Present Count": """Present Count =
CALCULATE (
    [Total Attendance Records],
    fact_attendance[attendance_status] = "Present"
)""",
    },
}


def test_measure_name_comes_from_definition_left_hand_side():
    assert parse_measure_definition("Present Count =\nCOUNTROWS ( fact_attendance )") == (
        "Present Count",
        "COUNTROWS ( fact_attendance )",
    )
    assert parse_measure_definition("Attendance % = DIVIDE ( [Present], [Total], 0 )")[0] == "Attendance %"
    assert parse_measure_definition("CALCULATE ( [Sales], Sales[Status] = \"Open\" )") is None


def test_averagx_accepts_nested_divide_row_expression():
    exam_model={
        "tables":{
            "fact_exam_result":{
                "physical":"fact_exam_result",
                "columns":{"marks_obtained":"marks_obtained","maximum_marks":"maximum_marks"},
            }
        },
        "relationships":[],
        "measures":{},
    }
    sql=compile_dax(
        """Average Marks Percentage =
AVERAGEX (
    fact_exam_result,
    DIVIDE ( fact_exam_result[marks_obtained], fact_exam_result[maximum_marks] )
)""",
        exam_model,
    ).sql
    assert sql.startswith("AVG(")
    assert "COALESCE" in sql
    assert '"fact_exam_result"."marks_obtained"' in sql
    assert '"fact_exam_result"."maximum_marks"' in sql


def test_countrows_routes_through_dax_compiler_and_owns_from_table():
    assert measure("Total Transactions", MODEL) == "COUNT(*)"
    assert required(MODEL, [], ["Total Transactions"], []) == {"fact_transaction"}


def test_calculate_accepts_measure_reference_as_base_expression():
    successful = measure("Successful Transactions", MODEL)
    present = measure("Present Count", MODEL)
    assert "COUNT(*) FILTER" in successful
    assert '"fact_transaction"."transaction_status" = \'Success\'' in successful
    assert "COUNT(*) FILTER" in present
    assert '"fact_attendance"."attendance_status" = \'Present\'' in present


def test_measure_editor_uses_formula_name_without_second_name_input():
    source = (Path(__file__).parents[2] / "src" / "v11" / "MeasuresWorkbench.tsx").read_text(encoding="utf-8")
    assert "function parseMeasureDefinition" in source
    assert "<label>Measure name<input" not in source
    assert "top-level = on the first line" in source
    assert "RELATEDTABLE" not in source
    assert "Start the formula with a measure name followed by =" in source
    assert "JSON.stringify({expression,project})" in source
