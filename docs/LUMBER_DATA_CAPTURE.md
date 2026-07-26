# Capturing Decor Recipes for the Implied Lumber Pipeline

## What the investigation established (2026-07-27, build 12.0.7.67808)

| Question | Answer | Evidence |
|---|---|---|
| Do lumber items exist? | Yes — 12 types with real item IDs | Blizzard item search + detail (`data/decor_recipes/lumber_materials.v1.json`) |
| Are they AH-tradeable? | **No** — all 12 are "Binds to Warband"; none present in the live commodity feed | `preview_item.binding` + streamed commodity scan |
| Is there a decor API? | Yes — `/data/wow/decor/` (1,861 entries) maps decor→item IDs | live probe |
| Does any API expose decor **recipes/material quantities**? | **No** — decor detail has no materials; professions API has zero decor recipes | live probes |
| Vendor price? | `purchase_price=50000` on all 12 identically — NOT confirmation of vendor availability; must be checked in-game | item API |

Conclusion: **identities are validated automatically; quantities must be
captured in the game client.** Blizzard's ToS prohibit nothing about reading
your own recipe UI and pasting item links.

## Capture procedure (user)

1. Copy `tools/wow-addon/FlipTheTableCapture/` into
   `World of Warcraft/_retail_/Interface/AddOns/` and `/reload`.
2. Open the housing crafting/workbench UI at the decor station.
3. For each recipe (addon v0.2.0):
   - `/fttcap new <recipe name>`
   - `/fttcap out ` + **shift-click the decor output** + crafted quantity → `/fttcap out [Sturdy Oak Bookshelf] 1`
   - `/fttcap mat ` + shift-click each **lumber** + its quantity
   - `/fttcap reagent ` + shift-click each required reagent + quantity
   - `/fttcap optreagent [link] <qty>` for OPTIONAL reagent slots
   - `/fttcap station <name/tier>` · `/fttcap unlock <req or 'none'>` · `/fttcap rid <schematic id if shown>`
   - `/fttcap repeat yes|no` · `/fttcap varout yes|no` (can output quantity vary?)
   - `/fttcap shot <screenshot filename>` · `/fttcap note <anything else>`
   - `/fttcap save`
3b. **Vendor survey (once per lumber type, all 12)** — at housing/faction vendors:
   `/fttcap vendor [Thalassian Lumber] sold by <NPC> in <city>, <price+currency>, <limit/cap>, <rep gate or none>`
   or `/fttcap vendor [Arden Lumber] no vendor found after checking housing district + quartermasters`.
   Record what you SEE — the 5g `purchase_price` metadata is NOT evidence of vendor availability.
3c. Follow the stratified target list in `data/decor_recipes/capture_plan_v1.md` (rules 1-5 there).
4. `/reload` (flushes SavedVariables), then copy
   `WTF/Account/<ACCOUNT>/SavedVariables/FlipTheTableCapture.lua`.
5. **For VERIFIED status**: repeat the capture independently (second session or
   second character) — quantities must match exactly.

The addon never touches the AH, automates nothing, collects no credentials,
and claims no housing-API access — item IDs come from the links you paste.

## Conversion + import (developer)

```bash
python scripts/convert_decor_recipe_export.py \
    --export FlipTheTableCapture.lua \
    --second FlipTheTableCapture_second.lua \
    --out-version 1.0.0 --validate-items
# review data/decor_recipes/v1.0.0.candidate.json + validation report
# rename to v1.0.0.json, commit via PR
# then run the "Decor Recipe Source" GitHub Actions workflow with the file path
```

- Dual-capture agreement ⇒ `VERIFIED`; disagreement ⇒ `CONFLICTED` (excluded,
  emitted for manual review — the converter never picks a side).
- `--validate-items` confirms every ID against the Blizzard item API; a
  non-Decor output classification is flagged but not rejected.
- Existing source versions are immutable; the converter and loader both refuse
  to touch them.
- Coverage language: unless every recipe at every station tier was
  systematically captured, the source description must say **"verified
  subset"** (the converter writes this by default).

## After import

The next scheduled jobs run computes shadow valuations automatically. Check
`/api/health → lumber` for eligible/excluded counts, run
`python scripts/lumber_sensitivity.py --db` for calibration, and complete the
Phase 10 real-trace validation before enabling `LUMBER_FEATURE_ENABLED`.
