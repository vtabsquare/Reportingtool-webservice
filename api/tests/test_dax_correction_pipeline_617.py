from app import server


def subject_model():
    return {
        "tables": {"Calendar": {"physical": "calendar_data", "columns": {"Date": "Date"}}},
        "columnTypes": {"Calendar.Date": "date"},
        "measures": {"Net Revenue": "Net Revenue = 100"},
    }


def prepare(monkeypatch):
    monkeypatch.setattr(server, "_measure_system_health", lambda: {"healthy": True})
    monkeypatch.setattr(server, "_preflight_measure_visual", lambda name, model: {"visualReady": True})


def test_api_offers_corrected_measure_only_after_full_preflight(monkeypatch):
    prepare(monkeypatch)
    source = """Revenue PM =
CALCULATE(
    [Net Revenue],
    DATEADD('Calendar'[Date], -1, MONTH)
"""
    result = server._validate_dax_measure("", source, subject_model())
    assert not result["valid"]
    assert result["correction"]["available"]
    assert result["correction"]["validated"]
    assert result["correction"]["compiled"]
    assert result["correction"]["changes"] == ["Added 1 missing closing parenthesis."]
    assert not result["reconstruction"]["available"]


def test_correction_then_reconstruction_are_chained_and_preflighted(monkeypatch):
    prepare(monkeypatch)
    source = "Rounded Revenue = ROUNDUP([Net Revenue], 2"
    result = server._validate_dax_measure("", source, subject_model())
    assert not result["valid"]
    assert result["correction"]["available"]
    assert not result["correction"]["validated"]
    assert result["reconstruction"]["available"]
    assert result["reconstruction"]["validated"]
    assert "CEILING" in result["reconstruction"]["expression"]


def test_ambiguous_damage_never_enables_a_use_action(monkeypatch):
    prepare(monkeypatch)
    result = server._validate_dax_measure("", "Broken = CALCULATE([Net Revenue],", subject_model())
    assert not result["valid"]
    assert not result["correction"]["available"]
    assert not result["reconstruction"]["available"]


