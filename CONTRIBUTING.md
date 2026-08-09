# Contributing

This repository is maintained as a curated application and portfolio release. Changes should keep the public tree reproducible, legible, and free of private source extracts.

## Before opening a change

- Keep raw CSV extracts out of commits; `source-data/*.csv` is ignored by default.
- Preserve the source reporting period and document any data correction in `CHANGELOG.md`.
- Keep third-party assets pinned and update their local notices when versions change.
- Do not add passwords, API keys, private facility data, or machine-specific build output.

## Required checks

```bash
python -m unittest discover -s tests -p "test_*.py"
python tests/validate_data.py
python -O tests/validate_data.py
python -m py_compile scripts/build_data.py tests/validate_data.py
node --check assets/app.js
node --check tests/browser_smoke.mjs
```

For UI changes, also run the optional Chromium smoke test described in the README and manually check a narrow mobile viewport and a wide desktop viewport.

## Data refreshes

Follow the staging and provenance checklist in [`source-data/README.md`](source-data/README.md). The generated store is a release artifact; it should only be updated from a reviewed, attributable input snapshot.
