from __future__ import annotations

import copy
import base64
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


def _parameter_label(parameter: dict[str, Any], value: Any) -> str:
    available = (parameter.get("availableValues") or {}).get("staticValues") or []
    if not available:
        available = [{"value": item, "label": str(item)} for item in (parameter.get("values") or [])]
    values = value if isinstance(value, list) else [value]
    labels = []
    for current in values:
        option = next((item for item in available if str(item.get("value")) == str(current)), None)
        labels.append(str(option.get("label") if option else current if current is not None else ""))
    return ", ".join(item for item in labels if item)


def _expression(text: Any, *, definition: dict[str, Any], parameters: dict[str, Any], filters: list[dict[str, Any]], page_number: int = 1, total_pages: int = 1, record_count: int = 0, first_row: dict[str, Any] | None = None) -> str:
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
    parameter_definitions = {str(item.get("name")): item for item in definition.get("parameters") or []}
    for key, val in parameters.items():
        label = _parameter_label(parameter_definitions.get(str(key), {}), val)
        builtins[f"Parameter.{key}"] = val
        builtins[f"Parameter.{key}.Value"] = val
        builtins[f"Parameter.{key}.Label"] = label
        builtins[f"Parameters.{key}.Value"] = val
        builtins[f"Parameters.{key}.Label"] = label
    builtins.update({f"Filter.{key}": val for key, val in filter_values.items()})
    for key, val in (first_row or {}).items():
        builtins[f"Dataset.First.{key}"] = val
        builtins.setdefault(f"Dataset.First.{str(key).split('.')[-1]}", val)

    def replace(match: re.Match[str]) -> str:
        key = match.group(1).strip()
        resolved = builtins.get(key, match.group(0))
        if isinstance(resolved, list):
            return ", ".join(map(str, resolved))
        return str(resolved if resolved is not None else "")

    return re.sub(r"\{\{\s*([^}]+?)\s*\}\}", replace, value)


def _page_size(definition: dict[str, Any], columns: list[dict[str, Any]] | None = None):
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
    col_count = len(columns) if columns is not None else len((definition.get("table") or {}).get("columns") or [])
    orientation = str(page.get("orientation") or "").lower()
    if orientation == "landscape" or (orientation != "portrait" and col_count >= 8) or (col_count >= 8 and not page.get("orientation")):
        return landscape(size)
    elif col_count >= 8:
        return landscape(size)
    return landscape(size) if orientation == "landscape" else portrait(size)


def _compute_column_widths(
    columns: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    max_table_width: float,
    scale_factor: float = 1.0,
) -> list[float]:
    if not columns:
        return []

    from reportlab.lib.units import mm

    explicit_widths = [column.get("widthMm") for column in columns]
    has_custom = (
        all(w is not None and float(w) > 0 for w in explicit_widths)
        and len(set(float(w) for w in explicit_widths)) > 1
    )
    if has_custom:
        authored = [float(w) * mm for w in explicit_widths]
        total = sum(authored) or max_table_width
        return [w * (max_table_width / total) for w in authored]

    sample_rows = rows[:100] if rows else []
    col_weights: list[float] = []
    min_widths: list[float] = []

    for column in columns:
        field = str(column.get("field") or "")
        label = str(column.get("label") or field)
        words = label.split()
        max_header_word = max((len(w) for w in words), default=len(label))
        header_len = len(label)

        val_lens = [len(str(r.get(field, ""))) for r in sample_rows if r.get(field) is not None]
        avg_val_len = (sum(val_lens) / len(val_lens)) if val_lens else header_len
        max_val_len = max(val_lens, default=header_len)

        lower_label = label.lower()
        lower_field = field.lower()

        is_id = any(k in lower_label or k in lower_field for k in ("si no", "sino", "s.no", "sl no", "sl.no", "id", "#", "serial", "code")) and max_val_len <= 8
        is_age = ("age" in lower_label or "age" in lower_field) and max_val_len <= 4
        is_gender = any(k in lower_label for k in ("gender", "sex")) and max_val_len <= 8
        is_date = any(k in lower_label for k in ("date", "dob", "time")) and 8 <= max_val_len <= 19
        is_amount = any(k in lower_label for k in ("amount", "price", "cost", "total", "fee", "bill", "rate", "salary")) and max_val_len <= 15
        is_status = any(k in lower_label for k in ("status", "state", "flag")) and max_val_len <= 15
        is_name = any(k in lower_label for k in ("name", "patient", "doctor", "physician", "user", "customer", "client", "person")) and max_val_len <= 30

        if is_id or is_age:
            col_min = max(24.0 * scale_factor, 20.0)
            weight = 0.8
        elif is_gender:
            col_min = max(30.0 * scale_factor, 25.0)
            weight = 1.0
        elif is_date:
            col_min = max(44.0 * scale_factor, 36.0)
            weight = 1.7
        elif is_name:
            col_min = max(44.0 * scale_factor, 36.0)
            weight = 2.4
        elif is_amount or is_status:
            col_min = max(36.0 * scale_factor, 30.0)
            weight = 1.8
        else:
            col_min = max(30.0 * scale_factor, max_header_word * 5.6 * scale_factor, 24.0)
            eff_len = max(header_len * 0.8, min(avg_val_len * 0.9 + max_val_len * 0.3, 80.0))
            if eff_len > 40:
                weight = 3.6 + (eff_len - 40) * 0.10
            elif eff_len > 20:
                weight = 2.6 + (eff_len - 20) * 0.05
            else:
                weight = 1.8 + eff_len * 0.04

        min_widths.append(col_min)
        col_weights.append(weight)

    total_min = sum(min_widths)
    if total_min >= max_table_width:
        ratio = max_table_width / total_min
        return [w * ratio for w in min_widths]

    remaining = max_table_width - total_min
    total_weight = sum(col_weights) or 1.0
    return [min_w + (remaining * (w / total_weight)) for min_w, w in zip(min_widths, col_weights)]


