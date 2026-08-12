--[[
FlipTheTableCapture — AH decor scanner (/fttscan).

Captures (auctionID -> seller) for housing-decor ITEM auctions, which the
in-game AH API exposes via itemSearchResultInfo.owners. The web API never
carries seller identity, so these scans are the only source of "who listed
this" — joined repo-side with auction_outcomes (which already tracks every
auction id's fate) to build seller success analytics.

Design notes:
  * Read-only: browse + search queries, the same requests the AH UI makes.
    Never bids, buys, posts, or cancels. Requires the AH window to be open.
  * Throttle-aware: one search query at a time, advancing on
    AUCTION_HOUSE_THROTTLED_SYSTEM_READY.
  * Defensive: every Blizzard call is pcall'd; unexpected shapes skip the
    row rather than erroring the scan.

Workflow:
    open the Auction House, then:
    /fttscan            -- scan all housing-decor listings on this realm
    /fttscan status     -- progress / last scan summary
    /fttscan wipe       -- clear stored scans (after exporting)

Export: same SavedVariables file as recipe capture —
  WTF/Account/<ACCOUNT>/SavedVariables/FlipTheTableCapture.lua
Feed it to scripts/convert_ah_scan.py after /reload or logout.
]]

local SCAN_VERSION = "0.3.0"
local MAX_STORED_SCANS = 12

FlipTheTableCaptureDB = FlipTheTableCaptureDB or {}
FlipTheTableCaptureDB.ah_scans = FlipTheTableCaptureDB.ah_scans or {}

local function msg(text)
    DEFAULT_CHAT_FRAME:AddMessage("|cfff5a623FTT Scan:|r " .. text)
end

-- Resolve the housing-decor item classID at runtime from known decor items,
-- so we never hardcode an enum that may shift between builds.
local PROBE_DECOR_ITEMS = { 262616, 257725, 246951 }
local function resolveDecorClass()
    for _, itemId in ipairs(PROBE_DECOR_ITEMS) do
        local ok, _, _, _, _, _, classID, subclassID =
            pcall(function() return C_Item.GetItemInfoInstant and C_Item.GetItemInfoInstant(itemId) end)
        if not ok or classID == nil then
            local ok2, r2 = pcall(function() return { GetItemInfoInstant(itemId) } end)
            if ok2 and r2 and r2[6] then classID, subclassID = r2[6], r2[7] end
        end
        if classID ~= nil then return classID, subclassID end
    end
    return nil, nil
end

local scan = nil  -- active scan state

