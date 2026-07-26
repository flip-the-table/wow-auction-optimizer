"""
Sensitivity analysis + reference-model comparison for the implied-material model.

Two modes:
  --fixtures   STRUCTURAL analysis on labeled synthetic recipe populations run
               through the REAL production engine (evaluate_recipe /
               summarize_material). Validates invariants and model mechanics.
               THIS IS NOT CALIBRATION — synthetic inputs, clearly labeled.
  --db         (future, once a verified mapping is imported) reruns the sweep
               against stored production inputs. Requires DATABASE_URL.

Invariants asserted (exit non-zero on violation):
  1. seller_capture_factor changes expected_daily_contribution but NEVER
     implied_value_per_material.
  2. churn changes expected_daily_contribution but NEVER
     implied_value_per_material.

Run: python scripts/lumber_sensitivity.py --fixtures
"""

import argparse
import asyncio
import json
import statistics
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from packages.shared.lumber_config import LumberFormulaParams
from services.jobs.lumber_valuation import (
    ListingInput, ReagentInput, RecipeContext, evaluate_recipe,
    summarize_material, weighted_median, weighted_percentile,
)

NOW = datetime(2026, 7, 27, 12, 0, 0, tzinfo=timezone.utc)


def params(**over) -> LumberFormulaParams:
    base = dict(
        version="sweep", realized_price_factor=0.85, ah_cut=0.05,
        deposit_loss_rate=0.0, seller_capture_factor=0.25,
        max_input_age_hours=12, min_listing_count=3, min_listed_quantity=2,
        max_cross_realm_multiplier=5.0, min_eligible_recipes=3,
    )
    base.update(over)
    return LumberFormulaParams(**base)


# --- Synthetic population (labeled; structural analysis only) ---------------
# A plausible-shaped market: 8 recipes with varied prices, liquidity, ages.
# Values are arbitrary test vectors, NOT captured game data.
FIXTURES = [
    # (median, listings, stock, age_h, churn, mat_qty, reagent_cost_total)
    ("deep_liquid_low",    80_000, 25, 120, 0.04, 10,  9_000),
    ("deep_liquid_mid",   150_000, 18,  80, 0.03, 12, 20_000),
    ("mid_market",        220_000, 10,  35, 0.02, 15, 30_000),
    ("mid_market_2",      260_000,  8,  28, 0.02, 16, 45_000),
    ("thin_pricey",       900_000,  4,   6, 0.005, 20, 60_000),
    ("thin_very_pricey", 2_400_000,  3,   4, 0.003, 25, 90_000),
    ("aging_snapshot",    180_000, 12,  50, 0.02, 12, 25_000, 10.0),  # 10h old
    ("negative_margin",    30_000, 14,  60, 0.05,  8, 50_000),
]


def build(fx, p: LumberFormulaParams):
    name, median, listings, stock, churn, mat_qty, reag_cost, *rest = fx
    age = rest[0] if rest else 2.0
    ctx = RecipeContext(recipe_id=hash(name) % 10_000, crafted_quantity=1.0,
                        material_quantity=float(mat_qty))
    listing = ListingInput(
        median=median, min_price=int(median * 0.9), listing_count=listings,
        listed_quantity=stock, updated_at=NOW - timedelta(hours=age),
        churn_rate=churn, snapshot_count=12, cross_realm_median=float(median) * 1.1,
    )
    reagents = [ReagentInput(item_id=1, quantity=1.0, pricing_scope="REGION_COMMODITY",
                             unit_price=reag_cost, price_updated_at=NOW - timedelta(hours=age))]
    return ctx, listing, reagents


def sweep_cell(p: LumberFormulaParams):
    evaluated = []
    for fx in FIXTURES:
        ctx, listing, reagents = build(fx, p)
        v = evaluate_recipe(ctx, listing, reagents, p, NOW)
        evaluated.append((fx[0], ctx.recipe_id, v))
    eligible = [(rid, v) for _, rid, v in evaluated if v.eligibility_status == "ELIGIBLE"]
    s = summarize_material(eligible, len(evaluated) - len(eligible), p)
    total_opp = sum(v.expected_daily_contribution for _, v in eligible)
    return evaluated, eligible, s, total_opp


