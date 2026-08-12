#!/usr/bin/env python3
"""Convert FlipTheTableCapture AH scans (SavedVariables) into versioned JSON.

Usage:
    python scripts/convert_ah_scan.py <path-to-FlipTheTableCapture.lua>

Reads FlipTheTableCaptureDB.ah_scans (written by /fttscan), validates rows,
and writes one JSON file per scan into data/ah_scans/:
    scan_<realm-slug>_<YYYYMMDDTHHMMSS>.v1.json

The import job (services/jobs/scan_import.py, or the "AH Scan Import"
workflow) upserts these into auction_owners. Files are idempotent — already
imported filenames are skipped via the scan_imports ledger.

Never fabricates data: rows missing an auction id, item id, or seller are
dropped and counted.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from convert_decor_recipe_export import lua_to_python

OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "ah_scans"


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "unknown"


def convert(sv_path: Path) -> int:
    db = lua_to_python(sv_path.read_text(encoding="utf-8", errors="replace"))
    scans = db.get("ah_scans") or []
    if isinstance(scans, dict):
        scans = scans.get("__array", [])
    if not scans:
        print("No ah_scans found in the export — run /fttscan in-game first.")
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for scan in scans:
        results = scan.get("results") or []
        if isinstance(results, dict):
            results = results.get("__array", [])
        rows, dropped = [], 0
        seen_ids: set[int] = set()
        for r in results:
            a, i, o = r.get("a"), r.get("i"), r.get("o")
            if not (isinstance(a, int) and isinstance(i, int) and o):
                dropped += 1
                continue
            if a in seen_ids:
                continue
            seen_ids.add(a)
            rows.append({
                "auction_id": a,
                "item_id": i,
                "quantity": int(r.get("q") or 1),
                "unit_price": int(r.get("p") or 0) or None,
                # first owner only; secondary owner (rare) kept as suffix
                "seller": str(o).split("|")[0][:128],
            })
        ts = int(scan.get("scanned_at") or 0)
        when = datetime.fromtimestamp(ts, tz=timezone.utc) if ts else datetime.now(timezone.utc)
        realm = str(scan.get("realm") or "unknown")
        out = {
            "format": "ftt-ah-scan",
            "version": 1,
            "realm": realm,
            "region": str(scan.get("region") or "?").lower(),
            "scanned_at": when.isoformat(),
            "scan_version": scan.get("scan_version"),
            "game_version": scan.get("game_version"),
            "rows": rows,
            "dropped_rows": dropped,
        }
        fname = f"scan_{slugify(realm)}_{when.strftime('%Y%m%dT%H%M%S')}.v1.json"
        (OUT_DIR / fname).write_text(json.dumps(out, indent=1), encoding="utf-8")
        print(f"wrote {fname}: {len(rows)} rows ({dropped} dropped)")
        written += 1

    print(f"\n{written} scan file(s) in {OUT_DIR}. Commit them and run the "
          f"'AH Scan Import' workflow (or scan_import locally).")
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    sv = Path(sys.argv[1])
    if not sv.exists():
        print(f"not found: {sv}")
        return 2
    return convert(sv)


if __name__ == "__main__":
    raise SystemExit(main())
