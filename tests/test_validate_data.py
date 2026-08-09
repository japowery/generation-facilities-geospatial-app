from __future__ import annotations

import copy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.build_data import serialize_store
from tests.validate_data import ValidationError, load_store, validate_store


def valid_payload() -> dict:
    return {
        "schemaVersion": 1,
        "metadata": {
            "title": "U.S. Generation Facilities",
            "snapshot": "January 2026",
            "asOfYear": 2026,
            "retirementKpiEndYear": 2035,
            "retirementChartEndYear": 2050,
            "facilityPageSize": 25,
            "generatedAt": "2026-07-27T00:00:00+00:00",
            "sourceFiles": ["active.csv", "retired.csv"],
            "facilityCount": 1,
            "mappedFacilityCount": 1,
            "generatorCount": 1,
            "activeGeneratorCount": 1,
            "retiredGeneratorCount": 0,
            "quality": {},
        },
        "dictionaries": {
            "entities": ["Example Utility"],
            "plants": ["Example Plant"],
            "states": ["TX"],
            "counties": ["Travis"],
            "sectors": ["Electric Utility"],
            "technologies": ["Solar Photovoltaic"],
            "statuses": ["(OP) Operating"],
            "energySources": ["SUN"],
            "primeMovers": ["PV"],
        },
        "facilities": [["1", 0, 0, 0, 0, 0, 30.2, -97.7, 0, 1]],
        "generators": [["G1", 10.0, 9.0, 11.0, 0, 0, 0, 6, 2020, None, None, 0, 0]],
    }


class ValidatorTests(unittest.TestCase):
    def test_valid_store_passes(self) -> None:
        summary = validate_store(valid_payload())
        self.assertEqual(summary["facilityCount"], 1)
        self.assertEqual(summary["generatorCount"], 1)

    def test_exact_wrapper_rejects_trailing_code(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "store.js"
            path.write_text(serialize_store(valid_payload()) + "alert(1);", encoding="utf-8")
            with self.assertRaisesRegex(ValidationError, "terminator"):
                load_store(path)

    def test_nonfinite_json_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "store.js"
            text = serialize_store(valid_payload()).replace(
                '["G1",10.0,',
                '["G1",NaN,',
                1,
            )
            path.write_text(text, encoding="utf-8")
            with self.assertRaisesRegex(ValidationError, "non-finite JSON"):
                load_store(path)

    def test_float_dictionary_index_is_rejected(self) -> None:
        payload = valid_payload()
        payload["generators"][0][4] = 0.0
        with self.assertRaisesRegex(ValidationError, "technologies must be an integer"):
            validate_store(payload)

    def test_quality_counter_must_reconcile(self) -> None:
        payload = valid_payload()
        payload["generators"][0][1] = None
        with self.assertRaisesRegex(
            ValidationError,
            "generatorRowsMissingNameplate does not reconcile",
        ):
            validate_store(payload)

    def test_synthetic_all_blank_facility_is_rejected(self) -> None:
        payload = valid_payload()
        payload["facilities"][0][0] = "missing::"
        payload["dictionaries"]["technologies"] = ["Unknown"]
        payload["dictionaries"]["statuses"] = [""]
        payload["dictionaries"]["energySources"] = [""]
        payload["dictionaries"]["primeMovers"] = [""]
        payload["generators"][0] = [
            "",
            None,
            None,
            None,
            0,
            0,
            0,
            None,
            None,
            None,
            None,
            0,
            0,
        ]
        payload["metadata"]["mappedFacilityCount"] = 0
        payload["metadata"]["quality"] = {
            "generatorRowsMissingNameplate": 1,
            "generatorRowsMissingOperatingYear": 1,
            "facilitiesMissingCoordinates": 1,
        }
        payload["facilities"][0][6] = None
        payload["facilities"][0][7] = None
        with self.assertRaisesRegex(ValidationError, "only all-empty source records"):
            validate_store(payload)

    def test_validation_remains_active_under_python_optimized_mode(self) -> None:
        payload = copy.deepcopy(valid_payload())
        payload["metadata"]["generatorCount"] = 99
        repository_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid.js"
            path.write_text(serialize_store(payload), encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    "-O",
                    str(repository_root / "tests" / "validate_data.py"),
                    str(path),
                ],
                cwd=repository_root,
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("generatorCount", result.stderr)


if __name__ == "__main__":
    unittest.main()
