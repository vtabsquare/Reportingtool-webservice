# VTAB 5.0.16 — Web Tool version mismatch fix

## Finding from the recording and live check

The report exists in My Reports and My Workspace, but every visual fails when
View is selected. The active Services API on port 8830 reports version 5.0.8
and does not contain the workspace-report listing endpoint introduced later.
The Web Tool folder is still named and based on `VTAB-Services-Web-Tool-5.0.8`,
even though some newer interface files were copied into it.

This mixed installation is why the interface opens normally while published
queries continue to use the old service behavior.

## Complete fix

- Desktop and Web Tool source versions are aligned at 5.0.16.
- Web Tool startup verifies its API health version matches `package.json`.
- Startup also verifies the required publish, workspace, and published-query
  endpoints before opening the website.
- A stale or incomplete backend now produces a clear startup error instead of
  opening a website where every visual fails.
- The 5.0.14 private-snapshot upload/download repair remains included.

## Required sequence

1. Stop both applications and their Python windows.
2. Copy the Desktop update files into the Desktop source folder.
3. Copy the Web Tool update files into
   `D:\Python\VTAB-Services-Web-Tool-5.0.8`.
4. Do not replace either existing environment file.
5. Confirm the Web Tool `web.env` contains port 8830 for both
   `VITE_API_URL` and `VTAB_API_PORT`.
6. Build and install Desktop 5.0.16.
7. Start the Web Tool with `python run_web_tool.py`. It must print
   `Version: 5.0.16` before saying it is ready.
8. Open the report in Desktop and publish it again. Choose Yes, Replace.
9. Open My Reports in the Web Tool and select View.

The republish is required once because the older published version was created
without a usable private data snapshot.
