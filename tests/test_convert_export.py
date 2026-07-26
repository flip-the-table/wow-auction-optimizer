"""Converter tests (Phase 5): Lua SV parsing, dual-capture verification, conflicts.

Fixtures are TEST DATA exercising the parser/converter — not production recipes.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from convert_decor_recipe_export import (  # noqa: E402
    cross_verify, lua_to_python, normalize_captures, recipe_key,
)


def sv(captures_lua: str) -> str:
    return "FlipTheTableCaptureDB = {\n[\"captures\"] = {\n" + captures_lua + "\n},\n}\n"


CAPTURE_A = """
{
  ["recipe_name"] = "Test Shelf",
  ["output"] = { ["item_id"] = 245392, ["name"] = "Sturdy Wooden Interior Pillar" },
  ["crafted_quantity"] = 1,
  ["constrained_materials"] = { { ["item_id"] = 256963, ["name"] = "Thalassian Lumber", ["quantity"] = 12 } },
  ["other_reagents"] = { { ["item_id"] = 4306, ["name"] = "Silk Cloth", ["quantity"] = 4 } },
  ["notes"] = "workbench tier 1",
  ["raw_inputs"] = { "out|xx", "mat|yy" },
  ["meta"] = { ["capture_version"] = "0.1.0", ["game_version"] = "12.0.7",
               ["game_build"] = 67808, ["captured_at"] = 1780000000,
               ["character"] = "Gnomgnom-Echo Isles", ["region"] = "US" },
}
"""


def test_lua_parser_roundtrip():
    db = lua_to_python(sv(CAPTURE_A))
    caps = normalize_captures(db)
    assert len(caps) == 1
    c = caps[0]
    assert c["output_item_id"] == 245392
    assert c["crafted_quantity"] == 1
    assert c["materials"] == [(256963, "Thalassian Lumber", 12)]
    assert c["reagents"] == [(4306, "Silk Cloth", 4)]
    assert c["meta"]["character"] == "Gnomgnom-Echo Isles"


def test_parser_handles_escapes_and_comments():
    text = sv(CAPTURE_A.replace("workbench tier 1", 'tier \\"one\\"')) + "-- trailing comment\n"
    caps = normalize_captures(lua_to_python(text))
    assert caps[0]["notes"] == 'tier "one"'


def test_dual_capture_exact_match_verifies():
    a = normalize_captures(lua_to_python(sv(CAPTURE_A)))
    b = normalize_captures(lua_to_python(sv(CAPTURE_A)))
    result = cross_verify(a, b)
    assert result[recipe_key("Test Shelf", 245392)] == "VERIFIED"


def test_dual_capture_quantity_mismatch_conflicts():
    a = normalize_captures(lua_to_python(sv(CAPTURE_A)))
    b = normalize_captures(lua_to_python(sv(CAPTURE_A.replace('["quantity"] = 12', '["quantity"] = 10'))))
    result = cross_verify(a, b)
    assert result[recipe_key("Test Shelf", 245392)] == "CONFLICTED"


def test_single_capture_stays_unverified():
    a = normalize_captures(lua_to_python(sv(CAPTURE_A)))
    assert cross_verify(a, []) == {}
