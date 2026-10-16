from __future__ import annotations
from pathlib import Path
from io import BytesIO
import base64, json, smtplib, os, urllib.request, urllib.error
from datetime import datetime, timezone
from email.message import EmailMessage

# pptx and reportlab are imported lazily (inside each function) so that the
# backend server starts successfully even if these optional packages are not
# bundled by PyInstaller. Core login, data, and report-authoring features are
# completely unaffected. Only PDF/PPT export calls would raise an error if the
# package is genuinely absent from the bundle.


def _pages(project):
    return (project or {}).get('report',{}).get('pages',[]) or []

def _rendered_image(page:dict)->bytes:
    value=str((page or {}).get('image') or '')
    if not value.startswith('data:image/') or ';base64,' not in value:
        raise ValueError('Each rendered report page must contain a base64 image.')
    try:
        return base64.b64decode(value.split(',',1)[1],validate=True)
    except Exception as exc:
        raise ValueError('A rendered report page contains an invalid image.') from exc

def _insights(page:dict)->list[str]:
    result=[]
    for value in (page or {}).get('insights') or []:
        text=' '.join(str(value).split())
        if text and text not in result:result.append(text[:180])
    return result[:5]

def _narratives(page:dict)->list[dict]:
    result=[];point_count=0;seen=set()
    for item in (page or {}).get('narratives') or []:
        if not isinstance(item,dict):continue
        title=' '.join(str(item.get('title') or 'Visual').split())[:70]
        points=[]
        for value in item.get('points') or []:
            text=' '.join(str(value).split())[:150]
            if text and text not in seen and text not in points:
                seen.add(text)
                points.append(text);point_count+=1
            if len(points)>=2 or point_count>=8:break
        if points:result.append({'title':title,'points':points})
        if len(result)>=4 or point_count>=8:break
    if result:return result
    fallback=_insights(page)
    return [{'title':'Page summary','points':fallback[:5]}] if fallback else []

def _report_name(project:dict)->str:
    return str((project or {}).get('report',{}).get('name') or (project or {}).get('name') or 'VTAB Report')

def _generated_text()->str:
    return f'Generated {datetime.now(timezone.utc).strftime("%d %b %Y, %H:%M UTC")}'

def _format_metric(val) -> str:
    if val is None:
        return '-'
    if isinstance(val, (int, float)):
        num = float(val)
        if abs(num) >= 1_000_000_000:
            return f"{num/1_000_000_000:.2f}B"
        if abs(num) >= 1_000_000:
            return f"{num/1_000_000:.2f}M"
        if abs(num) >= 1_000:
            return f"{num/1_000:.1f}K"
        if num.is_integer():
            return f"{int(num):,}"
        return f"{num:.2f}"
    return str(val)

def _format_axis_tick(val) -> str:
    if val is None:
        return '0'
    try:
        num = float(val)
        if abs(num) >= 1_000_000:
            return f"{num/1_000_000:.1f}M"
        if abs(num) >= 1_000:
            return f"{num/1_000:.1f}K"
        if num.is_integer():
            return f"{int(num)}"
        return f"{num:.1f}"
    except Exception:
        return str(val)

_CHART_PALETTE = [
    '#118dff', '#12239e', '#e66c37', '#6b007b', '#e044a7',
    '#744ec2', '#d9b300', '#d64550', '#197278', '#1aab40',
]

def _query_visual_data(model: dict | None, visual: dict) -> tuple[list[dict], list[str], list[str]]:
    if not model or not isinstance(model, dict):
        return [], [], []
    try:
        from .semantic_engine import execute
        bindings = visual.get('bindings') or {}
        dims = list(dict.fromkeys([*(bindings.get('axis') or []), *(bindings.get('legend') or [])]))
        meas = list(dict.fromkeys([
            *(bindings.get('values') or []),
            *(bindings.get('target') or []),
            *(bindings.get('tooltips') or []),
            *(bindings.get('min') or []),
            *(bindings.get('max') or []),
            *(bindings.get('x') or []),
            *(bindings.get('size') or [])
        ]))
        if not dims and not meas:
            return [], dims, meas
        payload = {
            'dimensions': dims,
            'measures': meas,
            'filters': visual.get('filters') or [],
            'sort': visual.get('sort') or [],
            'limit': 200,
        }
        rows, _ = execute(model, payload)
        return rows or [], dims, meas
    except Exception:
        return [], [], []

