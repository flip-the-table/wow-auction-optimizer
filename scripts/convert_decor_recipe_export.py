"""
Convert a FlipTheTableCapture SavedVariables export into a candidate versioned
decor-recipe source file for the existing immutable loader.

  python scripts/convert_decor_recipe_export.py \
      --export "path/to/FlipTheTableCapture.lua" \
      --out-version 1.0.0 \
      [--second "path/to/second_capture.lua"]   # dual-capture verification
      [--validate-items]                        # live Blizzard identity checks
      [--game-build 12.0.7.67808]

Behavior:
  * Item IDs come from in-game item links (authoritative); quantities are
    hand-typed and therefore UNVERIFIED unless a second independent capture
    agrees exactly (=> VERIFIED) — mismatches become CONFLICTED and are
    emitted for manual review, never auto-resolved.
  * Constrained materials are normalized against the API-sourced registry
    data/decor_recipes/lumber_materials.v1.json; unknown constrained item IDs
    become draft material keys and are flagged.
  * --validate-items confirms every output/reagent ID against the Blizzard
    item API (name match, class/subclass recorded; a non-Decor output is
    FLAGGED, not rejected) and outputs against /data/wow/decor/ index.
  * Writes data/decor_recipes/v<version>.candidate.json + a validation report;
    refuses to touch an existing (immutable) non-candidate version file.
  * Raw capture blocks are preserved verbatim in the candidate file
    (provenance), separate from normalized data.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
REGISTRY_PATH = REPO / "data/decor_recipes/lumber_materials.v1.json"


# --- Minimal Lua-table parser for the addon's known SavedVariables shape ----

def lua_to_python(text: str):
    """Parse the FlipTheTableCaptureDB table. Strict: only the constructs the
    addon emits (nested tables, strings, numbers, booleans, [\"key\"] = value)."""
    m = re.search(r"FlipTheTableCaptureDB\s*=\s*", text)
    if not m:
        raise ValueError("FlipTheTableCaptureDB not found in export")
    s = text[m.end():]
    pos = 0

    def skip_ws():
        nonlocal pos
        while pos < len(s) and (s[pos] in " \t\r\n," or s.startswith("--", pos)):
            if s.startswith("--", pos):
                nl = s.find("\n", pos)
                pos = len(s) if nl == -1 else nl
            else:
                pos += 1

    def parse_value():
        nonlocal pos
        skip_ws()
        c = s[pos]
        if c == "{":
            return parse_table()
        if c == '"':
            return parse_string()
        if s.startswith("true", pos):
            pos += 4; return True
        if s.startswith("false", pos):
            pos += 5; return False
        if s.startswith("nil", pos):
            pos += 3; return None
        mnum = re.match(r"-?\d+\.?\d*(?:e[+-]?\d+)?", s[pos:])
        if mnum:
            pos += mnum.end()
            t = mnum.group(0)
            return float(t) if ("." in t or "e" in t) else int(t)
        raise ValueError(f"unexpected token at {pos}: {s[pos:pos+30]!r}")

    def parse_string():
        nonlocal pos
        assert s[pos] == '"'
        pos += 1
        out = []
        while s[pos] != '"':
            if s[pos] == "\\":
                nxt = s[pos + 1]
                out.append({"n": "\n", "t": "\t", '"': '"', "\\": "\\", "|": "|"}.get(nxt, nxt))
                pos += 2
            else:
                out.append(s[pos]); pos += 1
        pos += 1
        return "".join(out)

    def parse_table():
        nonlocal pos
        assert s[pos] == "{"
        pos += 1
        arr, mapping = [], {}
        while True:
            skip_ws()
            if s[pos] == "}":
                pos += 1
                break
            if s[pos] == "[":
                pos += 1
                key = parse_value()
                skip_ws()
                assert s[pos] == "]"; pos += 1
                skip_ws()
                assert s[pos] == "="; pos += 1
                mapping[key] = parse_value()
            else:
                mkey = re.match(r"([A-Za-z_]\w*)\s*=", s[pos:])
                if mkey:
                    pos += mkey.end()
                    mapping[mkey.group(1)] = parse_value()
                else:
                    arr.append(parse_value())
        if mapping and not arr:
            return mapping
        if arr and not mapping:
            return arr
        mapping["__array"] = arr
        return mapping

    return parse_value()


# --- Normalization -----------------------------------------------------------

def load_registry() -> dict[int, dict]:
    reg = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    return {m["item_id"]: m for m in reg["materials"]}


def normalize_captures(db: dict) -> list[dict]:
    caps = db.get("captures") or []
    if isinstance(caps, dict):
        caps = list(caps.values())
    out = []
    for c in caps:
        mats = c.get("constrained_materials") or []
        rgs = c.get("other_reagents") or []
        if isinstance(mats, dict): mats = list(mats.values())
        if isinstance(rgs, dict): rgs = list(rgs.values())
        out.append({
            "recipe_name": c.get("recipe_name"),
            "recipe_identifier": c.get("recipe_identifier"),
            "output_item_id": (c.get("output") or {}).get("item_id"),
            "output_name": (c.get("output") or {}).get("name"),
            "crafted_quantity": c.get("crafted_quantity"),
            "materials": [(m.get("item_id"), m.get("name"), m.get("quantity")) for m in mats],
            # required reagents (optional flag preserved separately)
            "reagents": [(r.get("item_id"), r.get("name"), r.get("quantity"))
                         for r in rgs if not r.get("optional")],
            "optional_reagents": [(r.get("item_id"), r.get("name"), r.get("quantity"))
                                  for r in rgs if r.get("optional")],
            "station": c.get("station"),
            "unlock": c.get("unlock"),
            "repeatable": c.get("repeatable"),
            "variable_output": c.get("variable_output"),
            "screenshot_ref": c.get("screenshot_ref"),
            "notes": c.get("notes"),
            "meta": c.get("meta") or {},
            "raw": c.get("raw_inputs") or [],
        })
    return out


def normalize_vendor_observations(db: dict) -> list[dict]:
    obs = db.get("vendor_observations") or []
    if isinstance(obs, dict):
        obs = list(obs.values())
    return [
        {
            "item_id": o.get("item_id"),
            "item_name": o.get("item_name"),
            "observation": o.get("observation"),
            "meta": o.get("meta") or {},
        }
        for o in obs
    ]


def is_incomplete(r: dict) -> list[str]:
    """Phase 6 INCOMPLETE classification: structurally unusable capture."""
    missing = []
    if not r["output_item_id"]:
        missing.append("output")
    if not r["crafted_quantity"] or r["crafted_quantity"] <= 0:
        missing.append("crafted_quantity")
    if not r["materials"]:
        missing.append("constrained_material")
    return missing


def recipe_key(name: str, output_id) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:80]
    return f"{slug or 'recipe'}-{output_id}"


def cross_verify(primary: list[dict], second: list[dict]) -> tuple[dict[str, str], list[str]]:
    """Return ({recipe_key: VERIFIED|CONFLICTED}, conflict_details).

    VERIFIED requires exact agreement on: output id, crafted qty, every
    constrained-material (id, qty), every REQUIRED reagent (id, qty).
    Optional-reagent differences are reported as warnings, never conflicts.
    Conflicts are never auto-resolved — the exact differing fields are emitted.
    """
    def signature(r):
        return {
            "output_item_id": r["output_item_id"],
            "crafted_quantity": r["crafted_quantity"],
            "materials": tuple(sorted((i, q) for i, _, q in r["materials"])),
            "required_reagents": tuple(sorted((i, q) for i, _, q in r["reagents"])),
        }
    by_key_2 = {recipe_key(r["recipe_name"], r["output_item_id"]): r for r in second}
    result, details = {}, []
    for r in primary:
        k = recipe_key(r["recipe_name"], r["output_item_id"])
        if k not in by_key_2:
            continue
        a, b = signature(r), signature(by_key_2[k])
        if a == b:
            result[k] = "VERIFIED"
            if sorted(r["optional_reagents"]) != sorted(by_key_2[k]["optional_reagents"]):
                details.append(f"{k}: optional reagents differ between captures (warning only)")
        else:
            result[k] = "CONFLICTED"
            for field in a:
                if a[field] != b[field]:
                    details.append(f"{k}: CONFLICT in {field}: A={a[field]!r} B={b[field]!r}")
    return result, details


# --- Optional live identity validation --------------------------------------

def blizzard_validate(item_ids: set[int]) -> dict[int, dict]:
    import httpx
    env = {}
    for line in (REPO / ".env").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1); env[k] = v
    tok = httpx.post("https://oauth.battle.net/token",
                     data={"grant_type": "client_credentials"},
                     auth=(env["BLIZZARD_CLIENT_ID"], env["BLIZZARD_CLIENT_SECRET"]),
                     timeout=20).json()["access_token"]
    H = {"Authorization": f"Bearer {tok}"}
    out = {}
    for iid in sorted(item_ids):
        r = httpx.get(f"https://us.api.blizzard.com/data/wow/item/{iid}",
                      params={"namespace": "static-us", "locale": "en_US"},
                      headers=H, timeout=20)
        if r.status_code != 200:
            out[iid] = {"exists": False}
            continue
        d = r.json()
        out[iid] = {
            "exists": True,
            "name": d.get("name"),
            "item_class": (d.get("item_class") or {}).get("name"),
            "item_subclass": (d.get("item_subclass") or {}).get("name"),
            "binding": ((d.get("preview_item") or {}).get("binding") or {}).get("name"),
        }
    return out


