"""Regression test for the VWAP price/quantity pairing fix (Phase 17.6)."""

from services.jobs.ingest import compute_buyout_stats


def auction(item_id, price, qty):
    return {"item": {"id": item_id}, "unit_price": price, "quantity": qty}


def test_vwap_pairs_price_with_its_own_quantity():
    # 1x at 100c and 99x at 10c. Correct VWAP = (100*1 + 10*99)/100 = 10.9 -> 10
    stats = compute_buyout_stats([auction(1, 100, 1), auction(1, 10, 99)])
    s = stats[1]
    assert s["total_quantity"] == 100
    assert s["vwap_buyout"] == int((100 * 1 + 10 * 99) / 100)
    # The old bug paired sorted prices with insertion-order quantities,
    # yielding (10*1 + 100*99)/100 = 99 — assert we are NOT doing that.
    assert s["vwap_buyout"] != int((10 * 1 + 100 * 99) / 100)


def test_median_min_mean_unchanged():
    stats = compute_buyout_stats(
        [auction(2, 50, 1), auction(2, 150, 1), auction(2, 100, 1)]
    )
    s = stats[2]
    assert s["min_buyout"] == 50
    assert s["median_buyout"] == 100
    assert s["mean_buyout"] == 100
    assert s["listing_count"] == 3