def _draw_card_visual(c, colors, rx: float, ry: float, rw: float, rh: float, visual: dict, rows: list[dict], meas: list[str]) -> None:
    val_str = '-'
    if rows and meas:
        first_row = rows[0]
        raw_val = None
        for m in meas:
            if m in first_row:
                raw_val = first_row[m]
                break
            short = m.split('.')[-1]
            if short in first_row:
                raw_val = first_row[short]
                break
        if raw_val is None and first_row:
            raw_val = next(iter(first_row.values()))
        val_str = _format_metric(raw_val)

    title = visual.get('title') or (meas[0].split('.')[-1] if meas else 'KPI')
    c.setFillColor(colors.HexColor('#64748b'))
    c.setFont('Helvetica-Bold', max(8, min(10, rw * 0.05)))
    c.drawString(rx + 12, ry + rh - 20, str(title)[:45])

    accent = (visual.get('format') or {}).get('accent') or '#0f172a'
    try:
        val_color = colors.HexColor(accent)
    except Exception:
        val_color = colors.HexColor('#0f172a')
    c.setFillColor(val_color)
    val_size = max(13, min(25, rw * 0.13, rh * 0.35))
    c.setFont('Helvetica-Bold', val_size)
    c.drawString(rx + 12, ry + (rh - 24) / 2, val_str)

    sub = (visual.get('format') or {}).get('subtitle')
    if sub:
        c.setFillColor(colors.HexColor('#94a3b8'))
        c.setFont('Helvetica', 8)
        c.drawString(rx + 12, ry + 10, str(sub)[:50])

def _draw_column_or_bar_visual(c, colors, rx: float, ry: float, rw: float, rh: float, visual: dict, rows: list[dict], dims: list[str], meas: list[str], is_horizontal: bool = False) -> None:
    title = visual.get('title') or visual.get('name') or 'Chart'
    c.setFillColor(colors.HexColor('#0f172a'))
    c.setFont('Helvetica-Bold', max(8, min(11, rw * 0.04)))
    c.drawString(rx + 10, ry + rh - 18, str(title)[:55])

    pad_l = 42 if not is_horizontal else 54
    pad_r = 16
    pad_t = 28
    pad_b = 26 if not is_horizontal else 22
    px = rx + pad_l
    py = ry + pad_b
    pw = rw - pad_l - pad_r
    ph = rh - pad_t - pad_b

    if pw <= 15 or ph <= 15 or not rows:
        if not rows:
            c.setFillColor(colors.HexColor('#94a3b8'))
            c.setFont('Helvetica', 8)
            c.drawCentredString(rx + rw / 2, ry + rh / 2 - 4, 'No data to display')
        return

    sample = rows[0]
    actual_dim_key = None
    actual_meas_key = None
    if dims:
        if dims[0] in sample: actual_dim_key = dims[0]
        elif dims[0].split('.')[-1] in sample: actual_dim_key = dims[0].split('.')[-1]
    if meas:
        if meas[0] in sample: actual_meas_key = meas[0]
        elif meas[0].split('.')[-1] in sample: actual_meas_key = meas[0].split('.')[-1]
    if not actual_dim_key:
        actual_dim_key = next((k for k, v in sample.items() if not isinstance(v, (int, float))), list(sample.keys())[0])
    if not actual_meas_key:
        actual_meas_key = next((k for k, v in sample.items() if isinstance(v, (int, float))), list(sample.keys())[-1])

    items: list[tuple[str, float]] = []
    for r in rows[:15]:
        d_val = str(r.get(actual_dim_key) or '')
        try:
            m_val = float(r.get(actual_meas_key) or 0)
        except (ValueError, TypeError):
            m_val = 0.0
        items.append((d_val, m_val))

    max_val = max([it[1] for it in items] + [1.0])
    if max_val <= 0: max_val = 1.0

    bar_accent = (visual.get('format') or {}).get('accent') or '#118dff'
    try:
        bar_color = colors.HexColor(bar_accent)
    except Exception:
        bar_color = colors.HexColor('#118dff')

    if not is_horizontal:
        # Vertical column chart
        grid_steps = 4
        c.setStrokeColor(colors.HexColor('#f1f5f9'))
        c.setLineWidth(0.6)
        c.setFont('Helvetica', 7)
        c.setFillColor(colors.HexColor('#94a3b8'))

        for s in range(grid_steps + 1):
            gy = py + ph * (s / grid_steps)
            g_val = max_val * (s / grid_steps)
            c.line(px, gy, px + pw, gy)
            c.drawRightString(px - 4, gy - 2.5, _format_axis_tick(g_val))

        c.setStrokeColor(colors.HexColor('#cbd5e1'))
        c.setLineWidth(0.8)
        c.line(px, py, px + pw, py)

        n = len(items)
        slot_w = pw / max(n, 1)
        bar_w = min(slot_w * 0.65, 34)

        for idx, (label, val) in enumerate(items):
            cx_bar = px + idx * slot_w + (slot_w - bar_w) / 2
            bar_h = max(0, (val / max_val) * ph) if max_val > 0 else 0
            
            c.setFillColor(bar_color)
            c.roundRect(cx_bar, py, bar_w, max(bar_h, 1.5), 2, stroke=0, fill=1)

            if bar_h > 0:
                c.setFillColor(colors.HexColor('#334155'))
                c.setFont('Helvetica-Bold', max(5.5, min(7.5, bar_w * 0.35)))
                c.drawCentredString(cx_bar + bar_w / 2, py + bar_h + 3, _format_metric(val))

            c.setFillColor(colors.HexColor('#64748b'))
            c.setFont('Helvetica', max(5.5, min(7.5, slot_w * 0.16)))
            lbl = label[:11] + ('..' if len(label) > 11 else '')
            c.drawCentredString(cx_bar + bar_w / 2, py - 11, lbl)
    else:
        # Horizontal bar chart
        n = len(items)
        slot_h = ph / max(n, 1)
        bar_h = min(slot_h * 0.65, 20)

        # Baseline
        c.setStrokeColor(colors.HexColor('#cbd5e1'))
        c.setLineWidth(0.8)
        c.line(px, py, px, py + ph)

        for idx, (label, val) in enumerate(items):
            cy_bar = py + ph - (idx + 1) * slot_h + (slot_h - bar_h) / 2
            bar_w = max(0, (val / max_val) * (pw - 40)) if max_val > 0 else 0

            c.setFillColor(bar_color)
            c.roundRect(px, cy_bar, max(bar_w, 2), bar_h, 2, stroke=0, fill=1)

            c.setFillColor(colors.HexColor('#64748b'))
            c.setFont('Helvetica', max(6, min(7.5, slot_h * 0.35)))
            lbl = label[:10] + ('..' if len(label) > 10 else '')
            c.drawRightString(px - 4, cy_bar + bar_h / 2 - 3, lbl)

            c.setFillColor(colors.HexColor('#334155'))
            c.setFont('Helvetica-Bold', max(6, min(7.5, bar_h * 0.45)))
            c.drawString(px + bar_w + 4, cy_bar + bar_h / 2 - 3, _format_metric(val))

