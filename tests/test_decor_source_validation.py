"""Loader validation tests (Phase 18.3, pure part — no DB required)."""

import json
from pathlib import Path

from services.jobs.decor_recipe_load import source_checksum, validate_source


def base_doc(**overrides):
    doc = {
        "source_version": "1.0.0",
        "recipes": [
            {
                "external_recipe_key": "oak-shelf",
                "decor_item_id": 250001,
                "crafted_quantity": 1,
                "recipe_name": "Oak Shelf",
                "lumber_reagents": [
                    {"material_key": "lumber_pine", "quantity": 10,
                     "display_name": "Pine Lumber"}
                ],
                "other_reagents": [
                    {"item_id": 4306, "quantity": 2,
                     "pricing_scope": "REGION_COMMODITY", "optional": False}
                ],
                "source_reference": "in-game verification 2026-07-01",
                "verification_status": "VERIFIED",
            }
        ],
    }
    doc.update(overrides)
    return doc


def test_valid_source_passes():
    errors, warnings = validate_source(base_doc())
    assert errors == []


def test_malformed_version_rejected():
    errors, _ = validate_source(base_doc(source_version="not-a-version"))
    assert any("malformed source_version" in e for e in errors)


def test_missing_decor_item_rejected():
    doc = base_doc()
    del doc["recipes"][0]["decor_item_id"]
    errors, _ = validate_source(doc)
    assert any("decor_item_id missing" in e for e in errors)


def test_zero_crafted_quantity_rejected():
    doc = base_doc()
    doc["recipes"][0]["crafted_quantity"] = 0
    errors, _ = validate_source(doc)
    assert any("crafted_quantity" in e for e in errors)


def test_no_constrained_material_rejected():
    doc = base_doc()
    doc["recipes"][0]["lumber_reagents"] = []
    errors, _ = validate_source(doc)
    assert any("no constrained material" in e for e in errors)


def test_invalid_reagent_quantity_rejected():
    doc = base_doc()
    doc["recipes"][0]["other_reagents"][0]["quantity"] = -1
    errors, _ = validate_source(doc)
    assert any("reagent quantity" in e for e in errors)


def test_duplicate_recipe_key_rejected():
    doc = base_doc()
    doc["recipes"].append(dict(doc["recipes"][0]))
    errors, _ = validate_source(doc)
    assert any("duplicate external_recipe_key" in e for e in errors)


def test_verified_without_reference_rejected():
    doc = base_doc()
    doc["recipes"][0]["source_reference"] = None
    errors, _ = validate_source(doc)
    assert any("requires source_reference" in e for e in errors)


def test_unverified_warns_but_passes():
    doc = base_doc()
    doc["recipes"][0]["verification_status"] = "UNVERIFIED"
    doc["recipes"][0]["source_reference"] = None
    errors, warnings = validate_source(doc)
    assert errors == []
    assert any("UNVERIFIED" in w for w in warnings)


def test_multiple_constrained_materials_warns():
    doc = base_doc()
    doc["recipes"][0]["lumber_reagents"].append(
        {"material_key": "lumber_oak", "quantity": 5, "display_name": "Oak"}
    )
    errors, warnings = validate_source(doc)
    assert errors == []
    assert any("multiple constrained materials" in w for w in warnings)


def test_checksum_stable_and_content_sensitive():
    a = json.dumps(base_doc()).encode()
    b = json.dumps(base_doc(source_version="1.0.1")).encode()
    assert source_checksum(a) == source_checksum(a)
    assert source_checksum(a) != source_checksum(b)


def test_template_file_is_unverified_and_example_versioned():
    """The committed template must never be importable as production data."""
    path = Path(__file__).resolve().parents[1] / "data/decor_recipes/TEMPLATE.example.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["source_version"] == "0.0.0-example"
    assert all(r["verification_status"] != "VERIFIED" for r in doc["recipes"])
    errors, warnings = validate_source(doc)
    assert errors == []  # schema-valid…
    assert any("UNVERIFIED" in w for w in warnings)  # …but flagged unverified
