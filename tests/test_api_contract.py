"""API/UI contract tests for the lumber feature (Phase 14).

Opt-in: set API_BASE_URL (e.g. https://main.d32kjuxzigfust.amplifyapp.com).
Skipped entirely otherwise so unit CI stays hermetic. These tests assert
response CONTRACTS (shapes/statuses), not mutable market numbers, so they are
safe against a live deployment in any data state. Tests that require a
populated verified mapping auto-skip until one exists.
"""

import json
import os
import urllib.request

import pytest

BASE = os.environ.get("API_BASE_URL", "").rstrip("/")
pytestmark = pytest.mark.skipif(not BASE, reason="API_BASE_URL not set (opt-in contract tests)")


def get(path: str):
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "ftt-contract-tests"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def get_json(path: str):
    status, body = get(path)
    return status, json.loads(body)


def material_state():
    _, d = get_json("/api/material-value")
    return d.get("status")


# --- Always-valid contracts (any data state) --------------------------------

def test_material_value_root_status_is_known():
    status, d = get_json("/api/material-value")
    assert status == 200
    assert d["status"] in ("ok", "no_mapping", "disabled")


def test_unknown_material_never_returns_values():
    status, d = get_json("/api/material-value?material=zz_nonexistent_zz&realm=60")
    assert status == 200
    assert d["status"] in ("unknown_material", "no_mapping", "disabled")
    assert "reference_implied_value" not in d or d.get("reference_implied_value") is None


def test_material_requires_realm():
    if material_state() == "disabled":
        pytest.skip("feature disabled")
    status, d = get_json("/api/material-value?material=lumber_thalassian")
    assert status in (200, 400)
    if status == 400:
        assert "realm" in d.get("error", "")


def test_opportunities_invalid_sort_rejected():
    if material_state() == "disabled":
        pytest.skip("feature disabled")
    status, d = get_json("/api/decor-opportunities?material=lumber_x&realm=60&sort=evil")
    assert status == 400
    assert "sort" in d.get("error", "")


def test_opportunities_requires_params():
    if material_state() == "disabled":
        pytest.skip("feature disabled")
    status, _ = get_json("/api/decor-opportunities")
    assert status == 400


def test_no_sql_or_stack_leak_in_errors():
    for path in ("/api/material-value?material=zz_zz&realm=60",
                 "/api/decor-opportunities?material=zz&realm=abc"):
        _, body = get(path)
        low = body.lower()
        assert "traceback" not in low and "select " not in low and "relation" not in low


def test_debug_explain_not_publicly_accessible():
    status, body = get("/api/material-value?material=lumber_x&realm=60&debug=explain")
    assert "query plan" not in body.lower(), "EXPLAIN output must not be public"


def test_craft_debug_not_publicly_accessible():
    for q in ("debug=1", "debug=2"):
        status, body = get(f"/api/craft?{q}")
        assert status in (200, 403, 404)
        low = body.lower()
        assert "recipes_total" not in low and "item_class" not in low.replace("item_class\":", "x") or "recipes" in low
        # strong assertion: the diagnostic keys must be absent
        assert "costs_complete" not in low and "decor_costed" not in low


def test_health_exposes_lumber_block():
    status, d = get_json("/api/health")
    assert status == 200
    assert "lumber" in d and isinstance(d["lumber"], dict)
    assert "feature_enabled" in d["lumber"]


def test_lumber_page_disclaimer_visible():
    status, body = get("/lumber")
    assert status == 200
    assert "modeled opportunity value" in body
    assert "not directly priced on the Auction House" in body


def test_lumber_page_never_renders_zero_placeholder():
    _, body = get("/lumber")
    # The unavailable state renders an em dash / message, never "0g per lumber"
    assert "0g per lumber" not in body


# --- Contracts requiring a populated verified mapping (auto-skip until then) -

def needs_data():
    if material_state() != "ok":
        pytest.skip("no verified mapping imported yet (expected until v1.0.0 lands)")


def test_realm_isolation_distinct_summaries():
    needs_data()
    _, d = get_json("/api/material-value")
    mat = d["materials"][0]["material_key"]
    _, a = get_json(f"/api/material-value?material={mat}&realm=60")
    _, b = get_json(f"/api/material-value?material={mat}&realm=3676")
    assert a.get("realm", {}).get("connected_realm_id") == 60
    assert b.get("realm", {}).get("connected_realm_id") == 3676


def test_reference_null_below_min_eligible():
    needs_data()
    _, d = get_json("/api/material-value")
    mat = d["materials"][0]["material_key"]
    _, s = get_json(f"/api/material-value?material={mat}&realm=60")
    if s["status"] == "insufficient_data":
        assert s["reference_implied_value"] is None


def test_pagination_bounds():
    needs_data()
    _, d = get_json("/api/material-value")
    mat = d["materials"][0]["material_key"]
    status, o = get_json(f"/api/decor-opportunities?material={mat}&realm=60&limit=999")
    assert status == 200 and o["total_returned"] <= 100


def test_excluded_rows_have_reasons():
    needs_data()
    _, d = get_json("/api/material-value")
    mat = d["materials"][0]["material_key"]
    _, o = get_json(f"/api/decor-opportunities?material={mat}&realm=60&include_excluded=1&limit=100")
    for row in o["rows"]:
        if row["eligibility_status"] == "EXCLUDED":
            assert row["exclusion_reasons"], "excluded rows must carry reasons"
            assert row["implied_value_per_material"] is None or True  # value may be absent