def _draw_line_or_area_visual(c, colors, rx: float, ry: float, rw: float, rh: float, visual: dict, rows: list[dict], dims: list[str], meas: list[str], is_area: bool = False) -> None:
    title = visual.get('title') or visual.get('name') or 'Trend'
    c.setFillColor(colors.HexColor('#0f172a'))
    c.setFont('Helvetica-Bold', max(8, min(11, rw * 0.04)))
    c.drawString(rx + 10, ry + rh - 18, str(title)[:55])

    pad_l = 40
    pad_r = 16
    pad_t = 28
    pad_b = 26
    px = rx + pad_l
    py = ry + pad_b
    pw = rw - pad_l - pad_r
    ph = rh - pad_t - pad_b

    if pw <= 15 or ph <= 15 or not rows:
        return

    sample = rows[0]
    actual_dim_key = dims[0] if dims and dims[0] in sample else (dims[0].split('.')[-1] if dims and dims[0].split('.')[-1] in sample else list(sample.keys())[0])
    actual_meas_key = meas[0] if meas and meas[0] in sample else (meas[0].split('.')[-1] if meas and meas[0].split('.')[-1] in sample else list(sample.keys())[-1])

    items: list[tuple[str, float]] = []
    for r in rows[:20]:
        try:
            m_val = float(r.get(actual_meas_key) or 0)
        except (ValueError, TypeError):
            m_val = 0.0
        items.append((str(r.get(actual_dim_key) or ''), m_val))

    max_val = max([it[1] for it in items] + [1.0])
    min_val = min([it[1] for it in items] + [0.0])
    range_val = max(max_val - min_val, 1.0)

    # Gridlines
    grid_steps = 4
    c.setStrokeColor(colors.HexColor('#f1f5f9'))
    c.setLineWidth(0.6)
    c.setFont('Helvetica', 7)
    c.setFillColor(colors.HexColor('#94a3b8'))

    for s in range(grid_steps + 1):
        gy = py + ph * (s / grid_steps)
        g_val = min_val + range_val * (s / grid_steps)
        c.line(px, gy, px + pw, gy)
        c.drawRightString(px - 4, gy - 2.5, _format_axis_tick(g_val))

    # Base line
    c.setStrokeColor(colors.HexColor('#cbd5e1'))
    c.setLineWidth(0.8)
    c.line(px, py, px + pw, py)

    n = len(items)
    step_x = pw / max(n - 1, 1) if n > 1 else pw / 2
    pts = []
    for idx, (label, val) in enumerate(items):
        cx_pt = px + (idx * step_x if n > 1 else pw / 2)
        cy_pt = py + ((val - min_val) / range_val) * ph
        pts.append((cx_pt, cy_pt, label, val))

    line_accent = (visual.get('format') or {}).get('accent') or '#118dff'
    try:
        line_color = colors.HexColor(line_accent)
    except Exception:
        line_color = colors.HexColor('#118dff')

    # Draw Area Shading if requested
    if is_area and len(pts) >= 2:
        poly = c.beginPath()
        poly.moveTo(pts[0][0], py)
        for cx_pt, cy_pt, _, _ in pts:
            poly.lineTo(cx_pt, cy_pt)
        poly.lineTo(pts[-1][0], py)
        poly.close()
        c.setFillColor(colors.HexColor('#e0f2fe'))
        c.drawPath(poly, stroke=0, fill=1)

    # Connecting line
    c.setStrokeColor(line_color)
    c.setLineWidth(1.8)
    for i in range(len(pts) - 1):
        c.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])

    # Markers & labels
    for cx_pt, cy_pt, label, val in pts:
        c.setFillColor(line_color)
        c.circle(cx_pt, cy_pt, 2.5, stroke=0, fill=1)
        c.setFillColor(colors.HexColor('#ffffff'))
        c.circle(cx_pt, cy_pt, 1.2, stroke=0, fill=1)

        c.setFillColor(colors.HexColor('#64748b'))
        c.setFont('Helvetica', 6.5)
        lbl = label[:8] + ('..' if len(label) > 8 else '')
        c.drawCentredString(cx_pt, py - 10, lbl)

