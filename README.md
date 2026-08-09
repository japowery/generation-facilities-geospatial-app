# U.S. Generation Intelligence

<p align="center">
  <strong>An interactive geospatial intelligence platform for the U.S. electric generation fleet.</strong><br>
  Explore facilities, drill into generators, compare capacity, and investigate the reported retirement outlook from one focused map-first workspace.
</p>

<p align="center">
  <a href="#run-locally">Run locally</a> ·
  <a href="#windows-desktop-release">Windows release</a> ·
  <a href="#data-and-methodology">Data and methodology</a> ·
  <a href="https://github.com/japowery/generation-facilities-geospatial-app/actions/workflows/quality.yml">Quality checks</a>
</p>

## Why this project

U.S. Generation Intelligence turns generator-level records into a fast, self-contained facility explorer. It keeps the map, filters, analytics, facility list, profiles, and exports synchronized as the selection changes, so a question can move from national context to individual generator detail without leaving the application.

The application is a static release: the dataset is bundled locally, there is no backend to configure, and no user upload step. The same source can run in a browser, deploy to GitHub Pages, or be packaged as the supplied Windows desktop executable.

## Current release

**Version 3.0.1**

| Measure | Value |
| --- | ---: |
| Plant-level facilities | 15,887 |
| Facilities with valid map coordinates | 15,876 |
| Generator records | 34,894 |
| Active generator records | 27,768 |
| Retired generator records | 7,126 |
| Nameplate capacity | 1,673,828.5 MW |

The generated store records its own schema version, reporting period, source-row reconciliation, missing-coordinate counts, and other quality counters. The current release intentionally excludes the raw CSV extracts; see [`source-data/README.md`](source-data/README.md) for the controlled refresh workflow.

## Product capabilities

- **Map-first exploration:** zoom-adaptive facility markers, capacity-scaled dots, optional heatmap, light/dark basemaps, and a national reset view.
- **Fleet filters:** active/retired status, technology, state, sector, operating year, visible capacity, and global facility/entity/county search.
- **Generator-level detail:** nameplate, summer and winter capacity, technology, fuel, prime mover, operating year, reported retirement year, and source status.
- **Live intelligence:** capacity by technology and state, annual capacity additions, reported retirements, fleet totals, facility rankings, and entity counts.
- **Operational workflow:** sortable/paginated facility explorer, linked map/detail drawer, CSV export, and shareable filter state encoded in the URL hash.
- **Responsive design:** desktop side panels, mobile drawers, keyboard navigation, accessible status announcements, and theme persistence.

## Windows desktop release

The recommended release is available at [`dist/US_Generation_Intelligence_v3.0.1.exe`](dist/US_Generation_Intelligence_v3.0.1.exe). The supplied `v3.0.0` executable is retained beside it as a provenance reference. Verify either download against [`dist/SHA256SUMS.txt`](dist/SHA256SUMS.txt) before distributing it.

```powershell
Get-FileHash .\dist\US_Generation_Intelligence_v3.0.0.exe -Algorithm SHA256
```

The executable is a self-contained WebView2 desktop wrapper around the static application. Windows systems need the Microsoft Edge WebView2 Runtime available. The executable is unsigned, so Windows SmartScreen may display an unrecognized-publisher warning on first launch.

The binary is a convenience distribution artifact; the editable application source remains the authoritative implementation in this repository.

The wrapper is reproducible from [`desktop/`](desktop/):

```powershell
.\desktop\build_windows.ps1
```

That script creates a clean `v3.0.1` build from the current source. An optional courtesy password gate can be enabled at build time without committing the password; see [`desktop/README.md`](desktop/README.md).

## Run locally

The runtime needs only Python’s standard-library HTTP server. From the repository root:

```bash
python -m http.server 8000
```

Open <http://localhost:8000>. A local HTTP server is recommended because the application loads bundled JavaScript, vendor assets, and map resources; opening `index.html` directly from `file://` can produce browser restrictions.

The facility data is local. The light and dark background maps are requested from CARTO, so an internet connection is needed for the geographic basemap; the analytics, list, profiles, filters, and export remain available if tile requests fail.

## Repository map

