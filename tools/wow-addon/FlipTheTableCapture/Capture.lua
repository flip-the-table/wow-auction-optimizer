--[[
FlipTheTableCapture — manual, link-based capture of housing decor recipes.

Design constraints (deliberate):
  * Uses ONLY core, long-stable APIs: chat commands, item hyperlinks
    (shift-click), GetBuildInfo, UnitName, GetRealmName, time().
  * Makes NO claims about housing-specific addon APIs. The user reads the
    recipe from the in-game housing crafting UI and pastes item links; item
    IDs come from the links themselves, so IDs are authoritative even though
    quantities are typed by hand (quantities are cross-verified later by a
    second capture and repo-side validation).
  * Never touches the Auction House, never automates gameplay, never reads
    credentials.

Workflow (all via /fttcap):
    /fttcap new Sturdy Oak Bookshelf     -- start a draft recipe
    /fttcap out [item link] 1            -- set decor OUTPUT link + crafted qty
    /fttcap mat [item link] 12           -- add a CONSTRAINED material (lumber)
    /fttcap reagent [item link] 4        -- add another required reagent
    /fttcap note crafted at Workbench T2 -- optional station/unlock notes
    /fttcap save                         -- validate + store to SavedVariables
    /fttcap list                         -- show captured recipes
    /fttcap wipe                         -- clear ALL captured data (confirm)

Export: the SavedVariables file itself is the export —
  WTF/Account/<ACCOUNT>/SavedVariables/FlipTheTableCapture.lua
Copy it (after /reload or logout so it flushes) and feed it to
  scripts/convert_decor_recipe_export.py
]]

local CAPTURE_VERSION = "0.2.0"
local draft = nil

FlipTheTableCaptureDB = FlipTheTableCaptureDB or {}
FlipTheTableCaptureDB.captures = FlipTheTableCaptureDB.captures or {}
FlipTheTableCaptureDB.vendor_observations = FlipTheTableCaptureDB.vendor_observations or {}

local function msg(text)
    DEFAULT_CHAT_FRAME:AddMessage("|cfff5a623FTT Capture:|r " .. text)
end

local function parseLink(input)
    -- Item links look like |cff…|Hitem:12345:…|h[Name]|h|r
    local itemId = input:match("|Hitem:(%d+)")
    local name = input:match("|h%[(.-)%]|h")
    if itemId then return tonumber(itemId), name end
    return nil, nil
end

local function parseLinkAndQty(rest)
    local id, name = parseLink(rest)
    -- quantity = last standalone number after the link closes
    local qty = rest:match("|r%s+(%d+)%s*$") or rest:match("%]|h%s+(%d+)%s*$")
    return id, name, tonumber(qty)
end

local function buildMeta()
    local version, build = GetBuildInfo()
    return {
        capture_version = CAPTURE_VERSION,
        game_version = version,
        game_build = build,
        captured_at = time(),
        character = UnitName("player") .. "-" .. GetRealmName(),
        region = GetCurrentRegionName and GetCurrentRegionName() or "?",
    }
end

local handlers = {}

function handlers.new(rest)
    if rest == "" then msg("usage: /fttcap new <recipe name>"); return end
    draft = {
        recipe_name = rest,
        recipe_identifier = nil,   -- /fttcap rid — schematic id when visible in UI
        output = nil,
        crafted_quantity = nil,
        constrained_materials = {},
        other_reagents = {},       -- entries carry optional=true when via optreagent
        station = nil,             -- /fttcap station
        unlock = nil,              -- /fttcap unlock
        repeatable = nil,          -- /fttcap repeat yes|no (nil = not observed)
        variable_output = nil,     -- /fttcap varout yes|no (nil = not observed)
        screenshot_ref = nil,      -- /fttcap shot
        notes = nil,
        raw_inputs = {},  -- provenance: exact strings the user pasted
    }
    msg("Draft started: '" .. rest .. "'. Now /fttcap out [link] <qty>.")
end

local function setField(field, rest, usage)
    if not draft then msg("No draft — /fttcap new <name> first."); return end
    if rest == "" then msg("usage: " .. usage); return end
    draft[field] = rest
    msg(field .. " recorded.")
end

function handlers.rid(rest) setField("recipe_identifier", rest, "/fttcap rid <schematic id as shown>") end
function handlers.station(rest) setField("station", rest, "/fttcap station <station/interface name+tier>") end
function handlers.unlock(rest) setField("unlock", rest, "/fttcap unlock <requirement, or 'none'>") end
function handlers.shot(rest) setField("screenshot_ref", rest, "/fttcap shot <screenshot filename or note ref>") end

local function setYesNo(field, rest, usage)
    if not draft then msg("No draft."); return end
    rest = rest:lower()
    if rest ~= "yes" and rest ~= "no" then msg("usage: " .. usage); return end
    draft[field] = (rest == "yes")
    msg(field .. " = " .. rest)
end

handlers["repeat"] = function(rest) setYesNo("repeatable", rest, "/fttcap repeat yes|no") end
function handlers.varout(rest) setYesNo("variable_output", rest, "/fttcap varout yes|no") end

function handlers.out(rest)
    if not draft then msg("No draft — /fttcap new <name> first."); return end
    local id, name, qty = parseLinkAndQty(rest)
    if not id then msg("Could not read an item link. Shift-click the decor item into the command."); return end
    if not qty or qty < 1 then msg("Add the crafted quantity after the link, e.g. … 1"); return end
    draft.output = { item_id = id, name = name }
    draft.crafted_quantity = qty
    table.insert(draft.raw_inputs, "out|" .. rest)
    msg(("Output set: %s (id %d) x%d"):format(name or "?", id, qty))