def _draw_pie_or_donut_visual(c, colors, rx: float, ry: float, rw: float, rh: float, visual: dict, rows: list[dict], dims: list[str], meas: list[str], is_donut: bool = False) -> None:
    title = visual.get('title') or visual.get('name') or 'Distribution'
    c.setFillColor(colors.HexColor('#0f172a'))
    c.setFont('Helvetica-Bold', max(8, min(11, rw * 0.04)))
    c.drawString(rx + 10, ry + rh - 18, str(title)[:55])

    pad_t = 28
    pw = rw - 20
    ph = rh - pad_t - 10
    if pw <= 15 or ph <= 15 or not rows:
        return

    sample = rows[0]
    actual_dim_key = dims[0] if dims and dims[0] in sample else (dims[0].split('.')[-1] if dims and dims[0].split('.')[-1] in sample else list(sample.keys())[0])
    actual_meas_key = meas[0] if meas and meas[0] in sample else (meas[0].split('.')[-1] if meas and meas[0].split('.')[-1] in sample else list(sample.keys())[-1])

    items: list[tuple[str, float]] = []
    total = 0.0
    for r in rows[:8]:
        try:
            m_val = float(r.get(actual_meas_key) or 0)
        except (ValueError, TypeError):
            m_val = 0.0
        if m_val > 0:
            items.append((str(r.get(actual_dim_key) or ''), m_val))
            total += m_val

    if total <= 0 or not items:
        return

    legend_w = min(pw * 0.45, 120)
    pie_area_w = pw - legend_w
    radius = min(pie_area_w / 2, ph / 2) * 0.85
    cx = rx + 10 + pie_area_w / 2
    cy = ry + 8 + ph / 2

    cur_angle = 90.0
    c.setStrokeColor(colors.HexColor('#ffffff'))
    c.setLineWidth(1)

    for idx, (label, val) in enumerate(items):
        extent = (val / total) * 360.0
        c.setFillColor(colors.HexColor(_CHART_PALETTE[idx % len(_CHART_PALETTE)]))
        c.wedge(cx - radius, cy - radius, cx + radius, cy + radius, cur_angle, extent, stroke=1, fill=1)
        cur_angle += extent

    if is_donut:
        c.setFillColor(colors.HexColor('#ffffff'))
        c.circle(cx, cy, radius * 0.55, stroke=0, fill=1)

    # Legend
    leg_x = rx + 10 + pie_area_w + 5
    leg_y = ry + rh - 34
    c.setFont('Helvetica', 7.5)

    for idx, (label, val) in enumerate(items[:6]):
        pct = (val / total) * 100
        c.setFillColor(colors.HexColor(_CHART_PALETTE[idx % len(_CHART_PALETTE)]))
        c.roundRect(leg_x, leg_y - 2, 7, 7, 1, stroke=0, fill=1)
        c.setFillColor(colors.HexColor('#334155'))
        c.drawString(leg_x + 12, leg_y - 1, f"{label[:9]} ({pct:.0f}%)")
        leg_y -= 13

def _draw_table_visual(c, colors, rx: float, ry: float, rw: float, rh: float, visual: dict, rows: list[dict], dims: list[str], meas: list[str]) -> None:
    title = visual.get('title') or visual.get('name') or 'Data Table'
    c.setFillColor(colors.HexColor('#0f172a'))
    c.setFont('Helvetica-Bold', max(8, min(11, rw * 0.04)))
    c.drawString(rx + 10, ry + rh - 18, str(title)[:55])

    pad_t = 26
    px = rx + 8
    pw = rw - 16
    ph = rh - pad_t - 8
    if pw <= 15 or ph <= 15 or not rows:
        return

    cols = list(rows[0].keys())[:6]
    col_w = pw / len(cols)
    row_h = 16
    max_rows = int(ph / row_h) - 1

    c.setFillColor(colors.HexColor('#f1f5f9'))
    c.rect(px, ry + rh - pad_t - row_h, pw, row_h, stroke=0, fill=1)
    c.setFillColor(colors.HexColor('#334155'))
    c.setFont('Helvetica-Bold', 7.5)
    for c_idx, col in enumerate(cols):
        short_col = col.split('.')[-1][:12]
        c.drawString(px + c_idx * col_w + 4, ry + rh - pad_t - row_h + 4, short_col)

    c.setFont('Helvetica', 7)
    curr_y = ry + rh - pad_t - row_h * 2
    for r_idx, r in enumerate(rows[:max_rows]):
        bg = colors.HexColor('#ffffff') if r_idx % 2 == 0 else colors.HexColor('#f8fafc')
        c.setFillColor(bg)
        c.rect(px, curr_y, pw, row_h, stroke=0, fill=1)
        c.setFillColor(colors.HexColor('#1e293b'))
        for c_idx, col in enumerate(cols):
            v = r.get(col)
            val_txt = _format_metric(v) if isinstance(v, (int, float)) else str(v or '')[:14]
            c.drawString(px + c_idx * col_w + 4, curr_y + 4, val_txt)
        curr_y -= row_h

