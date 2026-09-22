from __future__ import annotations

import copy
import re
from datetime import datetime, timezone
from io import BytesIO
from typing import Any
from xml.sax.saxutils import escape

from .semantic_engine import execute


class PaginatedReportError(ValueError):
    pass


def _definition(project: dict[str, Any], definition_id: str) -> dict[str, Any]:
    reports = project.get("paginatedReports") or []
    item = next((report for report in reports if str(report.get("id")) == str(definition_id)), None)
    if not item:
        raise PaginatedReportError("The requested paginated report definition was not found. Publish the report again.")
    if not (item.get("table") or {}).get("columns"):
        raise PaginatedReportError("The paginated report has no table columns.")
    return copy.deepcopy(item)


def _expression(text: Any, *, definition: dict[str, Any], parameters: dict[str, Any], filters: list[dict[str, Any]], page_number: int = 1, total_pages: int = 1, record_count: int = 0) -> str:
    value = str(text or "")
    now = datetime.now(timezone.utc)
    filter_values = {str(item.get("field") or "").split(".")[-1]: item.get("value") for item in filters}
    builtins: dict[str, Any] = {
        "Report.Name": definition.get("name") or "Paginated Report",
        "Report.ExecutionTime": now.astimezone().strftime("%Y-%m-%d %H:%M:%S"),
        "Report.ExecutionDate": now.astimezone().strftime("%Y-%m-%d"),
        "Report.PageNumber": page_number,
        "Report.TotalPages": total_pages,
        "Report.RenderFormat": "PDF",
        "Dataset.RecordCount": record_count,
    }
    builtins.update({f"Parameter.{key}": val for key, val in parameters.items()})
    builtins.update({f"Filter.{key}": val for key, val in filter_values.items()})

    def replace(match: re.Match[str]) -> str:
        key = match.group(1).strip()
        resolved = builtins.get(key, match.group(0))
        if isinstance(resolved, list):
            return ", ".join(map(str, resolved))
        return str(resolved if resolved is not None else "")

    return re.sub(r"\{\{\s*([^}]+?)\s*\}\}", replace, value)


def _page_size(definition: dict[str, Any]):
    from reportlab.lib.pagesizes import A3, A4, LEGAL, LETTER, landscape, portrait
    from reportlab.lib.units import mm

    page = definition.get("page") or {}
    named = {"A4": A4, "A3": A3, "Letter": LETTER, "Legal": LEGAL}
    size = named.get(page.get("size"))
    if not size:
        width = float(page.get("widthMm") or 210) * mm
        height = float(page.get("heightMm") or 297) * mm
        if width <= 0 or height <= 0:
            raise PaginatedReportError("The custom page size is invalid.")
        size = (width, height)
    return landscape(size) if page.get("orientation") == "landscape" else portrait(size)


def _safe_filename(template: str, *, definition: dict[str, Any], parameters: dict[str, Any], filters: list[dict[str, Any]]) -> str:
    name = _expression(template or "{{Report.Name}}.pdf", definition=definition, parameters=parameters, filters=filters)
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", name).strip(" .")
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return name[:180] or "Paginated_Report.pdf"


