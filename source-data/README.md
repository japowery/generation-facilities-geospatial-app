# Source data staging

The deployed application does not read CSV files from this directory. It reads the generated store at `data/generation-data.js`.

To refresh the snapshot, place the active and retired extracts here or pass paths from another controlled location to `scripts/build_data.py`. CSV files are ignored by default because source redistribution rights and repository-size policies can differ.

Before building:

1. preserve the source files unchanged;
2. record their reporting period, origin, received date, byte size, and SHA-256 checksum;
3. confirm which file represents active records and which represents retired records;
4. inspect the headers against the required and optional columns in the repository README;
5. retain any delivery documentation or data dictionary outside the public deployment artifact.

The builder skips only records whose parsed source cells are all empty. It retains populated partial records, including records without plant or generator IDs, and reports missing optional columns and per-source row reconciliation under `metadata.sourceStats`.

After building, run the unit suite and both normal and optimized-mode validators before replacing a published snapshot.