def _render_page_visuals(c, colors, model: dict | None, page: dict, content_box: tuple[float, float, float, float]) -> None:
    cl, cb, cw, ch = content_box
    settings = page.get('settings') or {}
    pw = float(settings.get('pageWidth') or 1280)
    ph = float(settings.get('pageHeight') or 720)
    visuals = [v for v in (page.get('visuals') or []) if v.get('visible', True) is not False and not v.get('hidden', False)]
    if not visuals:
        visuals = page.get('visuals') or []
    if not visuals:
        return

    max_x = max([float(v.get('x') or 0) + float(v.get('w') or 0) for v in visuals] + [pw])
    max_y = max([float(v.get('y') or 0) + float(v.get('h') or 0) for v in visuals] + [ph])
    pw = max(pw, max_x)
    ph = max(ph, max_y)

    scale_x = cw / pw
    scale_y = ch / ph
    scale = min(scale_x, scale_y)
    offset_x = cl + (cw - pw * scale) / 2
    offset_y = cb + (ch - ph * scale) / 2

    for v in visuals:
        vx = float(v.get('x') or 0)
        vy = float(v.get('y') or 0)
        vw = float(v.get('w') or 100)
        vh = float(v.get('h') or 100)

        rx = offset_x + vx * scale
        rw = max(10, vw * scale)
        rh = max(10, vh * scale)
        ry = offset_y + (ph - (vy + vh)) * scale

        typ = str(v.get('type') or 'card').lower()

        if typ == 'shape':
            c.setFillColor(colors.HexColor('#f8fafc'))
            c.setStrokeColor(colors.HexColor('#e2e8f0'))
            c.roundRect(rx, ry, rw, rh, 4, stroke=1, fill=1)
            continue
        elif typ == 'textbox':
            c.setFillColor(colors.HexColor('#0f172a'))
            c.setFont('Helvetica-Bold', max(8, min(14, rw * 0.05)))
            text = str(v.get('text') or v.get('title') or '')
            c.drawString(rx + 4, ry + rh - 16, text[:60])
            continue
        elif typ in ('button', 'slicer'):
            c.setFillColor(colors.HexColor('#ffffff'))
            c.setStrokeColor(colors.HexColor('#e2e8f0'))
            c.roundRect(rx, ry, rw, rh, 4, stroke=1, fill=1)
            c.setFillColor(colors.HexColor('#475569'))
            c.setFont('Helvetica', 8)
            c.drawString(rx + 8, ry + rh - 14, str(v.get('title') or typ).title()[:30])
            continue
        elif typ == 'image':
            src = str(v.get('imageSrc') or '')
            if src.startswith('data:image/') and ';base64,' in src:
                try:
                    from reportlab.lib.utils import ImageReader
                    img_bytes = base64.b64decode(src.split(',', 1)[1])
                    img = ImageReader(BytesIO(img_bytes))
                    c.drawImage(img, rx, ry, width=rw, height=rh, preserveAspectRatio=True, mask='auto')
                    continue
                except Exception:
                    pass
            c.setFillColor(colors.HexColor('#ffffff'))
            c.setStrokeColor(colors.HexColor('#e2e8f0'))
            c.roundRect(rx, ry, rw, rh, 4, stroke=1, fill=1)
            continue

        # Standard Visual Container Card
        c.setFillColor(colors.HexColor('#ffffff'))
        c.setStrokeColor(colors.HexColor('#e2e8f0'))
        c.setLineWidth(0.8)
        c.roundRect(rx, ry, rw, rh, 6, stroke=1, fill=1)

        try:
            rows, dims, meas = _query_visual_data(model, v)
            if typ in ('card', 'kpi'):
                _draw_card_visual(c, colors, rx, ry, rw, rh, v, rows, meas)
            elif typ in ('column', 'bar', 'stackedcolumn', 'stackedbar', 'waterfall'):
                _draw_column_or_bar_visual(c, colors, rx, ry, rw, rh, v, rows, dims, meas, is_horizontal='bar' in typ)
            elif typ in ('line', 'area'):
                _draw_line_or_area_visual(c, colors, rx, ry, rw, rh, v, rows, dims, meas, is_area='area' in typ)
            elif typ in ('pie', 'donut'):
                _draw_pie_or_donut_visual(c, colors, rx, ry, rw, rh, v, rows, dims, meas, is_donut='donut' in typ)
            elif typ in ('table', 'matrix'):
                _draw_table_visual(c, colors, rx, ry, rw, rh, v, rows, dims, meas)
            else:
                _draw_column_or_bar_visual(c, colors, rx, ry, rw, rh, v, rows, dims, meas)
        except Exception:
            # Fallback if anything unexpected fails in chart rendering
            c.setFillColor(colors.HexColor('#0f172a'))
            c.setFont('Helvetica-Bold', 9)
            c.drawString(rx + 8, ry + rh - 16, str(v.get('title') or typ)[:40])

