from app import server


def test_direct_pdf_export_falls_back_to_cloud_project(monkeypatch):
    project = {"name": "Cloud Revenue", "report": {"name": "Cloud Revenue"}}
    monkeypatch.setattr(server, "_enforce_viewer_block", lambda authorization, report_id: None)
    monkeypatch.setattr(server.store, "get_published", lambda report_id: None)
    monkeypatch.setattr(server, "_get_cloud_project", lambda report_id: project)
    monkeypatch.setattr(server, "report_pdf", lambda value: b"%PDF-cloud")

    response = server.export_published("cloud-report", "pdf", authorization=None)

    assert response.body == b"%PDF-cloud"
    assert response.media_type == "application/pdf"
    assert "Cloud_Revenue.pdf" in response.headers["content-disposition"]


def test_direct_pptx_export_falls_back_to_cloud_project(monkeypatch):
    project = {"name": "Cloud Revenue", "report": {"name": "Cloud Revenue"}}
    monkeypatch.setattr(server, "_enforce_viewer_block", lambda authorization, report_id: None)
    monkeypatch.setattr(server.store, "get_published", lambda report_id: None)
    monkeypatch.setattr(server, "_get_cloud_project", lambda report_id: project)
    monkeypatch.setattr(server, "report_pptx", lambda value: b"PK-cloud")

    response = server.export_published("cloud-report", "pptx", authorization=None)

    assert response.body == b"PK-cloud"
    assert response.media_type == "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    assert "Cloud_Revenue.pptx" in response.headers["content-disposition"]