def fmt_g(c):
    return "—" if c is None else f"{c/10000:,.1f}g"


def run_fixture_analysis() -> int:
    print(__doc__)
    print("== SYNTHETIC-STRUCTURAL ANALYSIS (not calibration; labeled fixtures) ==\n")
    failures = 0

    # --- Invariant checks ---------------------------------------------------
    base_p = params()
    _, elig_base, _, _ = sweep_cell(base_p)
    for cf in (0.05, 0.5):
        _, elig_cf, _, _ = sweep_cell(params(seller_capture_factor=cf))
        for (rid_a, va), (rid_b, vb) in zip(elig_base, elig_cf):
            assert rid_a == rid_b
            if va.implied_value_per_material != vb.implied_value_per_material:
                failures += 1
                print(f"INVARIANT VIOLATION: capture factor changed base value ({rid_a})")
    # churn invariance: rebuild fixtures with churn x3
    global FIXTURES
    orig = FIXTURES
    FIXTURES = [(f[0], f[1], f[2], f[3], f[4] * 3, f[5], f[6], *f[7:]) for f in orig]
    _, elig_churn, _, _ = sweep_cell(base_p)
    FIXTURES = orig
    for (rid_a, va), (rid_b, vb) in zip(elig_base, elig_churn):
        if va.implied_value_per_material != vb.implied_value_per_material:
            failures += 1
            print(f"INVARIANT VIOLATION: churn changed base value ({rid_a})")
    print(f"Invariant checks: {'PASS' if failures == 0 else 'FAIL'} "
          f"(capture-factor and churn do not move implied value per material)\n")

    # --- Sensitivity matrix -------------------------------------------------
    print(f"{'configuration':34s} {'reference':>10s} {'conserv.':>10s} {'best':>10s} "
          f"{'elig':>4s} {'daily opp':>12s}")
    rows = []
    for rpf in (0.65, 0.75, 0.85, 0.95):
        _, _, s, opp = sweep_cell(params(realized_price_factor=rpf))
        rows.append((f"realized_price_factor={rpf}", s, opp))
    for cf in (0.05, 0.10, 0.25, 0.50):
        _, _, s, opp = sweep_cell(params(seller_capture_factor=cf))
        rows.append((f"seller_capture_factor={cf}", s, opp))
    for mer in (3, 5, 10):
        _, _, s, opp = sweep_cell(params(min_eligible_recipes=mer))
        rows.append((f"min_eligible_recipes={mer}", s, opp))
    for age in (8, 12, 24):
        _, _, s, opp = sweep_cell(params(max_input_age_hours=age))
        rows.append((f"max_input_age_hours={age}", s, opp))
    for label, s, opp in rows:
        print(f"{label:34s} {fmt_g(s.reference_implied_value):>10s} "
              f"{fmt_g(s.conservative_implied_value):>10s} {fmt_g(s.best_conversion_value):>10s} "
              f"{s.eligible_recipe_count:>4d} {fmt_g(opp):>12s}")

    # --- Concentration (Phase 12) ------------------------------------------
    _, eligible, s, _ = sweep_cell(base_p)
    from services.jobs.lumber_valuation import recipe_weight
    weights = [(rid, recipe_weight(v), v.implied_value_per_material) for rid, v in eligible]
    total_w = sum(w for _, w, _ in weights)
    weights.sort(key=lambda t: t[1], reverse=True)
    top1 = weights[0][1] / total_w if total_w else 0
    top3 = sum(w for _, w, _ in weights[:3]) / total_w if total_w else 0
    print(f"\nWeight concentration: top-1 recipe = {top1:.0%}, top-3 = {top3:.0%} of aggregate weight")
    print("Note: the thin_very_pricey outlier holds the BEST value but only "
          f"{[f'{w/total_w:.1%}' for rid, w, v in weights if v and v > 500_000][:1]} of reference weight.")

    # --- Model comparison (Phase 13) ----------------------------------------
    values = [v.implied_value_per_material for _, v in eligible]
    ws = [max(recipe_weight(v), 1e-9) for _, v in eligible]
    per_realm_variants = values  # single-realm fixture set
    models = {
        "simple_median": int(statistics.median(values)),
        "weighted_median (implemented)": weighted_median(values, ws),
        "weighted_p25 (implemented cons.)": weighted_percentile(values, ws, 0.25),
        "median_of_realm_medians": int(statistics.median(per_realm_variants)),
        "top_quartile": weighted_percentile(values, ws, 0.75),
        "min_of_top3_liquid": min(sorted(
            (v.implied_value_per_material for _, v in eligible
             if v.liquidity_score >= 0.5), reverse=True)[:3] or [0]),
    }
    print("\nReference-model comparison (same eligible synthetic set):")
    for name, val in models.items():
        print(f"  {name:34s} {fmt_g(val):>10s}")

    return 1 if failures else 0


