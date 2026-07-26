// Maps a decor_recipe_valuations row (joined with recipe/item/source) to the
// API response shape. Shared by /api/material-value and /api/decor-opportunities.
export function mapValuationRow(v: any) {
  return {
    decor_item: {
      item_id: v.decor_item_id,
      name: v.item_name ?? null,
      quality: v.item_quality ?? null,
      icon_url: v.icon_url ?? null,
    },
    recipe: {
      id: v.decor_recipe_id,
      name: v.recipe_name ?? null,
      external_key: v.external_recipe_key,
      crafting_system: v.crafting_system ?? null,
      verification_status: v.verification_status,
      source_version: v.source_version ?? null,
    },
    realm_name: v.realm_name ?? null,
    connected_realm_id: v.connected_realm_id,
    listing_median: v.listing_median != null ? Number(v.listing_median) : null,
    listing_min: v.listing_min != null ? Number(v.listing_min) : null,
    listing_count: v.listing_count != null ? Number(v.listing_count) : null,
    listed_quantity: v.listed_quantity != null ? Number(v.listed_quantity) : null,
    listing_updated_at: v.listing_updated_at ?? null,
    estimated_realized_unit_price: v.estimated_realized_unit_price != null ? Number(v.estimated_realized_unit_price) : null,
    crafted_quantity: v.crafted_quantity != null ? Number(v.crafted_quantity) : null,
    gross_estimated_revenue: v.gross_estimated_revenue != null ? Number(v.gross_estimated_revenue) : null,
    net_estimated_revenue: v.net_estimated_revenue != null ? Number(v.net_estimated_revenue) : null,
    expected_deposit_loss: v.expected_deposit_loss != null ? Number(v.expected_deposit_loss) : null,
    other_reagent_cost: v.other_reagent_cost != null ? Number(v.other_reagent_cost) : null,
    material_quantity: v.constrained_material_quantity != null ? Number(v.constrained_material_quantity) : null,
    implied_value_per_material: v.implied_value_per_material != null ? Number(v.implied_value_per_material) : null,
    churn_rate: v.churn_rate != null ? Number(v.churn_rate) : null,
    estimated_market_units_per_day: v.estimated_market_units_per_day != null ? Number(v.estimated_market_units_per_day) : null,
    seller_capture_factor: v.seller_capture_factor != null ? Number(v.seller_capture_factor) : null,
    estimated_capturable_units_per_day: v.estimated_capturable_units_per_day != null ? Number(v.estimated_capturable_units_per_day) : null,
    expected_daily_contribution: v.expected_daily_contribution != null ? Number(v.expected_daily_contribution) : null,
    freshness_score: v.freshness_score != null ? Number(v.freshness_score) : null,
    liquidity_score: v.liquidity_score != null ? Number(v.liquidity_score) : null,
    input_quality_score: v.input_quality_score != null ? Number(v.input_quality_score) : null,
    model_quality: v.model_confidence_score != null ? Number(v.model_confidence_score) : null,
    eligibility_status: v.eligibility_status,
    exclusion_reasons: Array.isArray(v.exclusion_reasons)
      ? v.exclusion_reasons
      : JSON.parse(v.exclusion_reasons ?? '[]'),
    input_snapshot: typeof v.input_snapshot_json === 'string'
      ? JSON.parse(v.input_snapshot_json)
      : (v.input_snapshot_json ?? null),
    computed_at: v.computed_at ?? null,
  };
}