local function finishScan()
    if not scan then return end
    local results = scan.results
    local entry = {
        scan_version = SCAN_VERSION,
        game_version = select(1, GetBuildInfo()),
        scanned_at = time(),
        realm = GetRealmName(),
        region = GetCurrentRegionName and GetCurrentRegionName() or "?",
        character = UnitName("player"),
        num_items = scan.totalKeys,
        results = results,
    }
    table.insert(FlipTheTableCaptureDB.ah_scans, entry)
    while #FlipTheTableCaptureDB.ah_scans > MAX_STORED_SCANS do
        table.remove(FlipTheTableCaptureDB.ah_scans, 1)
    end
    msg(("scan complete: %d listings with sellers across %d items. /reload before copying SavedVariables.")
        :format(#results, scan.totalKeys))
    scan = nil
end

local function recordItemResults(itemKey)
    local okN, n = pcall(C_AuctionHouse.GetNumItemSearchResults, itemKey)
    if not okN or not n then return end
    for i = 1, n do
        local ok, info = pcall(C_AuctionHouse.GetItemSearchResultInfo, itemKey, i)
        if ok and info and info.auctionID then
            local owner = nil
            if info.owners and #info.owners > 0 then
                owner = tostring(info.owners[1])
                if #info.owners > 1 then
                    owner = owner .. "|" .. tostring(info.owners[2])
                end
            end
            if owner and owner ~= "" then
                table.insert(scan.results, {
                    a = info.auctionID,
                    i = itemKey.itemID,
                    q = info.quantity or 1,
                    p = info.buyoutAmount or info.bidAmount or 0,
                    o = owner,
                })
            end
        end
    end
end

local function nextQuery()
    if not scan then return end
    -- Pagination on the current key first
    if scan.currentKey then
        local okFull, full = pcall(C_AuctionHouse.HasFullItemSearchResults, scan.currentKey)
        if okFull and full == false then
            pcall(C_AuctionHouse.RequestMoreItemSearchResults, scan.currentKey)
            return
        end
        recordItemResults(scan.currentKey)
        scan.currentKey = nil
    end
    local nextKey = table.remove(scan.queue)
    if not nextKey then finishScan(); return end
    scan.currentKey = nextKey
    scan.done = scan.done + 1
    if scan.done % 25 == 0 then
        msg(("scanning… %d/%d items"):format(scan.done, scan.totalKeys))
    end
    local ok = pcall(C_AuctionHouse.SendSearchQuery, nextKey, {}, false)
    if not ok then
        -- skip this key on error
        scan.currentKey = nil
    end
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("AUCTION_HOUSE_BROWSE_RESULTS_UPDATED")
frame:RegisterEvent("AUCTION_HOUSE_BROWSE_RESULTS_ADDED")
frame:RegisterEvent("ITEM_SEARCH_RESULTS_UPDATED")
frame:RegisterEvent("ITEM_SEARCH_RESULTS_ADDED")
frame:RegisterEvent("AUCTION_HOUSE_THROTTLED_SYSTEM_READY")
frame:RegisterEvent("AUCTION_HOUSE_CLOSED")

frame:SetScript("OnEvent", function(_, event, ...)
    if not scan then return end
    if event == "AUCTION_HOUSE_CLOSED" then
        msg("AH closed — scan aborted (partial results discarded).")
        scan = nil
        return
    end
    if event == "AUCTION_HOUSE_BROWSE_RESULTS_UPDATED"
        or event == "AUCTION_HOUSE_BROWSE_RESULTS_ADDED" then
        if scan.phase ~= "browse" then return end
        local okFull, full = pcall(C_AuctionHouse.HasFullBrowseResults)
        if okFull and full == false then
            pcall(C_AuctionHouse.RequestMoreBrowseResults)
            return
        end
        local ok, results = pcall(C_AuctionHouse.GetBrowseResults)
        if not ok or not results then
            msg("browse results unavailable — aborting.")
            scan = nil
            return
        end
        scan.queue = {}
        for _, r in ipairs(results) do
            if r.itemKey and r.itemKey.itemID then
                table.insert(scan.queue, r.itemKey)
            end
        end
        scan.totalKeys = #scan.queue
        scan.done = 0
        scan.phase = "search"
        if scan.totalKeys == 0 then
            msg("no decor listings found in browse results.")
            scan = nil
            return
        end
        msg(("browse done: %d decor items listed — fetching sellers…"):format(scan.totalKeys))
        nextQuery()
    elseif event == "ITEM_SEARCH_RESULTS_UPDATED" or event == "ITEM_SEARCH_RESULTS_ADDED" then
        -- results for the current key are (partially) in; throttle-ready
        -- advances us, but if the system is idle advance now
        if scan.phase == "search" then nextQuery() end
    elseif event == "AUCTION_HOUSE_THROTTLED_SYSTEM_READY" then
        if scan.phase == "search" then nextQuery() end
    end
end)

local handlers = {}

function handlers.start()
    if scan then msg("a scan is already running (" .. scan.done .. "/" .. (scan.totalKeys or "?") .. ")"); return end
    if not C_AuctionHouse or not C_AuctionHouse.SendBrowseQuery then
        msg("Auction House API unavailable — open the AH first.")
        return
    end
    local classID = resolveDecorClass()
    if not classID then
        msg("could not resolve the housing-decor item class — are decor items in your local cache?")
        return
    end
    scan = { phase = "browse", results = {}, queue = {}, totalKeys = 0, done = 0 }
    local ok = pcall(C_AuctionHouse.SendBrowseQuery, {
        searchString = "",
        minLevel = 0,
        maxLevel = 0,
        filters = {},
        itemClassFilters = { { classID = classID } },
        sorts = {},
    })
    if not ok then
        msg("browse query failed — is the Auction House window open?")
        scan = nil
        return
    end
    msg("browsing decor listings…")
end

function handlers.status()
    if scan then
        msg(("scan running: phase=%s %d/%d"):format(scan.phase, scan.done, scan.totalKeys or 0))
    else
        local n = #FlipTheTableCaptureDB.ah_scans
        if n == 0 then msg("no stored scans.") else
            local last = FlipTheTableCaptureDB.ah_scans[n]
            msg(("%d stored scan(s); last: %s on %s, %d listings.")
                :format(n, date("%Y-%m-%d %H:%M", last.scanned_at), last.realm, #last.results))
        end
    end
end

function handlers.wipe()
    FlipTheTableCaptureDB.ah_scans = {}
    msg("all stored scans cleared.")
end

SLASH_FTTSCAN1 = "/fttscan"
SlashCmdList["FTTSCAN"] = function(input)
    local cmd = (input or ""):match("^%s*(%S*)"):lower()
    if cmd == "" or cmd == "start" then handlers.start()
    elseif cmd == "status" then handlers.status()
    elseif cmd == "wipe" then handlers.wipe()
    else msg("commands: /fttscan · /fttscan status · /fttscan wipe")
    end
end