```text
.
├── index.html                    # Application shell and accessible UI structure
├── assets/
│   ├── app.js                    # State, filters, map, analytics, detail, export
│   ├── styles.css                # Responsive visual system and themes
│   └── theme-init.js             # No-flash theme initialization
├── data/
│   └── generation-data.js        # Generated browser-ready January 2026 store
├── dist/
│   ├── US_Generation_Intelligence_v3.0.0.exe  # Supplied reference build
│   ├── US_Generation_Intelligence_v3.0.1.exe  # Recommended source-built release
│   └── SHA256SUMS.txt
├── desktop/
│   ├── main.py                  # Loopback/WebView2 desktop wrapper
│   ├── build_windows.ps1        # Reproducible Windows build
│   └── README.md                # Optional password-gate guidance
├── scripts/
│   └── build_data.py             # CSV-to-JavaScript data pipeline
├── source-data/
│   └── README.md                 # Private/staged source-data instructions
├── tests/
│   ├── browser_smoke.mjs         # Optional Chromium smoke coverage
│   ├── test_build_data.py        # Builder unit tests
│   ├── test_characterization.py  # Release regression invariants
│   ├── test_validate_data.py     # Validator unit tests
│   └── validate_data.py          # Generated-store validator
├── vendor/                       # Pinned browser libraries and licenses
├── .github/workflows/quality.yml # Automated release checks
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
├── SECURITY.md
└── THIRD_PARTY_NOTICES.md
```

## Data and methodology

The source extracts are generator-level. The build pipeline:

1. validates required headers and records missing optional columns;
2. skips only rows whose parsed source cells are completely empty;
3. classifies rows as active or retired from the input file assignment;
4. groups records by plant ID and normalizes repeated facility metadata;
5. retains facilities without valid coordinates for analytics, lists, profiles, and exports;
6. dictionary-encodes repeated text to keep the browser payload compact; and
7. writes the generated JavaScript store only after serialization succeeds.

At runtime, filters are applied to generators first. Passing generators are then aggregated to facilities, which keeps marker sizes, facility capacity, charts, metrics, rankings, and CSV exports mathematically consistent with the current selection.

Interpretation boundaries:

- “Active” and “retired” identify the supplied source extracts; detailed status text is preserved separately.
- Reported retirement years are source values, not independent forecasts.
- Facility capacity is the sum of nameplate MW for generators passing the current filters.
- A facility can contain both active and retired generator history.
- Facilities without valid coordinates remain useful in non-map views but cannot appear as map markers.

## Refresh the data snapshot

Keep raw extracts in a controlled, non-published location. If they are staged under `source-data/`, the repository ignores CSV files by default.

```bash
python scripts/build_data.py \
  --active "source-data/JAP Gen Data _ Jan 2026 (active)(U.S.).csv" \
  --retired "source-data/JAP Gen Data _ Jan 2026 (retired).csv" \
  --output "data/generation-data.js" \
  --snapshot "January 2026" \
  --as-of-year 2026 \
  --retirement-kpi-end-year 2035 \
  --retirement-chart-end-year 2050 \
  --facility-page-size 25
```

Before publishing a new snapshot, record the source provenance, reporting period, received date, file sizes, SHA-256 checksums, and redistribution rights. Update the characterization test deliberately when a data correction is intended.

## Verify a release

The standard-library checks run without installing application dependencies:

```bash
python -m unittest discover -s tests -p "test_*.py"
python tests/validate_data.py
python -O tests/validate_data.py
python -m py_compile scripts/build_data.py tests/validate_data.py
node --check assets/app.js
node --check tests/browser_smoke.mjs
```

The optional browser smoke test requires Node.js 20+, Playwright, and a Chromium installation:

```bash
npm ci
npx playwright install chromium
npm run test:browser
```

GitHub Actions runs the repeatable Python and JavaScript checks on pushes and pull requests. Firefox and WebKit should be added before making a tested cross-browser support claim.

## Deploy to GitHub Pages

This is a static site and can be deployed directly from the repository:

1. open **Settings → Pages**;
2. choose **Deploy from a branch**;
3. select `main` and the repository root; and
4. open the generated Pages URL after deployment completes.

For a controlled deployment, configure the host with a strict Content Security Policy, `X-Content-Type-Options`, appropriate cache headers, and a licensed tile source. Remember that any data bundled into a client-side application is downloadable by anyone who can open it.

## Security and password protection

This repository does not commit a password or claim that the supplied EXE provides strong access control. A password embedded in a client-distributed executable can be extracted by a determined user. For genuinely restricted data, use authenticated hosting, encrypted distribution, or per-user licensing outside the static client.

If a lightweight courtesy gate is still desirable for an internal handoff, add it at the desktop-wrapper layer and treat it as a deterrent only. See [`SECURITY.md`](SECURITY.md) before distributing a protected build.

## Ownership and attribution

U.S. Generation Intelligence was built by **Jason Powery**.

The original application code and bundled data are released under the repository’s proprietary terms. Vendored libraries remain under their own licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## License

Copyright © 2026 Jason Powery. All rights reserved. See [`LICENSE`](LICENSE) for the repository terms.
