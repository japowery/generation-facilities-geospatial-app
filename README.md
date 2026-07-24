# U.S. Generation Intelligence

A deployable, browser-based intelligence platform for exploring active and retired U.S. electric generation facilities. The application combines an interactive facility map, generator-level drill-downs, fleet filters, retirement analytics, capacity trends, facility rankings, and CSV export.

The January 2026 data snapshot is compiled into `data/generation-data.js`. End users never need to find, select, or upload a data file.

## Current snapshot

| Measure | Count |
|---|---:|
| Plant-level facilities | 15,888 |
| Facilities with valid map coordinates | 15,876 |
| Generator records | 34,897 |
| Active generator records | 27,770 |
| Retired generator records | 7,127 |

The source extracts are generator-level. The build process consolidates them by plant ID so that each map marker represents a facility rather than a stacked set of generator rows. Generator records remain available inside each facility profile.

## Product capabilities

- **No data-upload workflow:** the application starts from a bundled JavaScript data store.
- **Plant-level mapping:** one marker per plant ID, with capacity dynamically recalculated from the current generator filters.
- **Generator drill-downs:** nameplate, summer and winter capacity, technology, fuel, prime mover, operating year, retirement year, and status.
- **High-value filters:** active/retired fleet, technology, state, sector, operating year, visible facility capacity, and global text search.
- **Live analytics:** capacity by technology and state, annual capacity additions, reported retirement outlook, entity counts, and fleet totals.
- **Facility explorer:** sortable, paginated facility list linked to the map and detail drawer.
- **Export:** download the current plant-level selection as CSV.
- **Shareable views:** filter state is encoded in the URL hash.
- **Responsive interface:** desktop side panels and mobile filter/analytics drawers.
- **Theme and map controls:** light/dark interface, light/dark basemaps, capacity-scaled markers, and optional heatmap.
- **Data transparency:** bundled metadata, exception counts, and explicit aggregation methodology.

## Repository structure

```text
.
├── index.html                       # Application shell
├── assets/
│   ├── app.js                       # State, filters, mapping, analytics, export, and UI logic
│   └── styles.css                   # Responsive product design system
├── data/
│   └── generation-data.js           # Generated browser-ready data store
├── scripts/
│   └── build_data.py                # CSV-to-JavaScript build pipeline
├── source-data/
│   └── README.md                    # Optional staging instructions for future extracts
├── tests/
│   └── validate_data.py             # Structural and referential data validation
├── .nojekyll                        # Direct GitHub Pages asset delivery
└── README.md
```

## Run locally

No package installation or application build is required.

```bash
python -m http.server 8000
```

Open `http://localhost:8000`.

The application uses pinned CDN versions of Leaflet, Leaflet.heat, and Chart.js. Internet access is required for those libraries and for CARTO map tiles. The facility data itself is bundled locally.

## Deploy to GitHub Pages

1. Create a GitHub repository and copy this project into the repository root.
2. Push the files to the default branch.
3. In **Settings → Pages**, select **Deploy from a branch**.
4. Select the default branch and the repository root, then save.
5. Open the Pages URL after deployment completes.

No environment variables, backend, database, or build service are required.

## Refresh the data snapshot

Place the next active and retired CSV extracts in a local directory, then run:

```bash
python scripts/build_data.py \
  --active "source-data/JAP Gen Data _ Jan 2026 (active)(U.S.).csv" \
  --retired "source-data/JAP Gen Data _ Jan 2026 (retired).csv" \
  --output "data/generation-data.js"
```

The builder:

1. validates required source columns;
2. identifies records as active or retired from the source extract;
3. groups generator rows by plant ID;
4. normalizes repeated plant metadata;
5. retains facilities without valid coordinates for analytics and lists;
6. dictionary-encodes repeated text values to reduce payload size;
7. writes a compact JavaScript data store that loads without `fetch()` or file permissions.

Update the `snapshot` value in `scripts/build_data.py` when publishing a new reporting period.

## Validate the generated store

Run this before every deployment:

```bash
python tests/validate_data.py
node --check assets/app.js
python -m py_compile scripts/build_data.py
```

The data validator confirms:

- metadata counts match the generated arrays;
- facility generator ranges are contiguous and complete;
- dictionary references are valid;
- active and retired record totals reconcile;
- mapped coordinates are valid;
- the generated store uses the expected schema version.

## Data model

### Facility record

Each facility is keyed by plant ID and stores normalized entity, plant, state, county, sector, coordinates, and the contiguous range of associated generator records.

### Generator record

Each generator stores generator ID, nameplate/summer/winter capacity, technology, energy source, prime mover, operating month/year, reported retirement month/year, detailed status, and source classification.

### Runtime aggregation

Filters are evaluated at the generator level. Passing generator records are then aggregated to the facility level. The marker size, facility capacity, charts, metrics, list, and exports therefore remain mathematically consistent with the current selection.

## Interpretation notes

- “Active” and “retired” identify the two supplied source extracts. The facility drawer also preserves each record’s detailed status.
- Reported retirement years are displayed as provided; the application does not independently predict retirements.
- Facility capacity means the sum of generator nameplate MW that pass the current filters.
- A facility may contain both active and retired generator history.
- Facilities without valid coordinates remain in analytics and exports but cannot be displayed on the map.

## Production hardening options

The current repository is ready for static deployment. For a controlled enterprise release, the next logical steps are:

- vendor the pinned third-party libraries locally and apply a strict Content Security Policy;
- add automated browser tests in CI;
- place the site behind an authenticated CDN if the data is restricted;
- document source provenance and confirm redistribution rights before publishing the dataset;
- add a scheduled data-refresh workflow if future source files are delivered consistently;
- add server-side telemetry only if usage tracking is required.

## Browser support

Current desktop and mobile versions of Chrome, Edge, Firefox, and Safari are supported. JavaScript must be enabled.
