from __future__ import annotations

import csv
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts import build_data
from tests.validate_data import load_store, validate_store


FULL_HEADERS = [
    "Entity ID",
    "Entity Name",
    "Plant ID",
    "Plant Name",
    "Plant State",
    "County",
    "Sector",
    "Generator ID",
    "Nameplate Capacity (MW)",
    "Net Summer Capacity (MW)",
    "Net Winter Capacity (MW)",
    "Technology",
    "Energy Source Code",
    "Prime Mover Code",
    "Operating Month",
    "Operating Year",
    "Planned Retirement Month",
    "Planned Retirement Year",
    "Status",
    "Latitude",
    "Longitude",
]


def valid_row(**overrides: str) -> dict[str, str]:
    row = {
        "Entity ID": "100",
        "Entity Name": "Example Utility",
        "Plant ID": "1",
        "Plant Name": "Example Plant",
        "Plant State": "TX",
        "County": "Travis",
        "Sector": "Electric Utility",
        "Generator ID": "G1",
        "Nameplate Capacity (MW)": "100.5",
        "Net Summer Capacity (MW)": "95.0",
        "Net Winter Capacity (MW)": "102.0",
        "Technology": "Natural Gas Fired Combined Cycle",
        "Energy Source Code": "NG",
        "Prime Mover Code": "CA",
        "Operating Month": "6",
        "Operating Year": "2020",
        "Planned Retirement Month": "12",
        "Planned Retirement Year": "2050",
        "Status": "(OP) Operating",
        "Latitude": "30.2672",
        "Longitude": "-97.7431",
    }
    row.update(overrides)
    return row


def write_csv(
    path: Path,
    rows: list[dict[str, str]],
    *,
    headers: list[str] | None = None,
    bom: bool = False,
) -> None:
    with path.open("w", encoding="utf-8-sig" if bom else "utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=headers or FULL_HEADERS,
            extrasaction="ignore",
        )
        writer.writeheader()
        writer.writerows(rows)


class ParsingTests(unittest.TestCase):
    def test_numeric_parsing_is_finite_and_never_truncates(self) -> None:
        self.assertEqual(build_data.clean(0), "0")
        self.assertEqual(build_data.number("1,234.5"), 1234.5)
        self.assertEqual(build_data.integer("2,026"), 2026)
        self.assertEqual(build_data.integer("2026.0"), 2026)
        self.assertIsNone(build_data.integer("2026.5"))
        self.assertIsNone(build_data.number("NaN"))
        self.assertIsNone(build_data.number("Infinity"))
        self.assertIsNone(build_data.number("not a number"))

    def test_missing_required_column_is_fatal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.csv"
            headers = [header for header in FULL_HEADERS if header != "Latitude"]
            write_csv(path, [valid_row()], headers=headers)
            with self.assertRaisesRegex(ValueError, r"missing required columns: Latitude"):
                build_data.read_rows(path, 0)


class BuilderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.active = self.root / "active.csv"
        self.retired = self.root / "retired.csv"

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_skips_only_all_empty_rows_and_records_source_stats(self) -> None:
        write_csv(self.active, [valid_row(), {}])
        write_csv(
            self.retired,
            [valid_row(
                **{
                    "Plant ID": "2",
                    "Plant Name": "Retired Plant",
                    "Generator ID": "R1",
                    "Status": "(RET) Retired",
                    "Planned Retirement Year": "2024",
                }
            )],
        )

        payload = build_data.build(
            self.active,
            self.retired,
            generated_at="2026-07-27T00:00:00+00:00",
        )
        metadata = payload["metadata"]

        self.assertEqual(metadata["facilityCount"], 2)
        self.assertEqual(metadata["generatorCount"], 2)
        self.assertEqual(metadata["activeGeneratorCount"], 1)
        self.assertEqual(metadata["retiredGeneratorCount"], 1)
        self.assertEqual(metadata["quality"]["sourceRowsSkippedBlank"], 1)
        self.assertEqual(metadata["sourceStats"][0]["inputRowCount"], 2)
        self.assertEqual(metadata["sourceStats"][0]["retainedRowCount"], 1)
        self.assertEqual(metadata["sourceStats"][0]["skippedEmptyRowCount"], 1)

    def test_retains_partial_row_with_missing_plant_and_generator_ids(self) -> None:
        write_csv(
            self.active,
            [valid_row(
                **{
                    "Plant ID": "",
                    "Plant Name": "Partial Plant",
                    "Generator ID": "",
                    "Nameplate Capacity (MW)": "12.5",
                }
            )],
        )
        write_csv(self.retired, [])

        payload = build_data.build(self.active, self.retired)

        self.assertEqual(payload["metadata"]["generatorCount"], 1)
        self.assertEqual(payload["facilities"][0][0], "missing:Partial Plant:TX")
        self.assertEqual(payload["generators"][0][0], "")
        self.assertEqual(payload["generators"][0][1], 12.5)
        validate_store(payload)

    def test_reads_bom_unicode_and_quoted_commas(self) -> None:
        write_csv(
            self.active,
            [valid_row(
                **{
                    "Entity Name": "ACME, Inc.",
                    "Plant Name": "José Solar, East",
                }
            )],
            bom=True,
        )
        rows = build_data.read_rows(self.active, 0)

        self.assertEqual(rows[0]["Entity Name"], "ACME, Inc.")
        self.assertEqual(rows[0]["Plant Name"], "José Solar, East")

    def test_missing_optional_columns_are_nonfatal_and_counted(self) -> None:
        required_headers = [
            header for header in FULL_HEADERS if header in build_data.REQUIRED_COLUMNS
        ]
        write_csv(self.active, [valid_row()], headers=required_headers)
        write_csv(self.retired, [], headers=required_headers)

        payload = build_data.build(self.active, self.retired)
        metadata = payload["metadata"]

        self.assertEqual(
            metadata["quality"]["optionalColumnsMissing"],
            len(build_data.OPTIONAL_COLUMNS) * 2,
        )
        self.assertEqual(
            metadata["sourceStats"][0]["missingOptionalColumns"],
            sorted(build_data.OPTIONAL_COLUMNS),
        )
        self.assertIsNone(payload["generators"][0][2])
        self.assertIsNone(payload["generators"][0][10])

    def test_default_metadata_and_atomic_store_are_valid(self) -> None:
        write_csv(self.active, [valid_row()])
        write_csv(self.retired, [])
        payload = build_data.build(
            self.active,
            self.retired,
            generated_at="2026-07-27T00:00:00+00:00",
        )
        output = self.root / "nested" / "generation-data.js"

        build_data.write_store_atomic(payload, output)
        loaded = load_store(output)
        summary = validate_store(loaded)

        self.assertEqual(loaded["metadata"]["snapshot"], "January 2026")
        self.assertEqual(loaded["metadata"]["asOfYear"], 2026)
        self.assertEqual(loaded["metadata"]["retirementKpiEndYear"], 2035)
        self.assertEqual(loaded["metadata"]["retirementChartEndYear"], 2050)
        self.assertEqual(loaded["metadata"]["facilityPageSize"], 25)
        self.assertEqual(summary["generatorCount"], 1)
        self.assertFalse(any(output.parent.glob(f".{output.name}.*.tmp")))

    def test_cli_metadata_overrides_remain_optional(self) -> None:
        write_csv(self.active, [valid_row()])
        write_csv(self.retired, [])
        output = self.root / "cli-store.js"
        repository_root = Path(__file__).resolve().parents[1]

        result = subprocess.run(
            [
                sys.executable,
                str(repository_root / "scripts" / "build_data.py"),
                "--active",
                str(self.active),
                "--retired",
                str(self.retired),
                "--output",
                str(output),
                "--snapshot",
                "February 2027",
                "--as-of-year",
                "2027",
                "--retirement-kpi-end-year",
                "2036",
                "--retirement-chart-end-year",
                "2051",
                "--facility-page-size",
                "30",
            ],
            cwd=repository_root,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        metadata = load_store(output)["metadata"]
        self.assertEqual(metadata["snapshot"], "February 2027")
        self.assertEqual(metadata["asOfYear"], 2027)
        self.assertEqual(metadata["retirementKpiEndYear"], 2036)
        self.assertEqual(metadata["retirementChartEndYear"], 2051)
        self.assertEqual(metadata["facilityPageSize"], 30)


if __name__ == "__main__":
    unittest.main()
