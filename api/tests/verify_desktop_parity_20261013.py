"""Focused smoke checks for the Desktop-to-Services parity merge.

This module intentionally uses plain assertions so it can run in the packaged
Python environment even when pytest is not installed.
"""
from pathlib import Path
import sys
from types import ModuleType

from app.dax_engine import compile_dax, parse_measure_definition

local_engine_stub = ModuleType("app.local_engine")
local_engine_stub.connect = lambda: None
local_engine_stub.ensure_analytics_ready = lambda: None
sys.modules.setdefault("app.local_engine", local_engine_stub)
from app.semantic_engine import measure, required


MODEL = {
    "tables": {
        "fact_transaction": {
            "physical": "fact_transaction",
            "columns": {"transaction_status": "transaction_status"},
        },
        "fact_attendance": {
            "physical": "fact_attendance",
            "columns": {"attendance_status": "attendance_status"},
        },
    },
    "relationships": [],
    "measures": {
        "Total Transactions": "Total Transactions = COUNTROWS ( fact_transaction )",
        "Successful Transactions": "Successful Transactions = CALCULATE ( [Total Transactions], fact_transaction[transaction_status] = \"Success\" )",
    },
}


def run():
    parsed = parse_measure_definition("Attendance % = DIVIDE ( [Present], [Total], 0 )")
    assert parsed == ("Attendance %", "DIVIDE ( [Present], [Total], 0 )")
    assert parse_measure_definition('CALCULATE ( [Sales], Sales[Status] = "Open" )') is None

    exam_model = {
        "tables": {
            "fact_exam_result": {
                "physical": "fact_exam_result",
                "columns": {"marks_obtained": "marks_obtained", "maximum_marks": "maximum_marks"},
            }
        },
        "relationships": [],
        "measures": {},
    }
    sql = compile_dax(
        "Average Marks Percentage = AVERAGEX ( fact_exam_result, DIVIDE ( fact_exam_result[marks_obtained], fact_exam_result[maximum_marks] ) )",
        exam_model,
    ).sql
    assert sql.startswith("AVG(") and "COALESCE" in sql
    assert measure("Total Transactions", MODEL) == "COUNT(*)"
    assert required(MODEL, [], ["Total Transactions"], []) == {"fact_transaction"}
    assert "COUNT(*) FILTER" in measure("Successful Transactions", MODEL)

    root = Path(__file__).parents[2]
    viewer = (root / "src" / "v11" / "PublishedViewer.tsx").read_text(encoding="utf-8")
    styles = (root / "src" / "styles.css").read_text(encoding="utf-8")
    assert "className=\"viewerShapeObject\"" in viewer
    assert "shapeFillVisible" in viewer and "shapeCornerRadius" in viewer
    assert "useState<'fitWidth'|'fitPage'|'actual'>('fitWidth')" in viewer
    assert "left:v.x,top:v.y,width:v.w,height:v.h" in viewer
    assert ".shapeObject,.viewerShapeObject" in styles
    assert ".pixelPublishedPage .viewerVisual-card .powerCardGrid" in styles


if __name__ == "__main__":
    run()
    print("Desktop-to-Services parity checks passed.")
