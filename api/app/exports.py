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
    result=[];point_count=0
    for item in (page or {}).get('narratives') or []:
        if not isinstance(item,dict):continue
        title=' '.join(str(item.get('title') or 'Visual').split())[:70]
        points=[]
        for value in item.get('points') or []:
            text=' '.join(str(value).split())[:150]
            if text and text not in points:
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

def report_pdf(project:dict,rendered_pages:list[dict]|None=None)->bytes:
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import landscape, A4
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
    for i,p in enumerate(pages,1):
        c.setFillColor(colors.white);c.rect(0,0,W,H,stroke=0,fill=1)
        c.setFillColor(colors.HexColor('#0f172a'));c.setFont('Helvetica-Bold',16);c.drawString(28,H-30,name[:90])
        c.setFillColor(colors.HexColor('#64748b'));c.setFont('Helvetica',9);c.drawRightString(W-28,H-29,generated)
        c.setStrokeColor(colors.HexColor('#cbd5e1'));c.setLineWidth(.8);c.line(28,H-43,W-28,H-43)
        c.setFillColor(colors.HexColor('#111827'));c.setFont('Helvetica-Bold',15);c.drawString(28,H-68,p.get('name') or f'Page {i}')
        y=H-100
        for v in (p.get('visuals') or [])[:18]:
            title=v.get('title') or v.get('type','Visual').replace('_',' ').title(); typ=v.get('type','visual')
            c.setFillColor(colors.HexColor('#f8fafc'));c.roundRect(28,y-38,W-56,32,8,stroke=1,fill=1)
            c.setFillColor(colors.HexColor('#0f172a'));c.setFont('Helvetica-Bold',10);c.drawString(40,y-20,title)
            c.setFillColor(colors.HexColor('#64748b'));c.setFont('Helvetica',8);c.drawRightString(W-40,y-20,typ)
            y-=42
            if y<40: break
        c.setFillColor(colors.HexColor('#64748b'));c.setFont('Helvetica',8);c.drawRightString(W-28,18,f'Page {i} of {len(pages)} · Exported from VTAB Reporting Studio')
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
            max_w,max_h=8.55,6.12;ratio=min(max_w/iw,max_h/ih);pic_w,pic_h=iw*ratio,ih*ratio
            slide.shapes.add_picture(BytesIO(raw),Inches(.42+(max_w-pic_w)/2),Inches(.84+(max_h-pic_h)/2),width=Inches(pic_w),height=Inches(pic_h))
            panel=slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,Inches(9.2),Inches(.84),Inches(3.7),Inches(6.12));panel.fill.solid();panel.fill.fore_color.rgb=RGBColor(248,250,252);panel.line.color.rgb=RGBColor(226,232,240)
            accent=slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,Inches(9.2),Inches(.84),Inches(.055),Inches(6.12));accent.fill.solid();accent.fill.fore_color.rgb=RGBColor(37,99,235);accent.line.fill.background()
            label=slide.shapes.add_textbox(Inches(9.48),Inches(1.08),Inches(3.05),Inches(.3));lt=label.text_frame;lt.text='SMART NARRATIVE';lt.paragraphs[0].font.size=Pt(10);lt.paragraphs[0].font.bold=True;lt.paragraphs[0].font.color.rgb=RGBColor(37,99,235)
            narrative_box=slide.shapes.add_textbox(Inches(9.48),Inches(1.5),Inches(3.05),Inches(5.05));nt=narrative_box.text_frame;nt.clear();nt.word_wrap=True
            narratives=_narratives(page)
            if not narratives:
                paragraph=nt.paragraphs[0];paragraph.text='No numeric findings are available for this page.';paragraph.font.size=Pt(10);paragraph.font.color.rgb=RGBColor(71,85,105)
            for narrative_index,narrative in enumerate(narratives):
                heading_paragraph=nt.paragraphs[0] if narrative_index==0 else nt.add_paragraph();heading_paragraph.text=narrative['title'];heading_paragraph.font.size=Pt(11);heading_paragraph.font.bold=True;heading_paragraph.font.color.rgb=RGBColor(15,23,42);heading_paragraph.space_before=Pt(2 if narrative_index==0 else 8);heading_paragraph.space_after=Pt(3)
                for point in narrative['points']:
                    paragraph=nt.add_paragraph();paragraph.text='• '+point;paragraph.font.size=Pt(9.5);paragraph.font.color.rgb=RGBColor(51,65,85);paragraph.space_after=Pt(5)
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

def _send_via_brevo(*, api_key:str, from_email:str, to:list[str], subject:str, body:str):
    """Send a plain-text email using the Brevo (Sendinblue) Transactional Email REST API."""
    payload = json.dumps({
        'sender': {'email': from_email},
        'to': [{'email': addr} for addr in to],
        'subject': subject,
        'textContent': body,
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
            r.read()
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8', errors='replace')
        raise ValueError(f'Brevo API error {e.code}: {err_body}')
    return {'ok': True, 'recipients': to}

def send_report_email(*,smtp_cfg:dict,to:list[str],subject:str,body:str,report_url:str|None=None,attachment_name:str|None=None,attachment:bytes|None=None,attachment_type:str|None=None):
    content=body.strip() or 'A VTAB report has been shared with you.'
    if report_url:content+=f"\n\nOpen report: {report_url}"

    # Use Brevo REST API if BREVO_API_KEY is configured (no SMTP needed)
    brevo_key = os.environ.get('BREVO_API_KEY') or smtp_cfg.get('brevoApiKey')
    if brevo_key:
        from_email = smtp_cfg.get('fromEmail') or smtp_cfg.get('username') or os.environ.get('VTAB_SMTP_FROM','')
        if not from_email: raise ValueError('Set VTAB_SMTP_FROM (the verified sender email) in your .env file.')
        # Attachments via Brevo API require base64 encoding — for now fall through to SMTP if attachment present
        if not attachment:
            return _send_via_brevo(api_key=brevo_key, from_email=from_email, to=to, subject=subject, body=content)

    # Fall back to SMTP (also handles attachment emails)
    if not smtp_cfg.get('host'): raise ValueError('SMTP host is not configured. Add BREVO_API_KEY or configure SMTP in Admin > Email & Workspace Settings.')
    msg=EmailMessage();msg['Subject']=subject;msg['From']=smtp_cfg.get('fromEmail') or smtp_cfg.get('username');msg['To']=', '.join(to)
    msg.set_content(content)
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
