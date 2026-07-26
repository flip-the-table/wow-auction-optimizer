# Curated Decor Recipe Sources

The Blizzard professions recipe API contains **zero recipes that produce
housing Decor items** (verified 2026-07-26 via the crafted-item class
breakdown). The decor→lumber mapping that powers the implied lumber valuation
therefore comes from **versioned, manually curated source files** in this
directory — classification `CURATED_SOURCE`.

## Rules

1. One file per source version: `v<major.minor.patch>.json` (e.g. `v1.0.0.json`).
2. A source version is **immutable once imported**. The loader stores a SHA-256
   checksum; re-importing the same version with different content fails hard.
   To change anything, create a new version file.
3. `TEMPLATE.example.json` is **NOT production data**. It uses the reserved
   version `0.0.0-example`, `verification_status: "UNVERIFIED"`, and
   `source_method: "EXAMPLE_TEMPLATE"`. The loader refuses to import it
   without `--allow-unverified` (dev only) and the compute pipeline excludes
   unverified recipes from aggregates regardless.
4. Never invent item IDs or recipes. Every production recipe requires
   `verification_status: "VERIFIED"`, a `source_reference` describing how it
   was confirmed (in-game inspection, patch notes, etc.), and `verified_by`.
5. `lumber_reagents[].material_key` is a stable slug (e.g. `lumber_pine`).
   Multiple constrained material types are supported from day one — do not
   assume a single universal "lumber".

## Import

Manual GitHub Actions workflow: **Decor Recipe Source** (`decor-recipes.yml`),
or locally:

```bash
python -m services.jobs.decor_recipe_load --file data/decor_recipes/v1.0.0.json
```

The loader validates, upserts the source + materials + recipes + reagents in
one transaction, marks the imported version's recipes as the active set, and
exits non-zero on any validation error in production data.