def render_paginated_pdf(project: dict[str, Any], definition_id: str, *, filter_context: list[dict[str, Any]] | None = None, parameters: dict[str, Any] | None = None, role_id: str | None = None) -> tuple[bytes, str, int]:
    try:
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.pdfbase.pdfmetrics import stringWidth
        from reportlab.pdfgen import canvas
        from reportlab.platypus import KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    except ImportError as error:
        raise PaginatedReportError(f"PDF rendering is unavailable because ReportLab is not installed. ({error})") from error

    definition = _definition(project, definition_id)
    filters = [*(definition.get("filters") or []), *(filter_context or [])]
    parameter_values = {str(item.get("name")): item.get("defaultValue") for item in definition.get("parameters") or []}
    parameter_values.update(parameters or {})
    columns = (definition.get("table") or {}).get("columns") or []
    measures_registry = (project.get("model") or {}).get("measures") or {}
    dimensions = [column["field"] for column in columns if column.get("field") not in measures_registry]
    measures = [column["field"] for column in columns if column.get("field") in measures_registry]
    rules: list[dict[str, Any]] = []
    if role_id:
        role = next((item for item in (project.get("security") or {}).get("roles", []) if item.get("id") == role_id), None)
        rules = role.get("rules", []) if role else []
    query = {"dimensions": dimensions, "measures": measures, "filters": filters, "sort": (definition.get("table") or {}).get("sort") or [], "limit": 100000, "roleId": role_id}
    try:
        rows, _sql = execute(project.get("model") or {}, query, rules)
    except Exception as error:
        raise PaginatedReportError(f"The paginated dataset could not be executed: {error}") from error

    page = definition.get("page") or {}
    margins = page.get("margins") or {}
    page_size = _page_size(definition)
    left = float(margins.get("left") or 12) * mm
    right = float(margins.get("right") or 12) * mm
    top = float(margins.get("top") or 12) * mm
    bottom = float(margins.get("bottom") or 12) * mm
    header_height = float(page.get("headerHeightMm") or 0) * mm if (definition.get("header") or {}).get("visible", True) else 0
    footer_height = float(page.get("footerHeightMm") or 0) * mm if (definition.get("footer") or {}).get("visible", True) else 0
    buffer = BytesIO()

    class NumberedCanvas(canvas.Canvas):
        def __init__(self, *args, **kwargs):
            canvas.Canvas.__init__(self, *args, **kwargs)
            self._saved_page_states: list[dict[str, Any]] = []

        def showPage(self):
            self._saved_page_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._saved_page_states)
            for state in self._saved_page_states:
                self.__dict__.update(state)
                draw_bands(self, self._pageNumber, total)
                canvas.Canvas.showPage(self)
            canvas.Canvas.save(self)

    alignments = {"left": TA_LEFT, "center": TA_CENTER, "right": TA_RIGHT}

    def draw_band_items(pdf, items: list[dict[str, Any]], y: float, height: float):
        cursor = left
        available = page_size[0] - left - right
        for item in items:
            width = available * float(item.get("widthPercent") or 100) / 100
            kind = item.get("type") or "text"
            color = colors.HexColor(item.get("color") or "#111827")
            if kind == "line":
                pdf.setStrokeColor(color);pdf.line(cursor, y + height / 2, cursor + width, y + height / 2)
            elif kind == "shape":
                pdf.setStrokeColor(color);pdf.rect(cursor, y + 3, width, max(1, height - 6), stroke=1, fill=0)
            elif kind == "text":
                text = _expression(item.get("value"), definition=definition, parameters=parameter_values, filters=filters, page_number=pdf._pageNumber, total_pages=len(pdf._saved_page_states), record_count=len(rows))
                size = float(item.get("fontSize") or 9);pdf.setFont("Helvetica-Bold" if item.get("bold") else "Helvetica", size);pdf.setFillColor(color)
                baseline = y + max(2, (height - size) / 2)
                align = item.get("align") or "left"
                if align == "right":pdf.drawRightString(cursor + width, baseline, text)
                elif align == "center":pdf.drawCentredString(cursor + width / 2, baseline, text)
                else:pdf.drawString(cursor, baseline, text)
            cursor += width

    def draw_bands(pdf, page_number: int, total_pages: int):
        del page_number, total_pages
        height = page_size[1]
        header = definition.get("header") or {}
        footer = definition.get("footer") or {}
        if header.get("visible", True):draw_band_items(pdf, header.get("items") or [], height - top - header_height, header_height)
        if footer.get("visible", True):draw_band_items(pdf, footer.get("items") or [], bottom, footer_height)

    document = SimpleDocTemplate(buffer, pagesize=page_size, leftMargin=left, rightMargin=right, topMargin=top + header_height, bottomMargin=bottom + footer_height, title=definition.get("name") or "Paginated Report")
    table_definition = definition.get("table") or {}
    header_style = ParagraphStyle("PaginatedHeader", fontName="Helvetica-Bold", fontSize=float(table_definition.get("fontSize") or 9), leading=float(table_definition.get("fontSize") or 9) * 1.25, textColor=colors.HexColor(table_definition.get("headerColor") or "#111827"))
    body_styles = {name: ParagraphStyle(f"PaginatedBody{name}", fontName="Helvetica", fontSize=float(table_definition.get("fontSize") or 9), leading=float(table_definition.get("fontSize") or 9) * 1.25, textColor=colors.HexColor(table_definition.get("bodyColor") or "#1f2937"), alignment=alignment) for name, alignment in alignments.items()}
    data = [[Paragraph(escape(str(column.get("label") or column.get("field") or "")), header_style) for column in columns]]
    for row in rows:
        data.append([Paragraph(escape(str(row.get(column.get("field"), "") if row.get(column.get("field"), "") is not None else "")), body_styles.get(column.get("align") or "left", body_styles["left"])) for column in columns])
    widths = [float(column.get("widthMm") or 30) * mm for column in columns]
    max_width = page_size[0] - left - right
    total_width = sum(widths) or max_width
    if total_width > max_width:
        ratio = max_width / total_width;widths = [value * ratio for value in widths]
    style = TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(table_definition.get("headerBackground") or "#e8eef7")),
        ("GRID", (0, 0), (-1, -1), .5, colors.HexColor(table_definition.get("borderColor") or "#cbd5e1")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 1), (-1, -1), 3),("BOTTOMPADDING", (0, 1), (-1, -1), 3),
    ])
    if table_definition.get("alternateRows", True):style.add("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor(table_definition.get("alternateBackground") or "#f8fafc")])
    story: list[Any] = []
    pagination = definition.get("pagination") or {}
    mode = pagination.get("mode") or "automatic"
    repeat_rows = 1 if table_definition.get("repeatHeader", True) else 0

    def append_table(block: list[list[Any]]):
        story.append(Table(block, colWidths=widths, repeatRows=repeat_rows, style=style, splitByRow=1))

    if not rows:
        story.append(Paragraph("No data matched the selected filters.", body_styles["left"]))
    elif mode == "rows":
        per_page = max(1, int(pagination.get("rowsPerPage") or 25))
        for offset in range(1, len(data), per_page):
            append_table([data[0], *data[offset:offset + per_page]])
            if offset + per_page < len(data):story.append(PageBreak())
    elif mode == "group" and table_definition.get("groupBy"):
        group_field = table_definition["groupBy"]
        groups: dict[str, list[list[Any]]] = {}
        for index, row in enumerate(rows, 1):groups.setdefault(str(row.get(group_field, "")), []).append(data[index])
        for group_index, (group_name, group_rows) in enumerate(groups.items()):
            story.append(KeepTogether([Paragraph(group_name or "(Blank)", header_style), Spacer(1, 2 * mm)]))
            append_table([data[0], *group_rows])
            if group_index < len(groups) - 1:story.append(PageBreak())
    else:
        append_table(data)
    try:
        document.build(story, canvasmaker=NumberedCanvas)
    except Exception as error:
        raise PaginatedReportError(f"PDF layout or rendering failed: {error}") from error
    filename = _safe_filename((definition.get("rendering") or {}).get("fileNameTemplate") or "{{Report.Name}}.pdf", definition=definition, parameters=parameter_values, filters=filters)
    return buffer.getvalue(), filename, len(rows)
