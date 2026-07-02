# US Generation Facilities Map

A browser-based map and analytics dashboard for exploring active and retired U.S. electric generation facilities by technology, entity, state, sector, operating year, nameplate capacity, and retirement status.

## Overview

US Generation Facilities Map is a standalone HTML, CSS, and JavaScript application for visualizing power generation assets across the United States. It loads active and retired generation facility CSV files, plots facilities on an interactive Leaflet map, and updates charts, heatmaps, choropleths, and summary metrics as filters change.

The application is designed for quick portfolio review, technology mix analysis, generation asset mapping, retirement screening, entity-level analysis, and exploratory review of plant age, capacity, and geographic concentration.

## Key Features

- Load active and retired generation facility CSV files from the local folder or through the file picker
- Auto-load default CSV files when they are stored next to the HTML file
- Map facilities using latitude and longitude
- Display facility-level popup details with entity name, plant name, technology, sector, state, county, nameplate MW, operating year, retirement year, status, and Google Maps link
- Filter facilities by active or retired status
- Filter by technology using quick chips for solar, wind, hydro, nuclear, natural gas, coal, petroleum, renewables, fossil, and batteries
- Use single-select or multi-select technology filtering
- Filter by entity name, plant name, sector, state, operating year range, and nameplate MW range
- Use temporal mode to animate facilities commissioned through a moving cutoff year
- Show visible facility count and visible nameplate MW
- Display a heatmap overlay weighted by nameplate MW
- Display a state choropleth shaded by filtered total MW
- Resize filter and analytics side panels
- Switch between day and night base maps
- Fit the map to loaded data

## Analytics Included

The analytics panel updates live with the current filters and includes:

- Total visible nameplate MW
- Visible facility count
- Entity count
- State count
- Average life span for facilities with retirement year data
- Median life span for facilities with retirement year data
- MW by technology, top 12
- MW by state, top 12
- Average life span by technology
- Average life span by state
- Cumulative MW over operating year
- Top entities by MW

Interactive chart elements can be used to isolate technologies, toggle state filters, or set an entity filter.

## Technology Stack

- HTML
- CSS
- JavaScript
- Leaflet for interactive maps
- Carto basemaps for day and night map tiles
- Leaflet.heat for heatmap visualization
- Papa Parse for CSV parsing
- Tom Select for multi-select filter controls
- Chart.js for analytics charts

The application runs in the browser and does not require a backend server.

## Expected Input Files

The app attempts to auto-load these files from the same folder as the HTML file:

```text
JAP Gen Data _ Jan 2026 (active).csv
JAP Gen Data _ Jan 2026 (retired).csv
```

If browser security blocks local file access, or if the CSVs have different names, use the file picker to select one or both CSVs manually.

## Expected CSV Fields

The parser is designed to recognize fields such as:

- `Entity Name`
- `Plant Name`
- `Plant State` or `State`
- `County`
- `Sector`
- `Technology`
- `Nameplate Capacity (MW)`, `Nameplate MW`, or `Nameplate Capacity`
- `Operating Year` or `Online Year`
- `Status`
- `Latitude` or `Lat`
- `Longitude`, `Lon`, or `Lng`
- `Planned Retirement Year`, `Retirement Year`, or similar retirement-year field

Rows without valid latitude and longitude are skipped because they cannot be mapped.

## How to Use

1. Download or clone the repository.
2. Place the HTML file and the two generation CSVs in the same folder.
3. Open `jap_us_generation_facilities_application_v20.html` in a modern browser, or serve the folder with a local static server.
4. If the CSVs do not auto-load, click `Load from folder` or use the file picker to select the active and retired CSV files.
5. Use the Data tab to filter by technology, entity, plant, sector, state, year range, MW range, and active or retired status.
6. Use the Settings tab to control the technology legend, heatmap overlay, heat radius, heat blur, and state choropleth.
7. Use the Analytics panel to review filtered totals, charts, life span metrics, cumulative MW, and top entities.
8. Click a facility dot to view facility details and open the location in Google Maps.

## Local Development

For best results, serve the project from a local static server. This avoids common browser restrictions when an HTML file opened with `file://` tries to read neighboring CSV files.

Example using Python:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000/jap_us_generation_facilities_application_v20.html
```

On Windows, if the Python launcher is configured as `py`, use:

```bash
py -m http.server 8000
```

## Expected Project Layout

```text
project-folder/
  jap_us_generation_facilities_application_v20.html
  JAP Gen Data _ Jan 2026 (active).csv
  JAP Gen Data _ Jan 2026 (retired).csv
  README.md
```

## Data Interpretation Notes

Dot size is scaled by nameplate MW with an upper percentile cap so very large plants do not dominate the map. The heatmap is also weighted by nameplate MW and rescales as filters change.

Life span metrics require both operating year and retirement year. Active facilities or records without retirement year data will not contribute to average or median life span calculations.

The state choropleth is based only on facilities visible under the current filters, not the entire loaded dataset.

## Data Privacy Note

Do not add confidential client data, proprietary asset lists, or non-public planning assumptions to a public repository. Use public, synthetic, or approved datasets when presenting this project externally.

## Future Improvements

Potential next steps include:

- Add downloadable filtered CSV exports
- Add saved filter presets
- Add source-data documentation and refresh scripts
- Add offline/local copies of external JavaScript and CSS dependencies
- Add state, entity, and technology summary tables
- Add map screenshot export
- Add unit tests for parsing, filtering, and aggregation logic
