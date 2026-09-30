# Reporting Services Export Fix - 5.2.3

## Corrected behavior

- PDF and PowerPoint export now waits for the requested report page to mount and for every visible visual query to finish.
- Export stops with a clear message when a visual fails or when page data does not finish loading within 60 seconds. It no longer silently captures an empty page.
- Fonts and page images are awaited before capture.
- A final 900 ms settling period allows ECharts canvas animations to complete.
- Every exported PDF page and PowerPoint slide now contains the report name, generated UTC date and time, a divider, the complete report-page image, the report-page name, and page numbering.
- PowerPoint exports contain one slide per report page without an additional cover slide.

## Verification

- Production web build completed successfully.
- PDF and PowerPoint files were generated from a two-page fixture.
- Both PDF pages and both PowerPoint slides were rendered and visually inspected.
- Automated tests verify the header, generated date, report image, page numbering, and data-readiness mechanism.
