from pathlib import Path


ROOT = Path(__file__).parents[2]


def test_published_viewer_applies_conditional_measure_values_to_chart_content():
    source = (ROOT / "src" / "v11" / "PublishedViewer.tsx").read_text(encoding="utf-8")
    assert "<Chart visual={displayVisual}" in source
    assert "conditionalValues={conditionalValues}" in source


def test_published_multicard_preserves_desktop_columns_and_saved_styles():
    styles = (ROOT / "src" / "styles.css").read_text(encoding="utf-8")
    assert "grid-template-columns:var(--multi-grid-columns" in styles
    assert "color:var(--multi-value-color)!important" in styles
    assert "background:var(--multi-bg)!important" in styles


def test_services_rich_text_keeps_desktop_font_markup():
    source = (ROOT / "src" / "richText.ts").read_text(encoding="utf-8")
    assert "'FONT'" in source
    assert "['color','face','size']" in source
    assert "'font-size'" in source


def test_published_pixel_canvas_does_not_add_legacy_header_over_desktop_visuals():
    source = (ROOT / "src" / "v11" / "PublishedViewer.tsx").read_text(encoding="utf-8")
    assert "!pixelLayout&&s.header?.visible!==false" in source


def test_published_report_defaults_to_desktop_fit_report_mode():
    source = (ROOT / "src" / "v11" / "PublishedViewer.tsx").read_text(encoding="utf-8")
    assert "[viewMode,setViewMode]=useState<'fitWidth'|'fitPage'|'actual'>('fitPage')" in source
    assert "setPublishedMode('interactive');setViewMode('fitPage')" in source


def test_published_multicard_density_uses_visual_container_not_browser_width():
    styles = (ROOT / "src" / "formatting-authority.css").read_text(encoding="utf-8")
    assert "@container (max-height: 260px)" in styles
    assert ".viewerVisual-multirowcard .multiCardGrid" in styles
    assert "overflow:hidden!important" in styles