def report_pdf(project:dict,rendered_pages:list[dict]|None=None)->bytes:
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import landscape, portrait, A4
        from reportlab.pdfgen import canvas
    except ImportError as e:
        raise RuntimeError(f'PDF export is unavailable: reportlab is not installed in the desktop bundle. ({e})') from e
    buf=BytesIO(); c=canvas.Canvas(buf,pagesize=landscape(A4)); W,H=landscape(A4)
    name=_report_name(project);generated=_generated_text()
    if rendered_pages:
        from reportlab.lib.utils import ImageReader
        total=len(rendered_pages)
        for index,page in enumerate(rendered_pages,1):
            image=ImageReader(BytesIO(_rendered_image(page)));iw,ih=image.getSize()
            if ih > iw:
                c.setPageSize(portrait(A4))
                W, H = portrait(A4)
            else:
                c.setPageSize(landscape(A4))
                W, H = landscape(A4)
            c.setFillColor(colors.white);c.rect(0,0,W,H,stroke=0,fill=1)
            c.setFillColor(colors.HexColor('#0f172a'));c.setFont('Helvetica-Bold',16);c.drawString(24,H-30,name[:90])
            c.setFillColor(colors.HexColor('#64748b'));c.setFont('Helvetica',9);c.drawRightString(W-24,H-29,generated)
            line_y=H-43;c.setStrokeColor(colors.HexColor('#cbd5e1'));c.setLineWidth(.8);c.line(24,line_y,W-24,line_y)
            content_left,content_right,content_bottom,content_top=24,W-24,28,line_y-12
            available_w,available_h=content_right-content_left,content_top-content_bottom
            scale=min(available_w/iw,available_h/ih);draw_w=iw*scale;draw_h=ih*scale
            c.drawImage(image,content_left+(available_w-draw_w)/2,content_bottom+(available_h-draw_h)/2,width=draw_w,height=draw_h,preserveAspectRatio=True,mask='auto')
            c.setFillColor(colors.HexColor('#64748b'));c.setFont('Helvetica',8)
            c.drawString(24,14,str(page.get('name') or f'Page {index}')[:100]);c.drawRightString(W-24,14,f'Page {index} of {total}')
            c.showPage()
        c.save();return buf.getvalue()
    pages=_pages(project) or [{'name':'Page 1','visuals':[]}]
    model=project.get('model')
    for i,p in enumerate(pages,1):
        ps = p.get('settings') or {}
        pw = float(ps.get('pageWidth') or 1280)
        ph = float(ps.get('pageHeight') or 720)
        if ps.get('autoFitHeight'):
            vbot = max([float((v.get('y') or 0) + (v.get('h') or 100)) for v in p.get('visuals', [])] + [ph])
            ph = max(ph, vbot + 32)
        if ph > pw:
            c.setPageSize(portrait(A4))
            W, H = portrait(A4)
        else:
            c.setPageSize(landscape(A4))
            W, H = landscape(A4)
        c.setFillColor(colors.white);c.rect(0,0,W,H,stroke=0,fill=1)
        c.setFillColor(colors.HexColor('#0f172a'));c.setFont('Helvetica-Bold',16);c.drawString(28,H-30,name[:90])
        c.setFillColor(colors.HexColor('#64748b'));c.setFont('Helvetica',9);c.drawRightString(W-28,H-29,generated)
        c.setStrokeColor(colors.HexColor('#cbd5e1'));c.setLineWidth(.8);c.line(28,H-43,W-28,H-43)
        content_box=(28, 28, W - 56, H - 76)
        _render_page_visuals(c, colors, model, p, content_box)
        c.setFillColor(colors.HexColor('#64748b'));c.setFont('Helvetica',8)
        c.drawString(28,14,str(p.get('name') or f'Page {i}')[:100])
        c.drawRightString(W-28,14,f'Page {i} of {len(pages)} | Exported from VTAB Reporting Studio')
        c.showPage()
    c.save();return buf.getvalue()

