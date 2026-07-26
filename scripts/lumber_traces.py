"""
Phase-11 real calculation traces: prints full traces for eligible stored
valuations and INDEPENDENTLY recomputes every monetary step from the raw
inputs preserved in input_snapshot_json (plain arithmetic, not the engine).

Exits non-zero when any recomputation disagrees with stored values or when
fewer than --min traces are available (default 10).

Run (needs DATABASE_URL, e.g. via the Lumber Analysis workflow):
    python scripts/lumber_traces.py [--min 10] [--limit 12]
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text

from packages.shared.db import get_async_engine


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min", type=int, default=10)
    ap.add_argument("--limit", type=int, default=12)
    args = ap.parse_args()

    engine = get_async_engine()
    async with engine.connect() as conn:
        rows = (await conn.execute(text("""
            SELECT v.*, r.recipe_name, r.external_recipe_key, r.verification_status,
                   m.material_key, m.display_name AS material_name,
                   i.name AS item_name, ri.name AS realm_name
            FROM decor_recipe_valuations v
            JOIN decor_recipes r ON r.id = v.decor_recipe_id
            JOIN constrained_materials m ON m.id = v.constrained_material_id
            LEFT JOIN items i ON i.id = r.decor_item_id
            LEFT JOIN (SELECT connected_realm_id, MIN(name) AS name
                       FROM realms GROUP BY connected_realm_id) ri
                   ON ri.connected_realm_id = v.connected_realm_id
            WHERE v.eligibility_status = 'ELIGIBLE'
            ORDER BY v.model_confidence_score DESC NULLS LAST,
                     v.implied_value_per_material DESC
            LIMIT :lim
        """), {"lim": args.limit})).mappings().all()

    if len(rows) < args.min:
        print(f"INSUFFICIENT: only {len(rows)} eligible valuations "
              f"(need {args.min}) — real traces are not yet possible.")
        await engine.dispose()
        return 2

    failures = 0
    g = lambda c: "—" if c is None else f"{c/10000:,.2f}g ({c:,}c)"

    for i, v in enumerate(rows, 1):
        snap = v["input_snapshot_json"]
        if isinstance(snap, str):
            snap = json.loads(snap)
        p = snap["params"]

        print("=" * 78)
        print(f"TRACE {i}: {v['recipe_name']} [{v['external_recipe_key']}] "
              f"({v['verification_status']})")
        print(f"  Output: {v['item_name']}  Realm: {v['realm_name']} "
              f"({v['connected_realm_id']})  Material: {v['material_name']}")
        print(f"  Listing median: {g(v['listing_median'])}  "
              f"({v['listing_count']} listings, {v['listed_quantity']} listed, "
              f"snapshot {v['listing_updated_at']})")

        # ---- independent recomputation (plain arithmetic) ----
        realized = round(v["listing_median"] * p["realized_price_factor"])
        gross = round(realized * v["crafted_quantity"])
        deposit = round(gross * p["deposit_loss_rate"])
        net = round(gross * (1 - p["ah_cut"])) - deposit
        other = 0
        for rg in snap["reagents"]:
            if not rg["optional"] and rg["unit_price"] is not None:
                other += round(rg["quantity"] * rg["unit_price"])
                print(f"    reagent {rg['item_id']} x{rg['quantity']} @ "
                      f"{g(rg['unit_price'])} [{rg['pricing_scope']}] "
                      f"updated {rg['price_updated_at']}")
        navail = net - other
        implied = round(navail / v["constrained_material_quantity"])
        market = min(v["churn_rate"] * 24, 1.0) * v["listed_quantity"]
        capturable = market * p["seller_capture_factor"]
        contribution = round(max(0, navail / v["crafted_quantity"]) * capturable)

        checks = [
            ("realized unit price", v["estimated_realized_unit_price"], realized),
            ("gross revenue", v["gross_estimated_revenue"], gross),
            ("deposit loss", v["expected_deposit_loss"], deposit),
            ("net revenue (AH cut applied)", v["net_estimated_revenue"], net),
            ("other reagent cost", v["other_reagent_cost"], other),
            ("implied value per material", v["implied_value_per_material"], implied),
            ("expected daily contribution", v["expected_daily_contribution"], contribution),
        ]
        for label, stored, indep in checks:
            ok = stored == indep
            if not ok:
                failures += 1
            print(f"  {'OK ' if ok else 'FAIL'} {label}: stored={stored} independent={indep}")

        print(f"  x{p['realized_price_factor']} haircut | AH cut {p['ah_cut']:.0%} | "
              f"deposit rate {p['deposit_loss_rate']} | lumber x{v['constrained_material_quantity']}")
        print(f"  Market activity ~{market:.2f}/day x capture {p['seller_capture_factor']} "
              f"-> {capturable:.2f} capturable/day")
        print(f"  Scores: freshness={v['freshness_score']} liquidity={v['liquidity_score']} "
              f"input_quality={v['input_quality_score']} model_quality={v['model_confidence_score']}")
        if snap.get("warnings"):
            print(f"  Warnings: {snap['warnings']}")

    print("=" * 78)
    print("ALL TRACES INDEPENDENTLY VERIFIED" if failures == 0
          else f"{failures} INDEPENDENT CHECK(S) FAILED")
    await engine.dispose()
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
