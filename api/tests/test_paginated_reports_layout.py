import unittest
from unittest import mock
from io import BytesIO
from pypdf import PdfReader
from app.paginated_reports import _compute_column_widths, _page_size, render_paginated_pdf


class PaginatedReportLayoutTests(unittest.TestCase):
    def setUp(self):
        self.sample_columns_20 = [
            {"field": "si_no", "label": "SI NO"},
            {"field": "date", "label": "Date"},
            {"field": "patient_name", "label": "Patient Name"},
            {"field": "age", "label": "Age"},
            {"field": "gender", "label": "Gender"},
            {"field": "doctor_name", "label": "Doctor Name"},
            {"field": "speciality", "label": "Speciality"},
            {"field": "department", "label": "Department"},
            {"field": "bed_room", "label": "Bed / Room"},
            {"field": "admission_date", "label": "Admission Date"},
            {"field": "discharge_date", "label": "Discharge Date"},
            {"field": "diagnosis", "label": "Diagnosis"},
            {"field": "chief_complaint", "label": "Chief Complaint"},
            {"field": "procedure_done", "label": "Procedure Done"},
            {"field": "medications", "label": "Medications Prescribed"},
            {"field": "nursing_care", "label": "Nursing Care"},
            {"field": "lab_tests", "label": "Lab Tests Done"},
            {"field": "radiology", "label": "Radiology / Imaging"},
            {"field": "billing_amount", "label": "Billing Amount"},
            {"field": "payment_status", "label": "Payment Status"},
        ]
        self.sample_rows_20 = [
            {
                "si_no": i + 1,
                "date": "2026-10-08",
                "patient_name": f"Patient {i+1} Smith",
                "age": 45 + (i % 30),
                "gender": "Female" if i % 2 == 0 else "Male",
                "doctor_name": f"Dr. Specialist {i+1}",
                "speciality": "Cardiology",
                "department": "Critical Care Unit",
                "bed_room": f"ICU-{i+1:02d}",
                "admission_date": "2026-10-01",
                "discharge_date": "2026-10-08",
                "diagnosis": "Severe acute respiratory distress syndrome with multiple complications and comorbidities",
                "chief_complaint": "Persistent shortness of breath, high fever, and chest tightness for 4 days",
                "procedure_done": "Bronchoscopy and non-invasive positive pressure ventilation support",
                "medications": "Amoxicillin 500mg, Paracetamol 650mg, Salbutamol Inhaler, Dexamethasone 4mg",
                "nursing_care": "Positioning every 2 hours, chest physiotherapy, vitals monitoring every hour",
                "lab_tests": "CBC, ESR, CRP, Arterial Blood Gases, D-Dimer, Troponin-T",
                "radiology": "High Resolution Computed Tomography Chest, Bedside Ultrasound",
                "billing_amount": f"${1500 + i * 200:,.2f}",
                "payment_status": "Insurance Approved",
            }
            for i in range(25)
        ]

    def test_compute_column_widths_balances_short_and_long_fields(self):
        max_width = 750.0
        widths = _compute_column_widths(self.sample_columns_20, self.sample_rows_20, max_width, scale_factor=0.7)
        self.assertEqual(len(widths), 20)
        self.assertAlmostEqual(sum(widths), max_width, places=2)
        # Verify SI NO is significantly narrower than Medications Prescribed
        si_no_width = widths[0]
        meds_width = widths[14]
        self.assertLess(si_no_width, meds_width / 2)
        self.assertGreater(si_no_width, 18.0)

    def test_page_size_auto_detects_landscape_for_wide_tables(self):
        # 20 columns should automatically return landscape dimensions (width > height)
        wide_def = {
            "page": {"size": "A4", "orientation": "portrait"},
            "table": {"columns": self.sample_columns_20},
        }
        size = _page_size(wide_def, columns=self.sample_columns_20)
        self.assertGreater(size[0], size[1], "Wide 20-column table should auto-orient to landscape")

        # 4 columns should respect portrait
        narrow_cols = self.sample_columns_20[:4]
        narrow_def = {
            "page": {"size": "A4", "orientation": "portrait"},
            "table": {"columns": narrow_cols},
        }
        narrow_size = _page_size(narrow_def, columns=narrow_cols)
        self.assertLess(narrow_size[0], narrow_size[1], "Narrow 4-column table should maintain portrait")

    @mock.patch("app.paginated_reports.execute")
    def test_render_paginated_pdf_exports_multi_page_landscape_report(self, mock_execute):
        mock_execute.return_value = (self.sample_rows_20, "SELECT 1")
        project = {
            "model": {
                "tables": {},
                "measures": {},
            },
            "paginatedReports": [
                {
                    "id": "report-clinical-001",
                    "name": "Clinical Inpatient Report",
                    "page": {"size": "A4", "orientation": "portrait", "headerHeightMm": 12, "footerHeightMm": 10},
                    "header": {
                        "visible": True,
                        "items": [
                            {"type": "text", "value": "{{Report.Name}}", "fontSize": 12, "bold": True, "align": "left"}
                        ],
                    },
                    "footer": {
                        "visible": True,
                        "items": [
                            {"type": "text", "value": "Page {{Report.PageNumber}} of {{Report.TotalPages}}", "fontSize": 8, "align": "right"}
                        ],
                    },
                    "table": {
                        "columns": self.sample_columns_20,
                        "repeatHeader": True,
                        "alternateRows": True,
                    },
                }
            ],
        }

        pdf_bytes, filename, count = render_paginated_pdf(project, "report-clinical-001")
        self.assertEqual(count, 25)
        self.assertTrue(filename.endswith(".pdf"))
        self.assertGreater(len(pdf_bytes), 1000)

        reader = PdfReader(BytesIO(pdf_bytes))
        self.assertGreaterEqual(len(reader.pages), 2, "25 detailed rows should span at least 2 pages")

        for page in reader.pages:
            box = page.mediabox
            self.assertGreater(box.width, box.height, "Each generated page should be landscape orientation")
            text = page.extract_text()
            self.assertIn("Clinical Inpatient Report", text)
            self.assertIn("Diagnosis", text)
            self.assertIn("Medications", text)
            self.assertIn("Prescribed", text)


if __name__ == "__main__":
    unittest.main()
