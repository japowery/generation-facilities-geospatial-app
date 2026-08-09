#!/usr/bin/env python3
"""Build the browser-ready generation data store from active and retired CSV extracts."""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable, MutableMapping

SCHEMA_VERSION = 1
DEFAULT_SNAPSHOT = "January 2026"
DEFAULT_AS_OF_YEAR = 2026
DEFAULT_RETIREMENT_KPI_END_YEAR = 2035
DEFAULT_RETIREMENT_CHART_END_YEAR = 2050
DEFAULT_FACILITY_PAGE_SIZE = 25

REQUIRED_COLUMNS = frozenset({
    "Entity ID",
    "Entity Name",
    "Plant ID",
    "Plant Name",
    "Plant State",
    "County",
    "Sector",
    "Generator ID",
    "Nameplate Capacity (MW)",
    "Technology",
    "Operating Year",
    "Status",
    "Latitude",
    "Longitude",
})

# These fields enrich the application but were not required by the original builder.
# Their absence remains non-fatal and is now recorded in metadata.
OPTIONAL_COLUMNS = frozenset({
    "Net Summer Capacity (MW)",
    "Net Winter Capacity (MW)",
    "Energy Source Code",
    "Prime Mover Code",
    "Operating Month",
    "Planned Retirement Month",
    "Planned Retirement Year",
})

STORE_COMMENT = "/* Generated file. Run scripts/build_data.py to refresh. */\n"
STORE_PREFIX = "window.GENERATION_DATA="
STORE_SUFFIX = ";\n"


def clean(value: Any) -> str:
    """Return a trimmed string while preserving valid falsy values such as zero."""
    return "" if value is None else str(value).strip()


def number(value: Any) -> float | None:
    """Parse a finite number, accepting comma-grouped source values."""
    text = clean(value).replace(",", "")
    if not text:
        return None
    try:
        parsed = float(text)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def integer(value: Any) -> int | None:
    """Parse an integer without silently truncating a fractional source value."""
    text = clean(value).replace(",", "")
    if not text:
        return None
    try:
        parsed = Decimal(text)
    except (InvalidOperation, ValueError):
        return None
    if not parsed.is_finite() or parsed != parsed.to_integral_value():
        return None
    return int(parsed)


def mode(values: Iterable[str], fallback: str = "") -> str:
    candidates = [value for value in values if value]
    return Counter(candidates).most_common(1)[0][0] if candidates else fallback


def valid_coordinate(lat: float | None, lon: float | None) -> bool:
    return lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180


def _value_is_empty(value: Any) -> bool:
    if isinstance(value, (list, tuple)):
        return all(_value_is_empty(item) for item in value)
    return clean(value) == ""


def row_is_empty(row: MutableMapping[Any, Any]) -> bool:
    """Return true only when every source cell in a parsed CSV record is empty."""
    return all(_value_is_empty(value) for key, value in row.items() if key != "__source")


class Dictionary:
    def __init__(self) -> None:
        self.values: list[str] = []
        self.indexes: dict[str, int] = {}

    def add(self, value: Any) -> int:
        text = clean(value)
        if text not in self.indexes:
            self.indexes[text] = len(self.values)
            self.values.append(text)
        return self.indexes[text]


