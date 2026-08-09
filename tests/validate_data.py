#!/usr/bin/env python3
"""Validate the generated JavaScript data store without a browser."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

STORE_COMMENT = "/* Generated file. Run scripts/build_data.py to refresh. */\n"
STORE_PREFIX = "window.GENERATION_DATA="
STORE_SUFFIX = ";\n"

DICTIONARY_NAMES = (
    "entities",
    "plants",
    "states",
    "counties",
    "sectors",
    "technologies",
    "statuses",
    "energySources",
    "primeMovers",
)


class ValidationError(ValueError):
    """Raised when a generated store violates the schema or data invariants."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def _reject_json_constant(value: str) -> None:
    raise ValidationError(f"non-finite JSON constant is not allowed: {value}")


def load_store(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    wrapper = f"{STORE_COMMENT}{STORE_PREFIX}"
    require(text.startswith(wrapper), "generated store header or assignment is invalid")
    require(text.endswith(STORE_SUFFIX), "generated store terminator is invalid")
    payload_text = text[len(wrapper):-len(STORE_SUFFIX)]
    require(bool(payload_text), "generated store payload is empty")
    try:
        payload = json.loads(payload_text, parse_constant=_reject_json_constant)
    except json.JSONDecodeError as error:
        raise ValidationError(
            f"generated store payload is not valid JSON: {error.msg} at "
            f"line {error.lineno}, column {error.colno}"
        ) from error
    require(type(payload) is dict, "generated store payload must be an object")
    return payload


def _is_integer(value: Any) -> bool:
    return type(value) is int


def _is_finite_number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _validate_count(metadata: dict[str, Any], key: str) -> int:
    value = metadata.get(key)
    require(_is_integer(value) and value >= 0, f"metadata.{key} must be a non-negative integer")
    return value


def _validate_dictionary(dictionaries: dict[str, Any], name: str) -> list[str]:
    values = dictionaries.get(name)
    require(type(values) is list, f"dictionaries.{name} must be an array")
    require(
        all(type(value) is str for value in values),
        f"dictionaries.{name} must contain only strings",
    )
    require(
        len(values) == len(set(values)),
        f"dictionaries.{name} contains duplicate values",
    )
    return values


def _validate_dictionary_index(
    value: Any,
    dictionary: list[str],
    context: str,
) -> None:
    require(_is_integer(value), f"{context} must be an integer")
    require(0 <= value < len(dictionary), f"{context} is outside its dictionary")


def _validate_optional_number(value: Any, context: str) -> None:
    if value is None:
        return
    require(_is_finite_number(value), f"{context} must be null or a finite number")


def _validate_optional_year(value: Any, context: str) -> None:
    if value is None:
        return
    require(_is_integer(value), f"{context} must be null or an integer")
    require(1800 <= value <= 3000, f"{context} must be between 1800 and 3000")


def _validate_optional_month(value: Any, context: str) -> None:
    if value is None:
        return
    require(_is_integer(value), f"{context} must be null or an integer")
    require(
        1 <= value <= 12 or value in {0, 88, 99},
        f"{context} must be a calendar month or documented sentinel 0/88/99",
    )


def _generator_has_source_content(generator: list[Any], dictionaries: dict[str, list[str]]) -> bool:
    if generator[0]:
        return True
    if any(value is not None for value in (
        generator[1],
        generator[2],
        generator[3],
        generator[7],
        generator[8],
        generator[9],
        generator[10],
    )):
        return True
    decoded = (
        dictionaries["technologies"][generator[4]],
        dictionaries["energySources"][generator[5]],
        dictionaries["primeMovers"][generator[6]],
        dictionaries["statuses"][generator[11]],
    )
    return any(value not in {"", "Unknown"} for value in decoded)


def _validate_source_stats(metadata: dict[str, Any], quality: dict[str, int]) -> None:
    source_stats = metadata.get("sourceStats")
    if source_stats is None:
        return
    require(type(source_stats) is list, "metadata.sourceStats must be an array")
    require(len(source_stats) == 2, "metadata.sourceStats must describe active and retired sources")

    retained_by_classification = {"active": 0, "retired": 0}
    files_by_classification: dict[str, str] = {}
    skipped_total = 0
    optional_gap_total = 0
    seen_classifications: set[str] = set()
    for index, source in enumerate(source_stats):
        context = f"metadata.sourceStats[{index}]"
        require(type(source) is dict, f"{context} must be an object")
        require(type(source.get("file")) is str and source["file"], f"{context}.file is invalid")
        classification = source.get("classification")
        require(
            classification in retained_by_classification,
            f"{context}.classification must be active or retired",
        )
        require(
            classification not in seen_classifications,
            f"{context}.classification is duplicated",
        )
        seen_classifications.add(classification)

        input_count = source.get("inputRowCount")
        retained_count = source.get("retainedRowCount")
        skipped_count = source.get("skippedEmptyRowCount")
        for label, value in (
            ("inputRowCount", input_count),
            ("retainedRowCount", retained_count),
            ("skippedEmptyRowCount", skipped_count),
        ):
            require(
                _is_integer(value) and value >= 0,
                f"{context}.{label} must be a non-negative integer",
            )
        require(
            input_count == retained_count + skipped_count,
            f"{context} input rows do not reconcile",
        )

        missing_optional = source.get("missingOptionalColumns")
        require(type(missing_optional) is list, f"{context}.missingOptionalColumns must be an array")
        require(
            all(type(column) is str and column for column in missing_optional),
            f"{context}.missingOptionalColumns must contain non-empty strings",
        )
        require(
            len(missing_optional) == len(set(missing_optional)),
            f"{context}.missingOptionalColumns contains duplicates",
        )

        retained_by_classification[classification] = retained_count
        files_by_classification[classification] = source["file"]
        skipped_total += skipped_count
        optional_gap_total += len(missing_optional)

    require(
        retained_by_classification["active"] == metadata["activeGeneratorCount"],
        "active sourceStats retained count does not match metadata",
    )
    require(
        retained_by_classification["retired"] == metadata["retiredGeneratorCount"],
        "retired sourceStats retained count does not match metadata",
    )
    require(
        files_by_classification["active"] == metadata["sourceFiles"][0],
        "active sourceStats file does not match metadata.sourceFiles",
    )
    require(
        files_by_classification["retired"] == metadata["sourceFiles"][1],
        "retired sourceStats file does not match metadata.sourceFiles",
    )
    require(
        quality.get("sourceRowsSkippedBlank", 0) == skipped_total,
        "sourceRowsSkippedBlank does not reconcile to sourceStats",
    )
    require(
        quality.get("optionalColumnsMissing", 0) == optional_gap_total,
        "optionalColumnsMissing does not reconcile to sourceStats",
    )


def validate_store(data: dict[str, Any]) -> dict[str, int]:
    require(
        _is_integer(data.get("schemaVersion")) and data["schemaVersion"] == 1,
        "schemaVersion must be integer 1",
    )
    metadata = data.get("metadata")
    dictionaries_raw = data.get("dictionaries")
    facilities = data.get("facilities")
    generators = data.get("generators")
    require(type(metadata) is dict, "metadata must be an object")
    require(type(dictionaries_raw) is dict, "dictionaries must be an object")
    require(type(facilities) is list, "facilities must be an array")
    require(type(generators) is list, "generators must be an array")

    facility_count = _validate_count(metadata, "facilityCount")
    mapped_facility_count = _validate_count(metadata, "mappedFacilityCount")
    generator_count = _validate_count(metadata, "generatorCount")
    active_generator_count = _validate_count(metadata, "activeGeneratorCount")
    retired_generator_count = _validate_count(metadata, "retiredGeneratorCount")
    require(facility_count == len(facilities), "metadata facilityCount does not match facilities")
    require(generator_count == len(generators), "metadata generatorCount does not match generators")
    require(
        active_generator_count + retired_generator_count == generator_count,
        "active and retired metadata counts do not reconcile",
    )

    require(
        type(metadata.get("snapshot")) is str and bool(metadata["snapshot"].strip()),
        "metadata.snapshot must be a non-empty string",
    )
    require(
        type(metadata.get("generatedAt")) is str and bool(metadata["generatedAt"].strip()),
        "metadata.generatedAt must be a non-empty string",
    )
    source_files = metadata.get("sourceFiles")
    require(
        type(source_files) is list
        and len(source_files) == 2
        and all(type(value) is str and value for value in source_files),
        "metadata.sourceFiles must contain active and retired filenames",
    )

    configuration = {
        "asOfYear": 2026,
        "retirementKpiEndYear": 2035,
        "retirementChartEndYear": 2050,
        "facilityPageSize": 25,
    }
    for key, fallback in tuple(configuration.items()):
        value = metadata.get(key, fallback)
        require(_is_integer(value), f"metadata.{key} must be an integer")
        configuration[key] = value
    require(1800 <= configuration["asOfYear"] <= 3000, "metadata.asOfYear is outside range")
    require(
        configuration["retirementKpiEndYear"] >= configuration["asOfYear"],
        "metadata.retirementKpiEndYear precedes asOfYear",
    )
    require(
        configuration["retirementChartEndYear"] >= configuration["retirementKpiEndYear"],
        "metadata.retirementChartEndYear precedes retirementKpiEndYear",
    )
    require(configuration["facilityPageSize"] > 0, "metadata.facilityPageSize must be positive")

    dictionaries = {
        name: _validate_dictionary(dictionaries_raw, name) for name in DICTIONARY_NAMES
    }

    quality_raw = metadata.get("quality", {})
    require(type(quality_raw) is dict, "metadata.quality must be an object")
    quality: dict[str, int] = {}
    for key, value in quality_raw.items():
        require(type(key) is str and key, "metadata.quality keys must be non-empty strings")
        require(
            _is_integer(value) and value >= 0,
            f"metadata.quality.{key} must be a non-negative integer",
        )
        quality[key] = value

    expected_start = 0
    mapped = 0
    plant_ids: set[str] = set()
    facility_slices: list[tuple[str, int, int]] = []
    for index, facility in enumerate(facilities):
        context = f"facilities[{index}]"
        require(type(facility) is list and len(facility) == 10, f"{context} must have 10 fields")
        plant_id, entity, plant, state, county, sector, lat, lon, start, count = facility
        require(
            type(plant_id) is str and bool(plant_id.strip()),
            f"{context} plant ID must be non-empty",
        )
        require(plant_id not in plant_ids, f"{context} duplicates plant ID {plant_id!r}")
        plant_ids.add(plant_id)
        for value, dictionary_name in (
            (entity, "entities"),
            (plant, "plants"),
            (state, "states"),
            (county, "counties"),
            (sector, "sectors"),
        ):
            _validate_dictionary_index(
                value,
                dictionaries[dictionary_name],
                f"{context}.{dictionary_name}",
            )
        require(_is_integer(start), f"{context}.start must be an integer")
        require(_is_integer(count) and count > 0, f"{context}.count must be a positive integer")
        require(start == expected_start, f"{context}.start is not contiguous")
        require(start + count <= len(generators), f"{context} generator slice exceeds generators")
        expected_start += count

        if lat is None and lon is None:
            pass
        else:
            require(lat is not None and lon is not None, f"{context} has a partial coordinate")
            require(_is_finite_number(lat), f"{context}.latitude must be finite")
            require(_is_finite_number(lon), f"{context}.longitude must be finite")
            require(-90 <= lat <= 90, f"{context}.latitude is outside range")
            require(-180 <= lon <= 180, f"{context}.longitude is outside range")
            mapped += 1
        facility_slices.append((plant_id, start, count))

    require(expected_start == len(generators), "facility slices do not cover all generators")
    require(mapped == mapped_facility_count, "mapped facility count does not reconcile")

    active = 0
    retired = 0
    missing_nameplate = 0
    missing_operating_year = 0
    retirement_before_operation = 0
    for index, generator in enumerate(generators):
        context = f"generators[{index}]"
        require(type(generator) is list and len(generator) == 13, f"{context} must have 13 fields")
        require(type(generator[0]) is str, f"{context}.id must be a string")
        for offset, label in ((1, "nameplate"), (2, "summer"), (3, "winter")):
            _validate_optional_number(generator[offset], f"{context}.{label}")
        for offset, dictionary_name in (
            (4, "technologies"),
            (5, "energySources"),
            (6, "primeMovers"),
            (11, "statuses"),
        ):
            _validate_dictionary_index(
                generator[offset],
                dictionaries[dictionary_name],
                f"{context}.{dictionary_name}",
            )
        _validate_optional_month(generator[7], f"{context}.operatingMonth")
        _validate_optional_year(generator[8], f"{context}.operatingYear")
        _validate_optional_month(generator[9], f"{context}.retirementMonth")
        _validate_optional_year(generator[10], f"{context}.retirementYear")
        require(
            _is_integer(generator[12]) and generator[12] in (0, 1),
            f"{context}.source must be integer 0 or 1",
        )
        active += int(generator[12] == 0)
        retired += int(generator[12] == 1)
        missing_nameplate += int(generator[1] is None)
        missing_operating_year += int(generator[8] is None)
        retirement_before_operation += int(
            generator[8] is not None
            and generator[10] is not None
            and generator[10] < generator[8]
        )

    require(active == active_generator_count, "active generator rows do not match metadata")
    require(retired == retired_generator_count, "retired generator rows do not match metadata")

    expected_quality = {
        "generatorRowsMissingNameplate": missing_nameplate,
        "generatorRowsMissingOperatingYear": missing_operating_year,
        "generatorRowsRetirementBeforeOperation": retirement_before_operation,
        "facilitiesMissingCoordinates": facility_count - mapped,
    }
    for key, expected in expected_quality.items():
        require(
            quality.get(key, 0) == expected,
            f"metadata.quality.{key} does not reconcile: expected {expected}",
        )

    _validate_source_stats(metadata, quality)

    for plant_id, start, count in facility_slices:
        if not plant_id.startswith("missing:"):
            continue
        facility_generators = generators[start:start + count]
        require(
            any(
                _generator_has_source_content(generator, dictionaries)
                for generator in facility_generators
            ),
            f"synthetic facility {plant_id!r} contains only all-empty source records",
        )

    return {
        "facilityCount": facility_count,
        "generatorCount": generator_count,
        "mappedFacilityCount": mapped,
        "activeGeneratorCount": active,
        "retiredGeneratorCount": retired,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        type=Path,
        default=Path("data/generation-data.js"),
    )
    args = parser.parse_args()

    try:
        summary = validate_store(load_store(args.path))
    except (OSError, ValidationError) as error:
        parser.exit(1, f"Validation failed: {error}\n")

    print(
        f"Validated {summary['facilityCount']:,} facilities, "
        f"{summary['generatorCount']:,} generator records, and "
        f"{summary['mappedFacilityCount']:,} mapped facilities."
    )


if __name__ == "__main__":
    main()