# --- Real-data mode (Phases 13-14) ------------------------------------------

async def run_db_analysis() -> int:
    """Sensitivity matrix + concentration analysis over STORED valuations.

    Re-derives the price chain from each row's preserved raw inputs
    (input_snapshot_json + listing columns) under swept parameters; ages are
    measured at original compute time (computed_at - input timestamps), so
    results are reproducible regardless of when this analysis runs.
    """
    from sqlalchemy import text
    from packages.shared.db import get_async_engine

    engine = get_async_engine()
    async with engine.connect() as conn:
        rows = (await conn.execute(text("""
            SELECT v.*, m.material_key
            FROM decor_recipe_valuations v
            JOIN constrained_materials m ON m.id = v.constrained_material_id
        """))).mappings().all()
    await engine.dispose()

    if not rows:
        print("No stored valuations — import a verified mapping and run compute first.")
        return 2

    def prep(v):
        snap = v["input_snapshot_json"]
        if isinstance(snap, str):
            snap = json.loads(snap)
        oldest = snap.get("oldest_input_at")
        age_h = None
        if oldest and v["computed_at"]:
            oldest_dt = datetime.fromisoformat(oldest)
            age_h = max(0.0, (v["computed_at"] - oldest_dt).total_seconds() / 3600)
        return snap, age_h

    def evaluate(v, snap, age_h, p: "LumberFormulaParams"):
        """Re-derive eligibility + implied value under swept params."""
        if v["listing_median"] is None or not v["crafted_quantity"]:
            return None
        if (v["listing_count"] or 0) < p.min_listing_count: return None
        if (v["listed_quantity"] or 0) < p.min_listed_quantity: return None
        if age_h is None or age_h > p.max_input_age_hours: return None
        cross = snap.get("cross_realm_median")
        if cross and v["listing_median"] > cross * p.max_cross_realm_multiplier:
            return None
        other = v["other_reagent_cost"]
        if other is None: return None
        realized = round(v["listing_median"] * p.realized_price_factor)
        gross = round(realized * v["crafted_quantity"])
        net = round(gross * (1 - p.ah_cut)) - round(gross * p.deposit_loss_rate)
        navail = net - other
        implied = round(navail / v["constrained_material_quantity"])
        market = min((v["churn_rate"] or 0) * 24, 1.0) * (v["listed_quantity"] or 0)
        contribution = round(max(0, navail / v["crafted_quantity"]) * market * p.seller_capture_factor)
        freshness = max(0.0, 1 - age_h / p.max_input_age_hours)
        weight = max(freshness * (v["liquidity_score"] or 0) * (v["input_quality_score"] or 0), 1e-9)
        return implied, contribution, weight

    prepared = [(v, *prep(v)) for v in rows]
    scopes = sorted({(v["connected_realm_id"], v["material_key"]) for v, _, _ in prepared})
    print(f"Stored valuations: {len(rows)} across {len(scopes)} (realm, material) scopes\n")

    def cell(p):
        per_scope = {}
        for v, snap, age_h in prepared:
            r = evaluate(v, snap, age_h, p)
            if r is None:
                continue
            per_scope.setdefault((v["connected_realm_id"], v["material_key"]), []).append(
                (v["decor_recipe_id"], *r))
        # global summary across scopes
        all_vals, all_ws, opp = [], [], 0
        realms_with_summary = 0
        for scope, entries in per_scope.items():
            vals = [e[1] for e in entries]; ws = [e[3] for e in entries]
            opp += sum(e[2] for e in entries)
            all_vals += vals; all_ws += ws
            if len(entries) >= p.min_eligible_recipes:
                realms_with_summary += 1
        ref = weighted_median(all_vals, all_ws) if len(all_vals) >= p.min_eligible_recipes else None
        cons = weighted_percentile(all_vals, all_ws, p.conservative_percentile) if ref is not None else None
        best = max(all_vals) if all_vals else None
        return ref, cons, best, len(all_vals), realms_with_summary, opp, per_scope

    # Invariants on real data
    base = cell(params())
    hi_capture = cell(params(seller_capture_factor=0.5))
    inv_fail = 0
    if base[0] != hi_capture[0] or base[2] != hi_capture[2]:
        inv_fail += 1; print("INVARIANT VIOLATION: capture factor moved base values")
    if base[5] >= hi_capture[5]:
        inv_fail += 1; print("INVARIANT VIOLATION: capture factor did not raise daily opportunity")
    print(f"Invariants on real data: {'PASS' if inv_fail == 0 else 'FAIL'}\n")

    print(f"{'configuration':34s} {'reference':>10s} {'conserv.':>10s} {'best':>10s} "
          f"{'elig':>5s} {'scopes':>6s} {'daily opp':>12s}")
    for label, p in (
        [(f"realized_price_factor={x}", params(realized_price_factor=x)) for x in (0.65, 0.75, 0.85, 0.95)]
        + [(f"seller_capture_factor={x}", params(seller_capture_factor=x)) for x in (0.05, 0.10, 0.25, 0.50)]
        + [(f"min_eligible_recipes={x}", params(min_eligible_recipes=x)) for x in (3, 5, 10)]
        + [(f"max_input_age_hours={x}", params(max_input_age_hours=x)) for x in (8, 12, 24)]
    ):
        ref, cons, best, n, scopes_ok, opp, _ = cell(p)
        print(f"{label:34s} {fmt_g(ref):>10s} {fmt_g(cons):>10s} {fmt_g(best):>10s} "
              f"{n:>5d} {scopes_ok:>6d} {fmt_g(opp):>12s}")

    # Concentration analysis (Phase 14) at defaults
    print("\nConcentration by (realm, material) at default params "
          "(flags: top1>35%, top3>70%, best>3x conservative, <5 eligible):")
    _, _, _, _, _, _, per_scope = base
    for scope, entries in sorted(per_scope.items()):
        vals = sorted((e[1] for e in entries), reverse=True)
        ws = [e[3] for e in entries]
        tw = sum(ws)
        shares = sorted((w / tw for w in ws), reverse=True)
        top1, top3 = shares[0], sum(shares[:3])
        ref = weighted_median([e[1] for e in entries], ws)
        cons = weighted_percentile([e[1] for e in entries], ws, 0.25)
        flags = []
        if top1 > 0.35: flags.append("TOP1>35%")
        if top3 > 0.70: flags.append("TOP3>70%")
        if cons and cons > 0 and vals[0] > 3 * cons: flags.append("BEST>3xCONS")
        if len(entries) < 5: flags.append("<5 ELIGIBLE")
        print(f"  realm {scope[0]:>5} {scope[1]:22s} n={len(entries):>3} "
              f"top1={top1:.0%} top3={top3:.0%} ref={fmt_g(ref)} "
              f"best={fmt_g(vals[0])} {' '.join(flags)}")

    return 1 if inv_fail else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", action="store_true")
    ap.add_argument("--db", action="store_true")
    args = ap.parse_args()
    if args.db:
        sys.exit(asyncio.run(run_db_analysis()))
    sys.exit(run_fixture_analysis())
