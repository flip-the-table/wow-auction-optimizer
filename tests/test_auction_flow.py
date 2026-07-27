"""Auction-flow classification tests: expiry-safe removal logic + age mix."""

from services.jobs.ingest import (
    TIME_LEFT_MIN_HOURS,
    aggregate_time_left,
    classify_removal,
    diff_auction_flow,
)


def test_very_long_removal_within_gap_is_early():
    # VERY_LONG guarantees >= 12h remaining; an 8h gap cannot expire it
    assert classify_removal("VERY_LONG", 8.0) == "early"


def test_very_long_removal_after_long_gap_is_ambiguous():
    # Delayed cron: a 13h gap means VERY_LONG could have expired
    assert classify_removal("VERY_LONG", 13.0) == "ambiguous"


def test_short_and_medium_always_ambiguous_at_normal_cadence():
    assert classify_removal("SHORT", 8.0) == "ambiguous"
    assert classify_removal("MEDIUM", 8.0) == "ambiguous"
    assert classify_removal("LONG", 8.0) == "ambiguous"


def test_long_removal_with_tight_gap_is_early():
    # LONG guarantees >= 2h remaining; a 1h gap cannot expire it
    assert classify_removal("LONG", 1.0) == "early"


def test_unknown_bucket_is_ambiguous():
    assert classify_removal("???", 0.1) == "ambiguous"
    assert TIME_LEFT_MIN_HOURS["VERY_LONG"] == 12.0


def test_diff_counts_removals_and_new_listings():
    prev = {
        1: (100, 5, "VERY_LONG"),   # removed, provably early
        2: (100, 3, "SHORT"),       # removed, ambiguous
        3: (200, 1, "LONG"),        # survives
    }
    current = {
        3: (200, 1, "MEDIUM"),      # survivor (bucket aged)
        4: (100, 2, "VERY_LONG"),   # new listing
    }
    flow = diff_auction_flow(prev, current, gap_hours=8.0)
    assert flow[100] == {
        "removed_early_count": 1, "removed_early_qty": 5,
        "removed_ambiguous_count": 1, "removed_ambiguous_qty": 3,
        "new_count": 1, "new_qty": 2,
    }
    assert 200 not in flow  # survivor generates no flow


def test_diff_first_run_all_new():
    flow = diff_auction_flow({}, {9: (300, 4, "VERY_LONG")}, 8.0)
    assert flow[300]["new_count"] == 1 and flow[300]["new_qty"] == 4
    assert flow[300]["removed_early_count"] == 0


def test_aggregate_time_left_mix():
    mix = aggregate_time_left([
        (1, 100, 1, "VERY_LONG"), (2, 100, 1, "VERY_LONG"),
        (3, 100, 1, "SHORT"), (4, 200, 1, "LONG"),
    ])
    assert mix[100] == {"SHORT": 1, "MEDIUM": 0, "LONG": 0, "VERY_LONG": 2}
    assert mix[200] == {"SHORT": 0, "MEDIUM": 0, "LONG": 1, "VERY_LONG": 0}
