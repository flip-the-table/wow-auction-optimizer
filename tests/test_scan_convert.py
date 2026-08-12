"""Converter tests for AH scan exports (scripts/convert_ah_scan.py)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from convert_decor_recipe_export import lua_to_python  # noqa: E402
import convert_ah_scan  # noqa: E402

SAMPLE_SV = '''
FlipTheTableCaptureDB = {
    ["captures"] = {},
    ["ah_scans"] = {
        {
            ["scan_version"] = "0.3.0",
            ["game_version"] = "12.0.7",
            ["scanned_at"] = 1770000000,
            ["realm"] = "Moon Guard",
            ["region"] = "US",
            ["character"] = "Testchar",
            ["num_items"] = 2,
            ["results"] = {
                { ["a"] = 111, ["i"] = 262616, ["q"] = 1, ["p"] = 35000000, ["o"] = "Sellerone" },
                { ["a"] = 222, ["i"] = 257725, ["q"] = 2, ["p"] = 12000000, ["o"] = "Sellertwo|Sellerthree" },
                { ["a"] = 111, ["i"] = 262616, ["q"] = 1, ["p"] = 35000000, ["o"] = "Sellerone" },
                { ["a"] = 333, ["i"] = 262616, ["q"] = 1, ["p"] = 0 },
            },
        },
    },
}
'''


def test_lua_parse_ah_scans():
    db = lua_to_python(SAMPLE_SV)
    scans = db["ah_scans"]
    assert len(scans) == 1
    assert scans[0]["realm"] == "Moon Guard"
    assert len(scans[0]["results"]) == 4


def test_convert_writes_valid_json(tmp_path, monkeypatch):
    sv = tmp_path / "FlipTheTableCapture.lua"
    sv.write_text(SAMPLE_SV, encoding="utf-8")
    out_dir = tmp_path / "out"
    monkeypatch.setattr(convert_ah_scan, "OUT_DIR", out_dir)

    assert convert_ah_scan.convert(sv) == 0
    files = list(out_dir.glob("scan_moon-guard_*.v1.json"))
    assert len(files) == 1

    data = json.loads(files[0].read_text(encoding="utf-8"))
    assert data["format"] == "ftt-ah-scan"
    assert data["version"] == 1
    assert data["region"] == "us"
    # duplicate auction id deduped; ownerless row dropped
    assert len(data["rows"]) == 2
    assert data["dropped_rows"] == 1
    by_id = {r["auction_id"]: r for r in data["rows"]}
    assert by_id[111]["seller"] == "Sellerone"
    # multi-owner rows keep the primary owner only
    assert by_id[222]["seller"] == "Sellertwo"
    assert by_id[222]["unit_price"] == 12000000