def _safe_filename(template: str, *, definition: dict[str, Any], parameters: dict[str, Any], filters: list[dict[str, Any]]) -> str:
    name = _expression(template or "{{Report.Name}}.pdf", definition=definition, parameters=parameters, filters=filters)
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", name).strip(" .")
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return name[:180] or "Paginated_Report.pdf"


def render_paginated_pdf(project: dict[str, Any], definition_id: str, *, filter_context: list[dict[str, Any]] | None = None, parameters: dict[str, Any] | None = None, role_id: str | None = None, rls_rules: list[dict[str, Any]] | None = None) -> tuple[bytes, str, int]:
    try:
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.pdfbase.pdfmetrics import stringWidth
        from reportlab.pdfgen import canvas
        from reportlab.lib.utils import ImageReader
        from reportlab.platypus import KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    except ImportError as error:
        raise PaginatedReportError(f"PDF rendering is unavailable because ReportLab is not installed. ({error})") from error

    definition = _definition(project, definition_id)
    filters = [*(definition.get("filters") or []), *(filter_context or [])]
    parameter_values = {str(item.get("name")): item.get("defaultValue") for item in definition.get("parameters") or []}
    parameter_values.update(parameters or {})
    for parameter in definition.get("parameters") or []:
        name = str(parameter.get("name") or "")
        value = parameter_values.get(name)
        empty = value is None or value == "" or (isinstance(value, list) and not value)
        if parameter.get("required") and empty:
            raise PaginatedReportError(f"The required parameter '{parameter.get('prompt') or parameter.get('label') or name}' has no value.")
        if parameter.get("usedInQuery") and parameter.get("queryField") and not empty:
            operator = parameter.get("filterOperator") or ("in" if parameter.get("allowMultiple") or parameter.get("type") == "multi" else "equals")
            filters.append({"field": parameter["queryField"], "operator": operator, "value": value})
    columns = (definition.get("table") or {}).get("columns") or []
    measures_registry = (project.get("model") or {}).get("measures") or {}
    dimensions = [column["field"] for column in columns if column.get("field") not in measures_registry]
    measures = [column["field"] for column in columns if column.get("field") in measures_registry]
    rules: list[dict[str, Any]] = list(rls_rules or [])
    if role_id and rls_rules is None:
        role = next((item for item in (project.get("security") or {}).get("roles", []) if item.get("id") == role_id), None)
        rules = role.get("rules", []) if role else []
    query = {"dimensions": dimensions, "measures": measures, "filters": filters, "sort": (definition.get("table") or {}).get("sort") or [], "limit": 100000, "roleId": role_id}
    try:
        rows, _sql = execute(project.get("model") or {}, query, rules)
    except Exception as error:
        raise PaginatedReportError(f"The paginated dataset could not be executed: {error}") from error

    page = definition.get("page") or {}
    margins = page.get("margins") or {}
    page_size = _page_size(definition, columns=columns)
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

    first_row = rows[0] if rows else {}

    def pdf_font(item: dict[str, Any], prefix: str = "") -> str:
        bold = bool(item.get(f"{prefix}Bold") if prefix else item.get("bold"))
        italic = bool(item.get(f"{prefix}Italic") if prefix else item.get("italic"))
        if bold and italic:
            return "Helvetica-BoldOblique"
        if bold:
            return "Helvetica-Bold"
        if italic:
            return "Helvetica-Oblique"
        return "Helvetica"

    def image_reader(value: Any):
        source = str(value or "")
        if source.startswith("data:") and "," in source:
            try:
                return ImageReader(BytesIO(base64.b64decode(source.split(",", 1)[1])))
            except Exception:
                return None
        return None

    def draw_band_items(pdf, items: list[dict[str, Any]], y: float, height: float):
        cursor = left
        available = page_size[0] - left - right
        for index, item in enumerate(items):
            positioned = any(item.get(name) is not None for name in ("xMm", "yMm", "widthMm", "heightMm"))
            x = left + (float(item.get("xMm") or 0) * mm if positioned else cursor - left)
            item_y = y + height - float(item.get("yMm") or index * 7) * mm - float(item.get("heightMm") or 8) * mm if positioned else y
            width = float(item.get("widthMm") or 40) * mm if positioned else available * float(item.get("widthPercent") or 100) / 100
            item_height = float(item.get("heightMm") or (height / mm)) * mm if positioned else height
            # Keep authored objects inside their own section. This matches the
            # clipped canvas preview and prevents right-aligned footer text from
            # moving beyond the physical page edge.
            x = min(max(left, x), page_size[0] - right)
            width = max(1, min(width, page_size[0] - right - x))
            item_height = max(1, min(item_height, height))
            item_y = min(max(y, item_y), y + height - item_height)
            kind = item.get("type") or "text"
            color = colors.HexColor(item.get("color") or "#111827")
            if item.get("background"):
                pdf.setFillColor(colors.HexColor(item["background"]));pdf.rect(x, item_y, width, item_height, stroke=0, fill=1)
            if kind == "line":
                pdf.setStrokeColor(color);pdf.setLineWidth(float(item.get("borderWidth") or 1));pdf.setDash([] if item.get("lineStyle") == "solid" else [4, 2] if item.get("lineStyle") == "dashed" else [1, 2]);pdf.line(x, item_y + item_height / 2, x + width, item_y + item_height / 2);pdf.setDash()
            elif kind == "shape":
                pdf.setStrokeColor(colors.HexColor(item.get("borderColor") or item.get("color") or "#111827"));pdf.setLineWidth(float(item.get("borderWidth") or 1));pdf.rect(x, item_y, width, max(1, item_height), stroke=1, fill=0)
            elif kind == "image":
                image = image_reader(item.get("value"))
                if image:
                    pdf.drawImage(image, x, item_y, width=width, height=item_height, preserveAspectRatio=item.get("imageFit") not in ("fill",), anchor="c", mask="auto")
            elif kind == "text":
                text = _expression(item.get("dynamicToken") or item.get("value"), definition=definition, parameters=parameter_values, filters=filters, page_number=pdf._pageNumber, total_pages=len(pdf._saved_page_states), record_count=len(rows), first_row=first_row)
                size = float(item.get("fontSize") or 9);pdf.setFont(pdf_font(item), size);pdf.setFillColor(color)
                baseline = item_y + max(2, (item_height - size) / 2)
                align = item.get("align") or "left"
                if align == "right":pdf.drawRightString(x + width, baseline, text)
                elif align == "center":pdf.drawCentredString(x + width / 2, baseline, text)
                else:pdf.drawString(x, baseline, text)
            if not positioned:
                cursor += width

    def draw_bands(pdf, page_number: int, total_pages: int):
        del page_number, total_pages
        height = page_size[1]
        header = definition.get("header") or {}
        footer = definition.get("footer") or {}
        if header.get("visible", True):draw_band_items(pdf, header.get("items") or [], height - top - header_height, header_height)
        if footer.get("visible", True):draw_band_items(pdf, footer.get("items") or [], bottom, footer_height)
        content_top = height - top - header_height
        content_height = height - top - bottom - header_height - footer_height
        draw_band_items(pdf, definition.get("bodyItems") or [], bottom + footer_height, content_height)

    table_definition = definition.get("table") or {}
    layout = definition.get("contentLayout") or {}
    table_x = max(0, float(layout.get("tableXmm") or 0)) * mm
    table_y = max(0, float(layout.get("tableYmm") or 0)) * mm
    document = SimpleDocTemplate(
        buffer,
        pagesize=page_size,
        leftMargin=left + table_x,
        rightMargin=right,
        # Reserve the authored gap above the table on every generated page,
        # not only on page one. Body objects are drawn inside that same gap.
        topMargin=top + header_height + table_y,
        bottomMargin=bottom + footer_height,
        title=definition.get("name") or "Paginated Report",
    )
    col_count = len(columns)
    if col_count <= 6:
        scale_factor = 1.0
    elif col_count <= 10:
        scale_factor = 0.90
    elif col_count <= 14:
        scale_factor = 0.82
    elif col_count <= 18:
        scale_factor = 0.74
    else:
        scale_factor = max(0.65, 13.0 / col_count)

    cell_padding = max(1.5, min(4.0, 4.0 * scale_factor))
    header_pad = max(2.5, cell_padding + 1.0)

    header_styles = []
    body_styles = []
    for index, column in enumerate(columns):
        raw_header_size = float(column.get("headerFontSize") or table_definition.get("headerFontSize") or table_definition.get("fontSize") or 9)
        raw_body_size = float(column.get("valueFontSize") or table_definition.get("fontSize") or 9)
        header_size = max(5.5, raw_header_size * scale_factor)
        body_size = max(5.5, raw_body_size * scale_factor)
        header_styles.append(
            ParagraphStyle(
                f"PaginatedHeader{index}",
                fontName=pdf_font({"headerBold": column.get("headerBold", table_definition.get("headerBold", True)), "headerItalic": column.get("headerItalic", table_definition.get("headerItalic", False))}, "header"),
                fontSize=header_size,
                leading=header_size * 1.18,
                textColor=colors.HexColor(column.get("headerColor") or table_definition.get("headerColor") or "#111827"),
                alignment=alignments.get(column.get("headerAlign") or column.get("align") or "left", TA_LEFT),
                wordWrap="CJK",
            )
        )
        body_styles.append(
            ParagraphStyle(
                f"PaginatedBody{index}",
                fontName=pdf_font({"valueBold": column.get("valueBold", table_definition.get("bodyBold", False)), "valueItalic": column.get("valueItalic", table_definition.get("bodyItalic", False))}, "value"),
                fontSize=body_size,
                leading=body_size * 1.18,
                textColor=colors.HexColor(column.get("valueColor") or table_definition.get("bodyColor") or "#1f2937"),
                alignment=alignments.get(column.get("valueAlign") or column.get("align") or "left", TA_LEFT),
                wordWrap="CJK",
            )
        )

    def _make_cell(value: Any, style: ParagraphStyle) -> Paragraph:
        val_str = str(value) if value is not None else ""
        escaped = escape(val_str).strip()
        return Paragraph(escaped if escaped else "&nbsp;", style)

    data = [[_make_cell(column.get("label") or column.get("field") or "", header_styles[index]) for index, column in enumerate(columns)]]
    for row in rows:
        data.append([_make_cell(row.get(column.get("field")), body_styles[index]) for index, column in enumerate(columns)])

    max_width = max(100.0, page_size[0] - left - right - table_x)
    widths = _compute_column_widths(columns, rows, max_width, scale_factor=scale_factor)

    style = TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(table_definition.get("headerBackground") or "#e8eef7")),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor(table_definition.get("borderColor") or "#cbd5e1")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), cell_padding),
        ("RIGHTPADDING", (0, 0), (-1, -1), cell_padding),
        ("TOPPADDING", (0, 0), (-1, 0), header_pad),
        ("BOTTOMPADDING", (0, 0), (-1, 0), header_pad),
        ("TOPPADDING", (0, 1), (-1, -1), cell_padding),
        ("BOTTOMPADDING", (0, 1), (-1, -1), cell_padding),
    ])
    if table_definition.get("alternateRows", True):
        style.add("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor(table_definition.get("alternateBackground") or "#f8fafc")])
    for index, column in enumerate(columns):
        if column.get("headerBackground"):
            style.add("BACKGROUND", (index, 0), (index, 0), colors.HexColor(column["headerBackground"]))
        if column.get("valueBackground"):
            style.add("BACKGROUND", (index, 1), (index, -1), colors.HexColor(column["valueBackground"]))
    story: list[Any] = []
    pagination = definition.get("pagination") or {}
    mode = pagination.get("mode") or "automatic"
    repeat_rows = 1 if table_definition.get("repeatHeader", True) else 0

    def append_table(block: list[list[Any]]):
        story.append(Table(block, colWidths=widths, repeatRows=repeat_rows, style=style, splitByRow=1, rowHeights=None))

    if not rows:
        empty_style = body_styles[0] if body_styles else ParagraphStyle("PaginatedEmpty", fontName="Helvetica", fontSize=9)
        story.append(Paragraph("No data matched the selected filters.", empty_style))
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
            group_style = header_styles[0] if header_styles else ParagraphStyle("PaginatedGroup", fontName="Helvetica-Bold", fontSize=9)
            story.append(KeepTogether([Paragraph(group_name or "(Blank)", group_style), Spacer(1, 2 * mm)]))
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
