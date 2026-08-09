from __future__ import annotations

import unittest
from pathlib import Path

from tests.validate_data import load_store, validate_store


class CorrectedSnapshotCharacterizationTests(unittest.TestCase):
    """Golden invariants for the intentional removal of three all-blank source rows."""

    @classmethod
    def setUpClass(cls) -> None:
        repository_root = Path(__file__).resolve().parents[1]
        cls.data = load_store(repository_root / "data" / "generation-data.js")
        validate_store(cls.data)

    def test_corrected_counts(self) -> None:
        metadata = self.data["metadata"]
        self.assertEqual(metadata["facilityCount"], 15_887)
        self.assertEqual(metadata["mappedFacilityCount"], 15_876)
        self.assertEqual(metadata["generatorCount"], 34_894)
        self.assertEqual(metadata["activeGeneratorCount"], 27_768)
        self.assertEqual(metadata["retiredGeneratorCount"], 7_126)
        self.assertEqual(metadata["quality"].get("sourceRowsSkippedBlank"), 3)

    def test_capacity_is_unchanged_by_blank_row_removal(self) -> None:
        generators = self.data["generators"]
        total = sum(generator[1] or 0 for generator in generators)
        active = sum(
            (generator[1] or 0) for generator in generators if generator[12] == 0
        )
        retired = sum(
            (generator[1] or 0) for generator in generators if generator[12] == 1
        )
        self.assertAlmostEqual(total, 1_673_828.5, places=6)
        self.assertAlmostEqual(active, 1_378_898.9, places=6)
        self.assertAlmostEqual(retired, 294_929.6, places=6)

    def test_no_synthetic_all_blank_facility_remains(self) -> None:
        self.assertFalse(
            any(facility[0] == "missing::" for facility in self.data["facilities"])
        )


if __name__ == "__main__":
    unittest.main()
