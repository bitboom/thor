# Synthetic Office and HTML acceptance fixtures

These fixtures use invented Lantern project data. They contain no real mail, people, documents, credentials, or enterprise services. They exercise product behavior and do not prove enterprise integration or full Microsoft Office fidelity.

Generate fresh files into an empty directory with the bundled Python runtime and its `python-docx`, `openpyxl`, `python-pptx`, and Pillow libraries:

```powershell
& <bundled-python> tests/office/generate_fixtures.py --output-dir <empty-fixture-directory>
& <bundled-python> tests/office/generate_fixtures.py --output-dir <fixture-directory> --verify-only
node tests/office/generate-html.mjs <empty-html-fixture-directory>
```

The generator creates three originals and three separately modified copies for each of DOCX, XLSX, and PPTX. `manifest.json` records each original and copy SHA-256, Korean title, and numeric values. The copy marker is `복사본 수정 확인`. The original is hashed before the copy is changed and must still match. `--verify-only` checks byte hashes and expected package features; use new copies for subsequent manual edits, because those edits intentionally change the recorded hashes.

| Case | Title | Values |
| --- | --- | --- |
| `01-overview` | 출시 준비 현황 | 4, 7, 6 |
| `02-operations` | 운영 점검 기록 | 3, 5, 8 |
| `03-summary` | 검토 결과 요약 | 6, 2, 9 |

Each DOCX contains Korean text, a merged table and a synthetic image. Each XLSX contains Korean text, merged cells, `=SUM(C3:C5)`, an editable chart and an image. Each PPTX has two slides, Korean text, a merged table, an editable chart and an image. Independently inspect originals and copies in Thor and the native Office application: compare text, table boundaries, fonts, images and chart labels; verify the second slide and copy marker; edit a **new** copy and check the original hash, chart, image, table and formulas are retained. OfficeCLI `validate` checks OpenXML schema, not rendering fidelity. The installed Microsoft 365 on the test machine was in expired/read-only mode; native editing and saved-copy fidelity remain unverified.

To test an external edit and preview refresh, open an original's disposable copy in Thor, change and flush it with a separate tool, then use the preview refresh control. Check that the changed value appears and that a failed refresh does not clear the update state. A successful OfficeCLI operation must be saved or closed before another program reads it; the pinned CLI documents the distinction between resident changes and flushed bytes.

`dashboard.html` is generated from the public `att-launch-tasks` CSV. It starts with two tasks; the Done and In progress filters each show one. Test it in Thor's desktop HTML preview. The desktop preview permits inline scripts but blocks file/network requests; external scripts, styles, images and relative local assets are not available. Browser-mode iframe scripting is disabled. No full Office fidelity or offline font fidelity is implied by a successful dashboard test.

For the adversarial preview check, run `node tests/office/preview-canary-server.mjs` and open `preview-isolation.html` in Thor. The page attempts to read a synthetic local canary, detect an Electron bridge and request the loopback canary endpoint. Check the page and `http://127.0.0.1:18765/state`: a readable canary, exposed bridge, or nonzero probe count is a failure. If the server is not listening, the page script does not execute, or output is unavailable, the corresponding result is inconclusive. The server receives only a synthetic request and no document contents. Stop it after the test.

For the pinned OfficeCLI v1.0.159 desktop watch viewer, the guest permits only `GET /` (the rendered page) and `GET /events` (SSE), with no query string, on that viewer's exact loopback port. Other paths, methods and origins are blocked. The upstream watch server's `/api/switch`, `/api/send` and `/api/batch` are state-changing POST routes and are blocked from the preview; Core performs its authorized refresh outside the guest session. The policy is based on the pinned [watch server](https://github.com/iOfficeAI/OfficeCLI/blob/v1.0.159/src/officecli/Core/Watch/WatchServer.cs) and [SSE client](https://github.com/iOfficeAI/OfficeCLI/blob/v1.0.159/src/officecli/Resources/watch-sse-core.js). Test after any OfficeCLI upgrade because routes or asset requirements may change.

On the 2026-10-28 local run, OfficeCLI v1.0.159 returned successful schema validation for all 18 v3 files. The CLI changed and closed one disposable copy per format; independent parsers confirmed the requested text/cell edits and presence of tables, formulas, charts, images, and slides, while all original hashes matched the manifest. These checks did not exercise native Office save behavior or compare rendered appearance.