def report_pptx(project:dict,rendered_pages:list[dict]|None=None)->bytes:
    try:
        from pptx import Presentation
        from pptx.util import Inches, Pt
        from pptx.enum.shapes import MSO_SHAPE
        from pptx.enum.text import PP_ALIGN
        from pptx.dml.color import RGBColor
        from PIL import Image
    except ImportError as e:
        raise RuntimeError(f'PowerPoint export is unavailable: python-pptx is not installed in the desktop bundle. ({e})') from e
    prs=Presentation();prs.slide_width=Inches(13.333);prs.slide_height=Inches(7.5)
    name=_report_name(project);generated=_generated_text()
    if rendered_pages:
        for index,page in enumerate(rendered_pages,1):
            slide=prs.slides.add_slide(prs.slide_layouts[6]);slide.background.fill.solid();slide.background.fill.fore_color.rgb=RGBColor(255,255,255)
            heading=slide.shapes.add_textbox(Inches(.42),Inches(.16),Inches(8.3),Inches(.4));ht=heading.text_frame;ht.text=name;ht.paragraphs[0].font.size=Pt(18);ht.paragraphs[0].font.bold=True;ht.paragraphs[0].font.color.rgb=RGBColor(15,23,42)
            date_box=slide.shapes.add_textbox(Inches(9.0),Inches(.19),Inches(3.9),Inches(.3));dt=date_box.text_frame;dt.text=generated;dt.paragraphs[0].alignment=PP_ALIGN.RIGHT;dt.paragraphs[0].font.size=Pt(9);dt.paragraphs[0].font.color.rgb=RGBColor(100,116,139)
            divider=slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,Inches(.42),Inches(.69),Inches(12.48),Inches(.018));divider.fill.solid();divider.fill.fore_color.rgb=RGBColor(203,213,225);divider.line.fill.background()
            raw=_rendered_image(page);image=Image.open(BytesIO(raw));iw,ih=image.size
            narratives=_narratives(page)
            if narratives:
                max_w,max_h=8.55,6.12;ratio=min(max_w/iw,max_h/ih);pic_w,pic_h=iw*ratio,ih*ratio
                slide.shapes.add_picture(BytesIO(raw),Inches(.42+(max_w-pic_w)/2),Inches(.84+(max_h-pic_h)/2),width=Inches(pic_w),height=Inches(pic_h))
                panel=slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,Inches(9.2),Inches(.84),Inches(3.7),Inches(6.12));panel.fill.solid();panel.fill.fore_color.rgb=RGBColor(248,250,252);panel.line.color.rgb=RGBColor(226,232,240)
                accent=slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,Inches(9.2),Inches(.84),Inches(.055),Inches(6.12));accent.fill.solid();accent.fill.fore_color.rgb=RGBColor(37,99,235);accent.line.fill.background()
                label=slide.shapes.add_textbox(Inches(9.48),Inches(1.08),Inches(3.05),Inches(.3));lt=label.text_frame;lt.text='SMART NARRATIVE';lt.paragraphs[0].font.size=Pt(10);lt.paragraphs[0].font.bold=True;lt.paragraphs[0].font.color.rgb=RGBColor(37,99,235)
                narrative_box=slide.shapes.add_textbox(Inches(9.48),Inches(1.5),Inches(3.05),Inches(5.05));nt=narrative_box.text_frame;nt.clear();nt.word_wrap=True
                for narrative_index,narrative in enumerate(narratives):
                    heading_paragraph=nt.paragraphs[0] if narrative_index==0 else nt.add_paragraph();heading_paragraph.text=narrative['title'];heading_paragraph.font.size=Pt(11);heading_paragraph.font.bold=True;heading_paragraph.font.color.rgb=RGBColor(15,23,42);heading_paragraph.space_before=Pt(2 if narrative_index==0 else 8);heading_paragraph.space_after=Pt(3)
                    for point in narrative['points']:
                        paragraph=nt.add_paragraph();paragraph.text='• '+point;paragraph.font.size=Pt(9.5);paragraph.font.color.rgb=RGBColor(51,65,85);paragraph.space_after=Pt(5)
            else:
                max_w,max_h=12.48,6.12;ratio=min(max_w/iw,max_h/ih);pic_w,pic_h=iw*ratio,ih*ratio
                slide.shapes.add_picture(BytesIO(raw),Inches(.42+(max_w-pic_w)/2),Inches(.84+(max_h-pic_h)/2),width=Inches(pic_w),height=Inches(pic_h))
            page_label=slide.shapes.add_textbox(Inches(.42),Inches(7.17),Inches(8.0),Inches(.2));pt=page_label.text_frame;pt.text=str(page.get('name') or f'Page {index}');pt.paragraphs[0].font.size=Pt(8);pt.paragraphs[0].font.color.rgb=RGBColor(100,116,139)
            footer=slide.shapes.add_textbox(Inches(10.2),Inches(7.17),Inches(2.7),Inches(.2));ft=footer.text_frame;ft.text=f'Page {index} of {len(rendered_pages)}';ft.paragraphs[0].alignment=PP_ALIGN.RIGHT;ft.paragraphs[0].font.size=Pt(8);ft.paragraphs[0].font.color.rgb=RGBColor(100,116,139)
        buf=BytesIO();prs.save(buf);return buf.getvalue()
    pages=_pages(project) or [{'name':'Page 1','visuals':[]}]
    for p in pages:
        slide=prs.slides.add_slide(prs.slide_layouts[6])
        title=slide.shapes.add_textbox(Inches(.5),Inches(.22),Inches(8.2),Inches(.45));tf=title.text_frame;tf.text=name;tf.paragraphs[0].font.size=Pt(20);tf.paragraphs[0].font.bold=True
        date_box=slide.shapes.add_textbox(Inches(9),Inches(.28),Inches(3.8),Inches(.3));dt=date_box.text_frame;dt.text=generated;dt.paragraphs[0].alignment=PP_ALIGN.RIGHT;dt.paragraphs[0].font.size=Pt(9);dt.paragraphs[0].font.color.rgb=RGBColor(100,116,139)
        divider=slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,Inches(.5),Inches(.78),Inches(12.3),Inches(.018));divider.fill.solid();divider.fill.fore_color.rgb=RGBColor(203,213,225);divider.line.fill.background()
        sub=slide.shapes.add_textbox(Inches(.5),Inches(.95),Inches(12.3),Inches(.35));st=sub.text_frame;st.text=p.get('name','Report Page');st.paragraphs[0].font.size=Pt(13)
        visuals=p.get('visuals') or []; cols=2; card_w=6.05; card_h=1.1; x0=.5;y0=1.45
        for idx,v in enumerate(visuals[:10]):
            row=idx//cols;col=idx%cols;x=x0+col*6.2;y=y0+row*1.18
            shp=slide.shapes.add_textbox(Inches(x),Inches(y),Inches(card_w),Inches(card_h));tf=shp.text_frame
            tf.text=v.get('title') or v.get('type','Visual').replace('_',' ').title();tf.paragraphs[0].font.bold=True;tf.paragraphs[0].font.size=Pt(12)
            p2=tf.add_paragraph();p2.text=f"Type: {v.get('type','visual')}";p2.font.size=Pt(9)
            vals=v.get('measures') or v.get('values') or []
            if vals:
                p3=tf.add_paragraph();p3.text='Measures: '+', '.join(map(str,vals[:4]));p3.font.size=Pt(8)
    buf=BytesIO();prs.save(buf);return buf.getvalue()

