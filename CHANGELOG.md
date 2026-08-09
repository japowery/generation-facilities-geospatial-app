# Changelog

## [3.0.1] — 2026-08-09

### Added

- Added a reproducible WebView2 desktop wrapper under `desktop/` and rebuilt the recommended Windows artifact from the current source.
- Added the author credit to the packaged application and an opt-in build-time courtesy password gate that never stores the password in source control.
- Kept the supplied `v3.0.0` executable in `dist/` as a provenance reference; `v3.0.1` is the recommended desktop download.

## [3.0.0] — 2026-07-28

### Added

- Replaced the legacy repository-only artifact collection with the complete v3 static application source.
- Added the bundled January 2026 generation data store, vendor libraries, licenses, data builder, tests, and browser smoke coverage.
- Added the supplied Windows WebView2 desktop executable under `dist/` with a SHA-256 checksum file.
- Added automated repository quality checks, contribution guidance, security guidance, citation metadata, and release notes.

### Removed

- Removed the four screenshots and two ZIP archives from the prior repository version.

### Data correction carried forward

- The v3 snapshot excludes three delimiter-only source rows that previously created a synthetic blank facility. The generated-store counts and characterization tests document the corrected totals.