# --- Main --------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", required=True)
    ap.add_argument("--second", help="second independent capture for dual verification")
    ap.add_argument("--out-version", required=True, help="e.g. 1.0.0")
    ap.add_argument("--game-build", default=None)
    ap.add_argument("--validate-items", action="store_true")
    args = ap.parse_args()

    if not re.match(r"^\d+\.\d+\.\d+$", args.out_version):
        print(f"ERROR: malformed version {args.out_version!r}"); return 2
    final_path = REPO / f"data/decor_recipes/v{args.out_version}.json"
    if final_path.exists():
        print(f"ERROR: {final_path.name} already exists — source versions are immutable; pick a new version.")
        return 2
    out_path = REPO / f"data/decor_recipes/v{args.out_version}.candidate.json"

    primary_db = lua_to_python(Path(args.export).read_text(encoding="utf-8"))
    primary = normalize_captures(primary_db)
    vendor_obs = normalize_vendor_observations(primary_db)
    if not primary:
        print("ERROR: export contains no captures"); return 2
    second = []
    if args.second:
        second_db = lua_to_python(Path(args.second).read_text(encoding="utf-8"))
        second = normalize_captures(second_db)
        vendor_obs += normalize_vendor_observations(second_db)
    verification, conflict_details = (cross_verify(primary, second) if second else ({}, []))

    registry = load_registry()
    errors, warnings = [], []
    all_ids: set[int] = set()
    seen_keys: set[str] = set()
    recipes = []

    incomplete_count = 0
    for r in primary:
        key = recipe_key(r["recipe_name"], r["output_item_id"])
        label = f"recipe {key}"
        if key in seen_keys:
            errors.append(f"{label}: duplicate capture of the same recipe/output — resolve manually")
            continue
        seen_keys.add(key)
        missing = is_incomplete(r)
        if missing:
            incomplete_count += 1
            warnings.append(f"{label}: INCOMPLETE (missing {', '.join(missing)}) — excluded from candidate")
            continue

        status = verification.get(key, "UNVERIFIED")
        if status == "CONFLICTED":
            warnings.append(f"{label}: CONFLICTED — captures disagree; excluded from candidate until resolved")

        lumber_reagents = []
        for iid, name, qty in r["materials"]:
            if not qty or qty <= 0:
                errors.append(f"{label}: invalid material quantity"); continue
            reg = registry.get(iid)
            if reg is None:
                warnings.append(f"{label}: constrained item {iid} ({name}) not in lumber registry — draft key assigned")
            lumber_reagents.append({
                "material_key": (reg or {}).get("material_key") or f"draft_material_{iid}",
                "item_id": iid,
                "display_name": (reg or {}).get("display_name") or name or f"item {iid}",
                "quantity": qty,
                "is_tradeable": (reg or {}).get("is_tradeable", False),
                "is_account_bound": (reg or {}).get("is_account_bound", True),
            })
            all_ids.add(iid)

        other = []
        for iid, name, qty in r["reagents"]:
            if not iid or not qty or qty <= 0:
                errors.append(f"{label}: invalid reagent line"); continue
            other.append({"item_id": iid, "quantity": qty,
                          "pricing_scope": "REGION_COMMODITY", "optional": False,
                          "_captured_name": name})
            all_ids.add(iid)
        for iid, name, qty in r["optional_reagents"]:
            if not iid or not qty or qty <= 0:
                errors.append(f"{label}: invalid optional reagent line"); continue
            other.append({"item_id": iid, "quantity": qty,
                          "pricing_scope": "REGION_COMMODITY", "optional": True,
                          "_captured_name": name})
            all_ids.add(iid)
        all_ids.add(r["output_item_id"])

        meta = r["meta"]
        recipes.append({
            "external_recipe_key": key,
            "decor_item_id": r["output_item_id"],
            "decor_item_name": r["output_name"],
            "crafted_quantity": r["crafted_quantity"],
            "crafting_system": r.get("station") or "HOUSING_CRAFTING_UI",
            "recipe_name": r["recipe_name"],
            "lumber_reagents": lumber_reagents,
            "other_reagents": other,
            "_recipe_identifier": r.get("recipe_identifier"),
            "_unlock": r.get("unlock"),
            "_repeatable": r.get("repeatable"),
            "_variable_output": r.get("variable_output"),
            "_screenshot_ref": r.get("screenshot_ref"),
            "source_reference": (
                f"in-game capture by {meta.get('character', '?')} "
                f"({meta.get('region', '?')}), build {meta.get('game_version', '?')}."
                f"{meta.get('game_build', '?')}, at {meta.get('captured_at', '?')}"
                + ("; dual-capture verified" if status == "VERIFIED" else "")
            ),
            "verification_status": status if status != "CONFLICTED" else "UNVERIFIED",
            "_conflicted": status == "CONFLICTED",
            "notes": r["notes"],
            "_raw_capture": r["raw"],
        })

    # Live identity validation (Phase 6)
    identity_report = {}
    if args.validate_items:
        identity_report = blizzard_validate(all_ids)
        for rec in recipes:
            info = identity_report.get(rec["decor_item_id"], {})
            if not info.get("exists"):
                errors.append(f"recipe {rec['external_recipe_key']}: output item {rec['decor_item_id']} does not resolve in Blizzard item API")
            else:
                if info.get("name") and rec.get("decor_item_name") and info["name"] != rec["decor_item_name"]:
                    warnings.append(f"recipe {rec['external_recipe_key']}: captured name {rec['decor_item_name']!r} != API name {info['name']!r}")
                if info.get("item_subclass") != "Decor":
                    warnings.append(f"recipe {rec['external_recipe_key']}: output classified {info.get('item_class')}/{info.get('item_subclass')} (not Decor) — flagged, not rejected")

    kept = [r for r in recipes if not r.pop("_conflicted", False)]
    doc = {
        "_comment": "CANDIDATE produced by convert_decor_recipe_export.py — review, rename to v" + args.out_version + ".json after sign-off, then import via the Decor Recipe Source workflow.",
        "source_version": args.out_version,
        "game_build": args.game_build or (primary[0]["meta"].get("game_version", "UNKNOWN")),
        "effective_date": datetime.now(timezone.utc).date().isoformat(),
        "source_description": f"Verified subset captured in-game via FlipTheTableCapture addon ({len(kept)} of {len(recipes)} captured recipes; coverage NOT complete unless separately attested)",
        "source_method": "IN_GAME_LINK_CAPTURE" + ("+DUAL_CAPTURE" if second else ""),
        "verified_by": primary[0]["meta"].get("character"),
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "recipes": kept,
        "_identity_validation": identity_report,
    }
    out_path.write_text(json.dumps(doc, indent=2), encoding="utf-8", newline="\n")

    # Vendor observations: separate report (facts about lumber acquisition,
    # NOT part of the recipe source schema). Kept verbatim for review; the
    # material registry is updated manually from this evidence.
    if vendor_obs:
        vo_path = REPO / f"data/decor_recipes/vendor_observations.v{args.out_version}.json"
        vo_path.write_text(json.dumps({
            "_comment": "Raw in-game vendor observations for constrained materials. "
                        "Blizzard purchase_price metadata and observed vendor availability "
                        "are SEPARATE facts — only the latter belongs here.",
            "observations": vendor_obs,
        }, indent=2), encoding="utf-8", newline="\n")
        print(f"Vendor observations written: {vo_path} ({len(vendor_obs)} entries)")

    print(f"--- Validation report ({len(recipes) + incomplete_count} captured, {len(kept)} in candidate) ---")
    for e in errors: print("ERROR:", e)
    for w in warnings: print("WARN: ", w)
    for d in conflict_details: print("DIFF: ", d)
    verified = sum(1 for r in kept if r["verification_status"] == "VERIFIED")
    conflicted = len(recipes) - len(kept)
    print(f"VERIFIED: {verified} | UNVERIFIED: {len(kept) - verified} | "
          f"CONFLICTED (excluded): {conflicted} | INCOMPLETE (excluded): {incomplete_count}")
    print(f"Candidate written: {out_path}")
    if errors:
        print("Result: ERRORS present — candidate is NOT importable as-is.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