def _send_via_brevo(*, api_key:str, from_email:str, to:list[str], subject:str, body:str, html_body:str|None=None, sender_name:str|None=None, attachment_name:str|None=None, attachment:bytes|None=None):
    """Send an email using the Brevo (Sendinblue) Transactional Email REST API."""
    payload = json.dumps({
        'sender': {'email': from_email, **({'name': sender_name} if sender_name else {})},
        'to': [{'email': addr} for addr in to],
        'subject': subject,
        'textContent': body,
        **({'htmlContent': html_body} if html_body else {}),
        **({'attachment': [{'content': base64.b64encode(attachment).decode('ascii'), 'name': attachment_name or 'report.pdf'}]} if attachment else {}),
    }).encode('utf-8')
    req = urllib.request.Request(
        'https://api.brevo.com/v3/smtp/email',
        data=payload,
        method='POST',
        headers={
            'api-key': api_key,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            response_body = r.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8', errors='replace')
        raise ValueError(f'Brevo API error {e.code}: {err_body}')
    try: provider_message_id = json.loads(response_body or '{}').get('messageId')
    except Exception: provider_message_id = None
    return {'ok': True, 'recipients': to, 'providerMessageId': provider_message_id}

def send_report_email(*,smtp_cfg:dict,to:list[str],subject:str,body:str,report_url:str|None=None,attachment_name:str|None=None,attachment:bytes|None=None,attachment_type:str|None=None,html_body:str|None=None):
    content=body.strip() or 'A VTAB report has been shared with you.'
    if report_url:content+=f"\n\nOpen report: {report_url}"

    # Use the environment-driven Brevo API when configured (no SMTP needed).
    brevo_key = os.environ.get('VTAB_BREVO_API_KEY') or os.environ.get('BREVO_API_KEY') or smtp_cfg.get('brevoApiKey')
    if brevo_key:
        from_email = os.environ.get('VTAB_BREVO_FROM_EMAIL') or smtp_cfg.get('fromEmail') or smtp_cfg.get('username') or os.environ.get('VTAB_SMTP_FROM','')
        if not from_email: raise ValueError('Set VTAB_BREVO_FROM_EMAIL (the verified Brevo sender email) in your environment.')
        sender_name = os.environ.get('VTAB_BREVO_SENDER_NAME') or smtp_cfg.get('senderName') or 'VTAB Reporting Services'
        return _send_via_brevo(api_key=brevo_key, from_email=from_email, sender_name=sender_name, to=to, subject=subject, body=content, html_body=html_body, attachment_name=attachment_name, attachment=attachment)

    # Fall back to SMTP (also handles attachment emails)
    if not smtp_cfg.get('host'): raise ValueError('Email is not configured. Add VTAB_BREVO_API_KEY or configure SMTP in Admin > Email & Workspace Settings.')
    msg=EmailMessage();msg['Subject']=subject;msg['From']=smtp_cfg.get('fromEmail') or smtp_cfg.get('username');msg['To']=', '.join(to)
    msg.set_content(content)
    if html_body:msg.add_alternative(html_body,subtype='html')
    if attachment and attachment_name:
        maintype,subtype=('application','octet-stream')
        if attachment_type=='pdf':subtype='pdf'
        elif attachment_type=='pptx':subtype='vnd.openxmlformats-officedocument.presentationml.presentation'
        msg.add_attachment(attachment,maintype=maintype,subtype=subtype,filename=attachment_name)
    port=int(smtp_cfg.get('port') or (465 if smtp_cfg.get('ssl') else 587))
    cls=smtplib.SMTP_SSL if smtp_cfg.get('ssl') else smtplib.SMTP
    with cls(smtp_cfg['host'],port,timeout=20) as s:
        if not smtp_cfg.get('ssl') and smtp_cfg.get('startTls',True):s.starttls()
        if smtp_cfg.get('username'):s.login(smtp_cfg['username'],smtp_cfg.get('password',''))
        s.send_message(msg)
    return {'ok':True,'recipients':to}
