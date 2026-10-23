from app.dax_v2 import analyze_measure, correct_measure, reconstruct_measure
from app.semantic_engine import measure


def model():
    return {
        "tables": {"GlobalSales": {"physical": "global_sales", "columns": {"Country": "Country", "Net_Sales_USD": "Net_Sales_USD"}}},
        "columnTypes": {"GlobalSales.Country": "text", "GlobalSales.Net_Sales_USD": "decimal"},
        "measures": {"Total Net Sales": "Total Net Sales = SUM(GlobalSales[Net_Sales_USD])"},
    }


def test_allselected_returns_reviewable_contextual_proposal_that_revalidates():
    source = """Unsupported Power BI Function Test =
CALCULATE (
    [Total Net Sales],
    ALLSELECTED ( GlobalSales[Country] )
)"""
    original = analyze_measure(source, model())
    assert not original.valid
    proposal = reconstruct_measure(source)
    assert proposal.available
    assert proposal.equivalence == "contextual"
    assert "REMOVEFILTERS" in proposal.expression
    assert proposal.warnings
    assert analyze_measure(proposal.expression, model()).valid


def test_counta_is_reconstructed_exactly_with_supported_functions():
    proposal = reconstruct_measure("Named Countries = COUNTA(GlobalSales[Country])")
    assert proposal.available
    assert proposal.equivalence == "exact"
    assert "COUNTROWS" in proposal.expression and "FILTER" in proposal.expression
    assert analyze_measure(proposal.expression, model()).valid


def test_unreliable_function_is_not_silently_changed():
    proposal = reconstruct_measure("Relationship Test = USERELATIONSHIP(GlobalSales[Country], GlobalSales[Country])")
    assert not proposal.available
    assert proposal.expression == ""
    assert proposal.unsupported_functions == ["USERELATIONSHIP"]


def test_roundup_reconstruction_passes_the_runtime_compiler_not_only_the_binder():
    source = """Rounded Average Order Value =
ROUNDUP(DIVIDE(SUM(GlobalSales[Net_Sales_USD]), SUM(GlobalSales[Order_Count]), 0), 2)"""
    subject = model()
    subject["tables"]["GlobalSales"]["columns"]["Order_Count"] = "Order_Count"
    subject["columnTypes"]["GlobalSales.Order_Count"] = "integer"
    proposal = reconstruct_measure(source)
    assert proposal.available and proposal.equivalence == "exact"
    assert "0.01" in proposal.expression
    subject["measures"]["Rounded Average Order Value"] = proposal.expression
    compiled = measure("Rounded Average Order Value", subject)
    assert "CEIL" in compiled and "POWER" not in compiled


def test_missing_parenthesis_is_corrected_before_reconstruction():
    subject = {
        "tables": {"Calendar": {"physical": "calendar_data", "columns": {"Date": "Date"}}},
        "columnTypes": {"Calendar.Date": "date"},
        "measures": {"Net Revenue": "Net Revenue = 100"},
    }
    proposal = correct_measure("Revenue PM = CALCULATE([Net Revenue], DATEADD('Calendar'[Date], -1, MONTH)", subject)
    assert proposal.available
    assert proposal.changes == ["Added 1 missing closing parenthesis."]
    assert analyze_measure(proposal.expression, subject).valid


def test_unique_typos_are_corrected_but_ambiguous_damage_is_not_guessed():
    proposal = correct_measure("Typo = CALCULAT([Total Net Sale], SUM(GlobalSale[Net_Sale_USD]))", model())
    assert proposal.available and analyze_measure(proposal.expression, model()).valid
    ambiguous = correct_measure("Broken = CALCULATE([Total Net Sales],", model())
    assert not ambiguous.available
