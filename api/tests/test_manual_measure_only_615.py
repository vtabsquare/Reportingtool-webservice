from pathlib import Path


def test_services_does_not_expose_ai_measure_generation():
    server = (Path(__file__).parents[1] / "app" / "server.py").read_text(encoding="utf-8")
    assert "/api/v1/measures/ai-generate" not in server
    assert "suggest_measure_from_prompt" not in server


def test_services_contains_semantic_dax_v2_runtime():
    app = Path(__file__).parents[1] / "app"
    semantic = (app / "semantic_engine.py").read_text(encoding="utf-8")
    assert "from .dax_v2 import analyze_measure" in semantic
    assert "compile_for_duckdb" in semantic
    assert (app / "dax_v2" / "binder.py").exists()
    assert (app / "dax_v2" / "reconstruction.py").exists()
