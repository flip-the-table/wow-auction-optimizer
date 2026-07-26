# Implied Lumber Value & Decor Conversion Engine

## Why lumber has no direct market price

Lumber (and housing construction materials generally) is not tradeable on the
Auction House, so no listing or sale price exists for it anywhere in Blizzard's
API. Its economic value can only be **inferred** from what it converts into:
crafted housing decor that *is* tradeable per realm. Everything this feature
shows is therefore a **modeled opportunity value** — never a market price.

## Why decor listings are not confirmed sales

Blizzard exposes active auction listings only. The app never observes a sale.
A listing median says what sellers *ask*, not what buyers *pay*. The model
applies a configurable **realized-price factor** (haircut) to the observed
listing median as an explicit assumption, and all demand figures are
**churn-based**: quantity decreases between snapshots, which can include
expired and cancelled auctions, and can be masked by restocking.

## Why the professions API cannot provide the mapping

Verified 2026-07-26: all 10,964 recipes in Blizzard's professions catalog
produce armor/consumables/gems/weapons/tradeskill goods — zero Decor items.
The decor→lumber mapping is therefore a **curated source**
(`data/decor_recipes/*.json`, classification `CURATED_SOURCE`): versioned,
checksummed, immutable after import, and refused for production use unless
every recipe is `VERIFIED` with a `source_reference`. See
`data/decor_recipes/README.md` for authoring and import rules.

## Formulas (formula version `lv1`)

Implemented in `services/jobs/lumber_valuation.py` (pure, unit-tested);
parameters registered immutably in `lumber_formula_versions`.

```
estimated_realized_unit_price = round(listing_median × realized_price_factor)
gross_estimated_revenue       = round(realized_unit × crafted_quantity)
expected_deposit_loss         = round(gross × deposit_loss_rate)      # 0.0 in lv1 (explicit)
net_estimated_revenue         = round(gross × (1 − ah_cut)) − deposit_loss
other_reagent_cost            = Σ round(qty × unit_price)             # priced, required, non-constrained
net_value_available           = net_estimated_revenue − other_reagent_cost
implied_value_per_material    = round(net_value_available / material_quantity)   # negatives preserved

estimated_market_units_per_day     = min(churn_rate × 24, 1.0) × listed_quantity  # DERIVED proxy
estimated_capturable_units_per_day = market_units × seller_capture_factor         # MODELED
expected_daily_contribution        = max(0, net_value_available / crafted_qty) × capturable_units
```

Churn and capture affect **only** the daily-opportunity ranking metric — never
the base implied value per material.

### Aggregation (per material, per realm)

- `best_conversion_value` = max eligible implied value (single conversion, shown with its own quality)
- `reference_implied_value` = **weighted median** of eligible values; weight = freshness × liquidity × input-quality; unavailable (NULL) below `min_eligible_recipes`
- `conservative_implied_value` = weighted **25th percentile** (documented in the formula version)

### Eligibility / exclusion reasons

`MISSING_LISTING, STALE_LISTING, THIN_LISTING_COUNT, THIN_LISTED_QUANTITY,
OUTLIER_LISTING_PRICE, MISSING_REAGENT_PRICE, STALE_REAGENT_PRICE,
MULTIPLE_UNPRICED_CONSTRAINED_MATERIALS, UNVERIFIED_RECIPE,
DECOR_ITEM_UNRESOLVED, INVALID_MATERIAL_QUANTITY, INVALID_CRAFTED_QUANTITY,
INACTIVE_RECIPE`. Missing prices are **never** treated as zero — the recipe is
excluded and the reason stored/displayed.

## Scope rules

- Decor listings, churn, and reagents with `REALM_AUCTION` scope: the **selected
  realm only** (no silent cheapest-realm fallback).
- `REGION_COMMODITY` reagents: region-wide, matching the game's actual commodity
  market design.
- `VENDOR` prices come from `items.purchase_price`, which cannot be verified as
  actually vendor-purchasable → flagged `VENDOR_PRICE_UNVERIFIED` and penalized
  in input quality.

## Freshness

Inputs older than `max_input_age_hours` (default 12h; refresh cadence is
02/10/18 UTC) exclude the recipe. API responses carry `computed_at`,
`is_stale`, and `next_scheduled_refresh`; the UI shows a stale banner rather
than presenting old values as current.

## Model quality (not "confidence")

`model_quality = 0.35·freshness + 0.35·liquidity + 0.30·input_quality` — a
heuristic assessment of source verification, freshness, liquidity, and input
completeness. **It is not a probability** and is labeled accordingly.

## Configuration

Typed settings in `packages/shared/config.py` (`lumber_*`). Changing any
parameter for an already-used formula version aborts compute — bump
`LUMBER_MODEL_FORMULA_VERSION` instead. `LUMBER_FEATURE_ENABLED` gates the
API/UI (the compute runs in shadow regardless, cheap when no mapping exists).

## Operating procedures

- **Update recipe mappings**: author `data/decor_recipes/vX.Y.Z.json` → PR
  review → run the *Decor Recipe Source* workflow with the file path. The new
  version's recipes become the active set; prior versions are preserved.
- **Add a data provider** (e.g. a licensed sale-data source): implement the
  provider interfaces in `services/jobs/lumber_compute.py`
  (`ListingPriceProvider`, `ReagentPriceProvider`, `RecipeMappingProvider`) and
  introduce a new formula version if the value semantics change. Scraping TSM
  or similar sites is prohibited.
- **Roll back a formula version**: set `LUMBER_MODEL_FORMULA_VERSION` to the
  prior id — its parameters are still registered and historical rows keyed by
  version remain valid; the API serves the newest computed version by default
  and accepts `formula_version=` pinning.

## Known limitations

No confirmed sales exist anywhere in the pipeline; churn conflates sales with
expirations/cancellations and is hidden by restocking; the realized-price
factor and seller-capture factor are assumptions; deposits are not modeled in
lv1; crafting-order income is invisible to the API; coverage equals whatever
the curated mapping contains.