def read_rows(
    path: Path,
    source: int,
    *,
    quality: Counter[str] | None = None,
    source_stats: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Read one source extract while retaining partial rows and skipping only empty rows."""
    rows: list[dict[str, Any]] = []
    input_row_count = 0
    skipped_empty_row_count = 0

    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fieldnames = reader.fieldnames or []
        missing_required = REQUIRED_COLUMNS.difference(fieldnames)
        if missing_required:
            raise ValueError(
                f"{path.name} is missing required columns: {', '.join(sorted(missing_required))}"
            )

        missing_optional = sorted(OPTIONAL_COLUMNS.difference(fieldnames))
        if quality is not None and missing_optional:
            quality["optionalColumnsMissing"] += len(missing_optional)

        for row in reader:
            input_row_count += 1
            if row_is_empty(row):
                skipped_empty_row_count += 1
                if quality is not None:
                    quality["sourceRowsSkippedBlank"] += 1
                continue
            row["__source"] = source
            rows.append(row)

    if source_stats is not None:
        source_stats.append({
            "file": path.name,
            "classification": "active" if source == 0 else "retired",
            "inputRowCount": input_row_count,
            "retainedRowCount": len(rows),
            "skippedEmptyRowCount": skipped_empty_row_count,
            "missingOptionalColumns": missing_optional,
        })
    return rows


def _validate_configuration(
    snapshot: str,
    as_of_year: int,
    retirement_kpi_end_year: int,
    retirement_chart_end_year: int,
    facility_page_size: int,
) -> None:
    if not clean(snapshot):
        raise ValueError("snapshot must not be empty")
    for label, value in (
        ("as_of_year", as_of_year),
        ("retirement_kpi_end_year", retirement_kpi_end_year),
        ("retirement_chart_end_year", retirement_chart_end_year),
        ("facility_page_size", facility_page_size),
    ):
        if type(value) is not int:
            raise ValueError(f"{label} must be an integer")
    if not 1800 <= as_of_year <= 3000:
        raise ValueError("as_of_year must be between 1800 and 3000")
    if retirement_kpi_end_year < as_of_year:
        raise ValueError("retirement_kpi_end_year must not precede as_of_year")
    if retirement_chart_end_year < retirement_kpi_end_year:
        raise ValueError("retirement_chart_end_year must not precede retirement_kpi_end_year")
    if facility_page_size <= 0:
        raise ValueError("facility_page_size must be positive")


def build(
    active_path: Path,
    retired_path: Path,
    *,
    snapshot: str = DEFAULT_SNAPSHOT,
    as_of_year: int = DEFAULT_AS_OF_YEAR,
    retirement_kpi_end_year: int = DEFAULT_RETIREMENT_KPI_END_YEAR,
    retirement_chart_end_year: int = DEFAULT_RETIREMENT_CHART_END_YEAR,
    facility_page_size: int = DEFAULT_FACILITY_PAGE_SIZE,
    generated_at: str | None = None,
) -> dict[str, Any]:
    """Build a schema-v1 payload. Existing two-path calls retain their prior defaults."""
    _validate_configuration(
        snapshot,
        as_of_year,
        retirement_kpi_end_year,
        retirement_chart_end_year,
        facility_page_size,
    )

    quality: Counter[str] = Counter()
    source_stats: list[dict[str, Any]] = []
    active_rows_data = read_rows(
        active_path,
        0,
        quality=quality,
        source_stats=source_stats,
    )
    retired_rows_data = read_rows(
        retired_path,
        1,
        quality=quality,
        source_stats=source_stats,
    )
    raw_rows = active_rows_data + retired_rows_data

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in raw_rows:
        plant_id = clean(row.get("Plant ID"))
        if not plant_id:
            plant_id = f"missing:{clean(row.get('Plant Name'))}:{clean(row.get('Plant State'))}"
        grouped[plant_id].append(row)

    dictionaries = {name: Dictionary() for name in [
        "entities",
        "plants",
        "states",
        "counties",
        "sectors",
        "technologies",
        "statuses",
        "energySources",
        "primeMovers",
    ]}

    facilities: list[list[Any]] = []
    generators: list[list[Any]] = []

    for plant_id in sorted(grouped, key=lambda value: (
        not value.isdigit(),
        int(value) if value.isdigit() else value,
    )):
        rows = grouped[plant_id]
        entity = mode((clean(row.get("Entity Name")) for row in rows), "Unknown entity")
        plant = mode((clean(row.get("Plant Name")) for row in rows), "Unnamed facility")
        state = mode((clean(row.get("Plant State")).upper() for row in rows), "Unknown")
        county = mode((clean(row.get("County")) for row in rows), "Unknown")
        sector = mode((clean(row.get("Sector")) for row in rows), "Unspecified")

        coordinate_pairs: list[tuple[float, float]] = []
        for row in rows:
            lat = number(row.get("Latitude"))
            lon = number(row.get("Longitude"))
            if valid_coordinate(lat, lon):
                coordinate_pairs.append((round(lat, 6), round(lon, 6)))
            else:
                quality["generatorRowsMissingCoordinates"] += 1
        if coordinate_pairs:
            lat, lon = Counter(coordinate_pairs).most_common(1)[0][0]
        else:
            lat, lon = None, None
            quality["facilitiesMissingCoordinates"] += 1

        generator_start = len(generators)
        def generator_sort_key(row: dict[str, Any]) -> tuple[int, int, str]:
            operating_year = integer(row.get("Operating Year"))
            return (
                int(row["__source"]),
                operating_year if operating_year is not None else 9999,
                clean(row.get("Generator ID")),
            )

        sorted_rows = sorted(rows, key=generator_sort_key)

        for row in sorted_rows:
            nameplate = number(row.get("Nameplate Capacity (MW)"))
            summer = number(row.get("Net Summer Capacity (MW)"))
            winter = number(row.get("Net Winter Capacity (MW)"))
            operating_year = integer(row.get("Operating Year"))
            retirement_year = integer(row.get("Planned Retirement Year"))

            if nameplate is None:
                quality["generatorRowsMissingNameplate"] += 1
            if operating_year is None:
                quality["generatorRowsMissingOperatingYear"] += 1
            if (
                retirement_year is not None
                and operating_year is not None
                and retirement_year < operating_year
            ):
                quality["generatorRowsRetirementBeforeOperation"] += 1

            generators.append([
                clean(row.get("Generator ID")),
                nameplate,
                summer,
                winter,
                dictionaries["technologies"].add(row.get("Technology") or "Unknown"),
                dictionaries["energySources"].add(row.get("Energy Source Code")),
                dictionaries["primeMovers"].add(row.get("Prime Mover Code")),
                integer(row.get("Operating Month")),
                operating_year,
                integer(row.get("Planned Retirement Month")),
                retirement_year,
                dictionaries["statuses"].add(row.get("Status")),
                int(row["__source"]),
            ])

        facilities.append([
            plant_id,
            dictionaries["entities"].add(entity),
            dictionaries["plants"].add(plant),
            dictionaries["states"].add(state),
            dictionaries["counties"].add(county),
            dictionaries["sectors"].add(sector),
            lat,
            lon,
            generator_start,
            len(rows),
        ])

    active_rows = len(active_rows_data)
    retired_rows = len(retired_rows_data)
    mapped_facilities = sum(
        1 for facility in facilities if facility[6] is not None and facility[7] is not None
    )
    generated_timestamp = (
        clean(generated_at)
        if generated_at is not None
        else datetime.now(timezone.utc).isoformat(timespec="seconds")
    )
    if not generated_timestamp:
        raise ValueError("generated_at must not be empty")

    return {
        "schemaVersion": SCHEMA_VERSION,
        "metadata": {
            "title": "U.S. Generation Facilities",
            "snapshot": clean(snapshot),
            "asOfYear": as_of_year,
            "retirementKpiEndYear": retirement_kpi_end_year,
            "retirementChartEndYear": retirement_chart_end_year,
            "facilityPageSize": facility_page_size,
            "generatedAt": generated_timestamp,
            "sourceFiles": [active_path.name, retired_path.name],
            "sourceStats": source_stats,
            "facilityCount": len(facilities),
            "mappedFacilityCount": mapped_facilities,
            "generatorCount": len(generators),
            "activeGeneratorCount": active_rows,
            "retiredGeneratorCount": retired_rows,
            "quality": dict(quality),
        },
        "dictionaries": {
            name: dictionary.values for name, dictionary in dictionaries.items()
        },
        "facilities": facilities,
        "generators": generators,
    }


def serialize_store(payload: dict[str, Any]) -> str:
    serialized = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )
    return f"{STORE_COMMENT}{STORE_PREFIX}{serialized}{STORE_SUFFIX}"


def write_store_atomic(payload: dict[str, Any], output: Path) -> None:
    """Write a complete store and atomically replace any prior output."""
    output.parent.mkdir(parents=True, exist_ok=True)
    existing_mode = output.stat().st_mode & 0o777 if output.exists() else 0o644
    descriptor, temporary_name = tempfile.mkstemp(
        dir=output.parent,
        prefix=f".{output.name}.",
        suffix=".tmp",
        text=True,
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            handle.write(serialize_store(payload))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_path, existing_mode)
        os.replace(temporary_path, output)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--active", type=Path, required=True)
    parser.add_argument("--retired", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--snapshot", default=DEFAULT_SNAPSHOT)
    parser.add_argument("--as-of-year", type=int, default=DEFAULT_AS_OF_YEAR)
    parser.add_argument(
        "--retirement-kpi-end-year",
        type=int,
        default=DEFAULT_RETIREMENT_KPI_END_YEAR,
    )
    parser.add_argument(
        "--retirement-chart-end-year",
        type=int,
        default=DEFAULT_RETIREMENT_CHART_END_YEAR,
    )
    parser.add_argument(
        "--facility-page-size",
        type=int,
        default=DEFAULT_FACILITY_PAGE_SIZE,
    )
    args = parser.parse_args()

    payload = build(
        args.active,
        args.retired,
        snapshot=args.snapshot,
        as_of_year=args.as_of_year,
        retirement_kpi_end_year=args.retirement_kpi_end_year,
        retirement_chart_end_year=args.retirement_chart_end_year,
        facility_page_size=args.facility_page_size,
    )
    write_store_atomic(payload, args.output)

    for source in payload["metadata"]["sourceStats"]:
        if source["skippedEmptyRowCount"]:
            print(
                f"WARNING: skipped {source['skippedEmptyRowCount']} all-empty row(s) "
                f"from {source['file']}",
                file=sys.stderr,
            )
        if source["missingOptionalColumns"]:
            print(
                f"WARNING: {source['file']} is missing optional columns: "
                f"{', '.join(source['missingOptionalColumns'])}",
                file=sys.stderr,
            )

    print(json.dumps(payload["metadata"], indent=2, ensure_ascii=False))
    print(f"Wrote {args.output} ({args.output.stat().st_size / 1024 / 1024:.2f} MiB)")


if __name__ == "__main__":
    main()