end

local function addLine(listName, label, rest)
    if not draft then msg("No draft — /fttcap new <name> first."); return end
    local id, name, qty = parseLinkAndQty(rest)
    if not id then msg("Could not read an item link — shift-click it into the command."); return end
    if not qty or qty < 1 then msg("Add the quantity after the link, e.g. … 12"); return end
    table.insert(draft[listName], { item_id = id, name = name, quantity = qty })
    table.insert(draft.raw_inputs, label .. "|" .. rest)
    msg(("%s added: %s (id %d) x%d"):format(label, name or "?", id, qty))
end

function handlers.mat(rest) addLine("constrained_materials", "mat", rest) end
function handlers.reagent(rest) addLine("other_reagents", "reagent", rest) end

function handlers.optreagent(rest)
    if not draft then msg("No draft — /fttcap new <name> first."); return end
    local id, name, qty = parseLinkAndQty(rest)
    if not id or not qty or qty < 1 then
        msg("usage: /fttcap optreagent [link] <qty>"); return
    end
    table.insert(draft.other_reagents,
        { item_id = id, name = name, quantity = qty, optional = true })
    table.insert(draft.raw_inputs, "optreagent|" .. rest)
    msg(("OPTIONAL reagent added: %s (id %d) x%d"):format(name or "?", id, qty))
end

-- Vendor survey for lumber types: works OUTSIDE recipe drafts. Record exactly
-- what you observe at the vendor (or that you searched and found none).
-- Example: /fttcap vendor [Thalassian Lumber] sold by Provisioner X in Silvermoon,
--          5g each, unlimited stock, no rep gate
--          /fttcap vendor [Arden Lumber] no vendor found after checking
--          housing vendors + faction quartermasters
function handlers.vendor(rest)
    local id, name = parseLink(rest)
    if not id then
        msg("usage: /fttcap vendor [lumber link] <observation — vendor name/price/currency/limits/gating, or 'no vendor found'>")
        return
    end
    local observation = rest:match("|r%s*(.-)%s*$") or ""
    if observation == "" then
        msg("Add the observation text after the link."); return
    end
    table.insert(FlipTheTableCaptureDB.vendor_observations, {
        item_id = id,
        item_name = name,
        observation = observation,
        raw = rest,
        meta = buildMeta(),
    })
    msg(("Vendor observation recorded for %s (id %d). %d total."):format(
        name or "?", id, #FlipTheTableCaptureDB.vendor_observations))
end

function handlers.note(rest)
    if not draft then msg("No draft."); return end
    draft.notes = rest
    msg("Note saved.")
end

function handlers.save()
    if not draft then msg("No draft to save."); return end
    if not draft.output then msg("Missing output — /fttcap out [link] <qty>."); return end
    if #draft.constrained_materials == 0 then
        msg("No constrained material captured — /fttcap mat [lumber link] <qty>. If this recipe truly uses no lumber, it does not belong in this capture.")
        return
    end
    -- Completeness nudges (soft — capture what you can observe)
    if not draft.station then msg("Tip: /fttcap station <name> not recorded for this recipe.") end
    if not draft.unlock then msg("Tip: /fttcap unlock <req or 'none'> not recorded.") end
    if draft.repeatable == nil then msg("Tip: /fttcap repeat yes|no not recorded.") end
    draft.meta = buildMeta()
    table.insert(FlipTheTableCaptureDB.captures, draft)
    msg(("Saved '%s' (%d total). Data flushes to SavedVariables on /reload or logout."):format(
        draft.recipe_name, #FlipTheTableCaptureDB.captures))
    draft = nil
end

function handlers.list()
    local caps = FlipTheTableCaptureDB.captures
    msg(#caps .. " captured recipe(s):")
    for i, c in ipairs(caps) do
        msg(("  %d. %s -> %s x%s (%d mats, %d reagents)"):format(
            i, c.recipe_name, (c.output and c.output.name) or "?",
            tostring(c.crafted_quantity), #c.constrained_materials, #c.other_reagents))
    end
end

local wipeArmed = false
function handlers.wipe()
    if not wipeArmed then
        wipeArmed = true
        msg("This clears ALL captured recipes. Run /fttcap wipe again within 10s to confirm.")
        C_Timer.After(10, function() wipeArmed = false end)
        return
    end
    FlipTheTableCaptureDB.captures = {}
    wipeArmed = false
    msg("All captures cleared.")
end

function handlers.help()
    msg("Recipe: new <name> | out [link] <qty> | mat [link] <qty> | reagent [link] <qty> | optreagent [link] <qty>")
    msg("Fields: rid <id> | station <text> | unlock <text> | repeat yes/no | varout yes/no | shot <ref> | note <text>")
    msg("Other:  vendor [lumber link] <observation> | save | list | wipe")
end

SLASH_FTTCAP1 = "/fttcap"
SlashCmdList["FTTCAP"] = function(input)
    input = input or ""
    local cmd, rest = input:match("^(%S*)%s*(.-)$")
    cmd = (cmd or ""):lower()
    local handler = handlers[cmd]
    if handler then handler(rest) else handlers.help() end
end

msg("loaded v" .. CAPTURE_VERSION .. " — /fttcap help")
