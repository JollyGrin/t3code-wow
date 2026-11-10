-- The link to the t3code-wow bridge.
--
-- Addons can't open sockets or read files, so this uses three things the client
-- does allow (measured on live Forever clients; see docs/ARCHITECTURE.md):
--
--  out   A strip of colored squares in the top-left corner that the bridge reads
--        with a screen capture. It carries a status record and queued commands,
--        and is only drawn until the bridge acknowledges it (usually < 1 s).
--  in    Load-on-demand "slot" addons (T3Code_S001...). LoadAddOn reads a slot's
--        Lua from disk when it loads, so the bridge writes a snapshot there first.
--        Each slot loads once per UI session; /reload frees them all.
--  ping  "Bells": large silent .wav files the bridge fills or empties to say "a new
--        snapshot is waiting" (see below).
--
-- The strip is encrypted and authenticated (Crypto.lua) with keys that arrive in the
-- slot files, so a stream or recording of the screen shows only noise. Until the
-- keys arrive the strip carries just a bare hello, which the bridge answers with them.

local _, ns = ...
local Codec = ns.Codec
local Crypto = ns.Crypto

local T = {}
ns.Transport = T

local SLOT_FMT = "T3Code_S%03d"
local SIG_FMT = "Interface\\AddOns\\T3Code\\Signals\\%05d.wav"
local CELL = 3 -- physical pixels per strip square
local SIGNAL_POLL = 0.5
local MIN_LOAD_GAP = 0.6
local SHOW_FOR = 20 -- seconds a strip stays up without an acknowledgement
local RETRY_AFTER = { 15, 30, 60, 120 }

T.stripSeq = 0
T.ackedSeq = -1
T.queue = {}
T.slotCursor = 1
T.slotCount = 0
T.loads = 0
T.signals = "untested"
T.lastResultId = 0
T.retries = 0

local function SlotName(i)
	return SLOT_FMT:format(i)
end

---------------------------------------------------------------------------
-- Link keys. File-local on purpose: `ns` is exported as the T3Code global, and
-- nothing outside this file needs the keys.

local link -- { hex, enc, mac = HMAC function }
local noncePrefix, nonceCounter = nil, 0
local sealed = {} -- last frame sealed: { seq, plain, link, out }

local function Be32(v)
	return string.char(math.floor(v / 16777216) % 256, math.floor(v / 65536) % 256, math.floor(v / 256) % 256, v % 256)
end

-- Returns true if the keys changed.
local function SetKeys(hex)
	if type(hex) ~= "string" or (link and link.hex == hex) then return false end
	if not Crypto then
		-- Crypto.lua was added by an update while the game was running; the client
		-- only sees new files after a restart.
		if not T.needsRestart then
			T.needsRestart = true
			ns.Print("T3 Code was updated with new files. Quit and restart the game (a /reload isn't enough) to finish.")
		end
		return false
	end
	local raw = Crypto.FromHex(hex)
	if not raw or #raw ~= 64 then return false end
	link = { hex = hex, enc = raw:sub(1, 32), mac = Crypto.HMAC(raw:sub(33, 64)) }
	return true
end

-- nonce (12) .. ChaCha20(plain) .. tag (8). The nonce is unique per sealed frame:
-- a per-load prefix (time and random bytes) and a counter.
local function Seal(seq, plain)
	if sealed.link == link and sealed.seq == seq and sealed.plain == plain then return sealed.out end
	if not noncePrefix then
		noncePrefix = Be32(time() % 4294967296) .. string.char(math.random(0, 255), math.random(0, 255), math.random(0, 255), math.random(0, 255))
	end
	nonceCounter = nonceCounter + 1
	local nonce = noncePrefix .. Be32(nonceCounter)
	local ct = Crypto.ChaCha20(link.enc, nonce, 1, plain)
	local tag = link.mac(string.char(Codec.ENCRYPTED, math.floor(seq / 256), seq % 256) .. nonce .. ct):sub(1, 8)
	local out = nonce .. ct .. tag
	sealed.link, sealed.seq, sealed.plain, sealed.out = link, seq, plain, out
	return out
end

function T:Encrypted()
	return link ~= nil
end

-- "Bells": large silent .wav files the bridge fills (rings) or empties. Files over
-- the client's cacheable sound size are streamed and re-read on every play, so a
-- bell can be rung any number of times. PlaySoundFile's "willPlay" is true even for
-- empty files on Forever, so we check whether the sound is actually playing a moment
-- later instead. Eight bells rotate; see bridge/src/slots.js.
local BELL_BASE, BELLS = 3991, 8
local CTL_LONG, CTL_EMPTY = 3999, 4000
local CHECK_AFTER = 0.15
local CHANNELS = { "Master", "SFX", "Dialog", "Ambience", "Music" }
T.channel = "Master"

local function BellPath(k)
	return SIG_FMT:format(BELL_BASE + (k - 1) % BELLS)
end

-- Start playing a file; returns its handle (or nil, or false if the API errored).
local function Ring(path, channel)
	local ok, _, handle = pcall(PlaySoundFile, path, channel or T.channel)
	if not ok then return false end
	return handle
end

local function IsPlaying(handle)
	if not handle then return false end
	local ok, playing = pcall(C_Sound.IsPlaying, handle)
	return ok and playing and true or false
end

local function CountSlots()
	if not C_AddOns.DoesAddOnExist(SlotName(1)) then return 0 end
	local lo, hi = 1, 2
	while hi < 4096 and C_AddOns.DoesAddOnExist(SlotName(hi)) do
		lo, hi = hi, hi * 2
	end
	while hi - lo > 1 do
		local mid = math.floor((lo + hi) / 2)
		if C_AddOns.DoesAddOnExist(SlotName(mid)) then lo = mid else hi = mid end
	end
	return lo
end

-- Does a long valid sound play and an empty one not? Tried on each channel (a muted
-- channel plays nothing). Asynchronous: the result lands a moment later.
function T:SelfTest(onDone)
	if self.testing then return end
	self.testing = true
	local probes = {}
	for _, channel in ipairs(CHANNELS) do
		table.insert(probes, {
			channel = channel,
			long = Ring(SIG_FMT:format(CTL_LONG), channel),
			empty = Ring(SIG_FMT:format(CTL_EMPTY), channel),
		})
	end
	C_Timer.After(CHECK_AFTER + 0.1, function()
		local result = "muted" -- sound off, or the files weren't there at launch
		for _, p in ipairs(probes) do
			if p.long == false or p.empty == false then
				result = "unavailable"
			elseif result ~= "ok" and result ~= "unreliable" then
				local longPlays, emptyPlays = IsPlaying(p.long), IsPlaying(p.empty)
				if emptyPlays then
					result = "unreliable"
				elseif longPlays then
					self.channel = p.channel
					result = "ok"
				end
			end
			if p.long then StopSound(p.long) end
			if p.empty then StopSound(p.empty) end
		end
		self.testing = nil
		local before = self.signals
		self.signals = result
		self.selfTests = (self.selfTests or 0) + 1
		if ns.db then
			ns.db.signalTest = { result = result, channel = self.channel, tries = self.selfTests, at = time() }
		end
		if before ~= result then
			ns:Fire("LinkChanged")
			self:Touch() -- tell the bridge whether we're listening for bells
		end
		if onDone then onDone(result) end
	end)
end

---------------------------------------------------------------------------
-- Inbound: slots

function T:SlotsLeft()
	return math.max(0, self.slotCount - self.slotCursor + 1)
end

function T:LoadNextSlot(why)
	local now = GetTime()
	if self.lastLoadAt and now - self.lastLoadAt < MIN_LOAD_GAP and why ~= "bootstrap" then return end
	while self.slotCursor <= self.slotCount and C_AddOns.IsAddOnLoaded(SlotName(self.slotCursor)) do
		self.slotCursor = self.slotCursor + 1
	end
	if self.slotCursor > self.slotCount then
		if not self.exhausted then
			self.exhausted = true
			ns:Fire("LinkChanged")
		end
		return
	end
	local name = SlotName(self.slotCursor)
	self.slotCursor = self.slotCursor + 1
	self.lastLoadAt = now
	T3Code_Inbox = nil
	local loaded, reason = C_AddOns.LoadAddOn(name)
	if not loaded and reason == "DISABLED" then
		C_AddOns.EnableAddOn(name)
		loaded, reason = C_AddOns.LoadAddOn(name)
	end
	if not loaded then
		self.slotError = reason
		ns:Fire("LinkChanged")
		return
	end
	self.loads = self.loads + 1
	local fresh = false
	local data = T3Code_Inbox
	T3Code_Inbox = nil
	if type(data) == "table" then
		local newKeys = SetKeys(data.key)
		data.key = nil
		fresh = self:Apply(data, why == "bootstrap")
		if newKeys then self:Touch() end -- resend (now sealed), including held commands
	end
	if self.stripShown then self:DrawStrip() end
	return true, fresh
end

function T:Apply(data, bootstrap)
	local db = ns.db
	local fresh = type(data.gen) == "number" and data.gen > (db.gen or 0)
	if (fresh or bootstrap) and type(data.nextSig) == "number" then
		db.sigNext = data.nextSig
	end
	if type(data.ack) == "table" and data.ack.ui == ns.ui and type(data.ack.seq) == "number" then
		self:Acknowledge(data.ack.seq)
	end
	if type(data.results) == "table" then
		for _, r in ipairs(data.results) do
			if type(r.id) == "number" and r.id > self.lastResultId then
				self.lastResultId = r.id
				if r.id <= (db.cmdId or 0) then ns:Fire("CommandResult", r) end
			end
		end
	end
	if fresh or bootstrap then
		if fresh then db.gen = data.gen end
		self.lastData = GetTime()
		self.bridgeNow = data.now
		local hadModels = ns.Store.modelsHash
		ns.Store:Apply(data)
		-- Tell the bridge we have the new list, or it keeps sending it with every update.
		if ns.Store.modelsHash ~= hadModels then self:Touch() end
	end
	ns:Fire("LinkChanged")
	return fresh
end

---------------------------------------------------------------------------
-- Outbound: commands and the strip

function T:Touch()
	self.lastTouchAt = GetTime()
	self.stripSeq = (self.stripSeq + 1) % 65536
	self.showSince = nil
	self.hiddenUntil = nil
	self.retries = 0
	self:DrawStrip()
end

function T:Acknowledge(seq)
	if seq > self.ackedSeq or (self.ackedSeq > 60000 and seq < 1000) then
		self.ackedSeq = seq
	end
	local remaining, changed = {}, false
	for _, cmd in ipairs(self.queue) do
		if cmd.inSeq and cmd.inSeq <= self.ackedSeq then
			changed = true
		else
			table.insert(remaining, cmd)
		end
	end
	self.queue = remaining
	if changed and #remaining > 0 then
		self:Touch() -- send what didn't fit last time
	elseif self.ackedSeq >= self.stripSeq then
		self:HideStrip()
	end
end

-- Queue a command for the bridge. Returns its id.
function T:Send(verb, ...)
	local db = ns.db
	db.cmdId = (db.cmdId or 0) + 1
	local cmd = { id = db.cmdId, verb = verb, args = { ... }, at = GetTime() }
	table.insert(self.queue, cmd)
	self:Touch()
	return cmd.id
end

function T:Flags()
	local s = ns.db.settings
	local f = ""
	if ns.windowOpen then f = f .. "o" end
	if s.tracker then f = f .. "t" end
	if ns.Gamepad and ns.Gamepad:IsActive() then f = f .. "g" end
	if s.autoRead and ns.SpeechEngine and ns.SpeechEngine() == "system" then f = f .. "r" end
	if self.signals ~= "ok" then f = f .. "s" end
	if ns.IsQuiet() then f = f .. "q" end
	if self.attending then f = f .. "a" end
	return f
end

function T:Payload()
	local db = ns.db
	-- Without keys, only a bare hello (no thread id) so the bridge sends them.
	local hello = Codec.Record({
		"H", 1, db.session, ns.ui, self.slotCursor, db.sigNext or 1, db.gen or 0,
		self:Flags(), link and ns.viewId or "", ns.version, self.slotCount,
		ns.Store.modelsHash or "",
	})
	if not link then return hello end
	local limit = Codec.MAX_PAYLOAD - Codec.SEAL_OVERHEAD
	local parts, size = { hello }, #hello
	for _, cmd in ipairs(self.queue) do
		local fields = { "C", cmd.id, cmd.verb }
		for i = 1, #cmd.args do fields[#fields + 1] = cmd.args[i] end
		local rec = Codec.Record(fields)
		if size + 1 + #rec > limit then break end
		parts[#parts + 1] = rec
		size = size + 1 + #rec
		cmd.inSeq = self.stripSeq
	end
	return table.concat(parts, Codec.RS)
end

local strip
local cells = {}

local function EnsureStrip()
	if strip then return strip end
	strip = CreateFrame("Frame", "T3CodeLinkStrip", UIParent)
	strip:SetFrameStrata("TOOLTIP")
	strip:SetFrameLevel(9999)
	strip:SetIgnoreParentScale(true)
	strip:EnableMouse(false)
	strip:Hide()
	return strip
end

local function LayoutStrip()
	local s = EnsureStrip()
	-- One UI unit == one physical pixel (the same idea as Blizzard's PixelUtil).
	local _, physH = GetPhysicalScreenSize()
	s:SetScale(768 / (physH or 1080))
	s:ClearAllPoints()
	s:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
	s:SetSize(Codec.CELLS_PER_ROW * CELL, Codec.MAX_ROWS * CELL)
end

function T:DrawStrip()
	if not ns.db or ns.db.settings.strip == false then return end
	if self.ackedSeq >= self.stripSeq and #self.queue == 0 then
		self:HideStrip()
		return
	end
	if self.hiddenUntil and GetTime() < self.hiddenUntil then return end
	local plain = self:Payload()
	local values
	if link then
		values = Codec.Encode(self.stripSeq, Seal(self.stripSeq, plain), Codec.ENCRYPTED)
	else
		values = Codec.Encode(self.stripSeq, plain)
	end
	if not values then return end
	local s = EnsureStrip()
	LayoutStrip()
	local perRow = Codec.CELLS_PER_ROW
	for i = 1, #values do
		local t = cells[i]
		if not t then
			t = s:CreateTexture(nil, "OVERLAY")
			t:SetSize(CELL, CELL)
			t:SetPoint("TOPLEFT", s, "TOPLEFT", ((i - 1) % perRow) * CELL, -math.floor((i - 1) / perRow) * CELL)
			t:SetSnapToPixelGrid(true)
			t:SetTexelSnappingBias(0)
			cells[i] = t
		end
		local r, g, b = Codec.CellColor(values[i])
		t:SetColorTexture(r, g, b, 1)
		t:Show()
	end
	for i = #values + 1, #cells do cells[i]:Hide() end
	s:Show()
	self.stripShown = true
	self.showSince = self.showSince or GetTime()
end

function T:HideStrip()
	if strip then strip:Hide() end
	self.stripShown = false
	self.showSince = nil
end

---------------------------------------------------------------------------
-- Status for the UI

function T:BridgeState()
	if self.exhausted then return "exhausted" end
	if not self.lastData then return "waiting" end
	local age = time() - (self.bridgeNow or 0)
	local limit = ns.windowOpen and 200 or 900
	if age > limit then return "stale" end
	if ns.Store.data.bridge and ns.Store.data.bridge.t3 ~= "connected" then return "t3offline" end
	return "connected"
end

---------------------------------------------------------------------------
-- Ticker

local elapsedSinceSignal, elapsedSinceFallback = 0, 0

function T:OnUpdate(elapsed)
	-- Give up showing an unacknowledged strip for a while (bridge not running?).
	if self.stripShown and self.showSince and GetTime() - self.showSince > SHOW_FOR then
		self.retries = math.min(self.retries + 1, #RETRY_AFTER)
		self.hiddenUntil = GetTime() + RETRY_AFTER[self.retries]
		self:HideStrip()
		ns:Fire("LinkChanged")
	elseif not self.stripShown and self.hiddenUntil and GetTime() >= self.hiddenUntil then
		self.hiddenUntil = nil
		self:DrawStrip()
	end

	if self.exhausted then return end
	-- "Attending": the player has used the window in the last 90s (mouse over it,
	-- a controller press, typing). The bridge only sends fast updates while this is
	-- set. It flips rarely (start/stop engaging), so telling the bridge is cheap.
	if ns.windowOpen and ns.Main.frame and ns.Main.frame:IsMouseOver() then ns.Interacted() end
	local attending = ns.windowOpen and (GetTime() - (ns.lastInteraction or 0) < 90) or false
	if attending ~= (self.attending or false) then
		self.attending = attending
		self:Touch()
	end
	-- If we've heard nothing for a while although the player is reading, re-announce
	-- our position so the bridge can re-anchor (each announcement costs a slot).
	if attending and not self.stripShown and not self.hiddenUntil
		and GetTime() - (self.lastData or 0) > 45 and GetTime() - (self.lastTouchAt or 0) > 45
		and self:BridgeState() == "connected" then
		self:Touch()
	end
	-- Self-heal: if the bridge hasn't answered our strip in a few seconds, or we've
	-- heard nothing for a long while with the window open, fetch a slot anyway. The
	-- snapshot inside re-syncs which signal to watch.
	local now = GetTime()
	local quiet = now - (self.lastLoadAt or 0)
	if self.stripShown and self.showSince and now - self.showSince > 4 and quiet > 5 then
		self:LoadNextSlot("resync")
	elseif ns.windowOpen and quiet > 150 then
		self:LoadNextSlot("resync")
	end
	if self.signals == "ok" then
		local probe = self.bellProbe
		if probe then
			if GetTime() - probe.at >= CHECK_AFTER then
				-- The empty control should have stopped by now. If it still "plays",
				-- the client is slow to open files (a busy system, a screen recorder)
				-- and an empty bell would look rung too: give it longer.
				if IsPlaying(probe.control) and (probe.waits or 0) < 6 then
					probe.waits = (probe.waits or 0) + 1
					probe.at = GetTime()
					return
				end
				self.bellProbe = nil
				local found
				for _, b in ipairs(probe.bells) do
					if not found and IsPlaying(b.handle) then found = b.k end
					if b.handle then StopSound(b.handle) end
				end
				if probe.control then StopSound(probe.control) end
				if found and (probe.waits or 0) < 6 and GetTime() >= (self.ringCooldownUntil or 0) then
					-- Only a fresh snapshot moves us along: it carries the bridge's next
					-- bell (Apply sets db.sigNext). A ring that leads to old data was a
					-- false alarm; moving past it would put us ahead of the bridge, where
					-- the bells we listen to alias ones still rung from before.
					local loaded, fresh = self:LoadNextSlot("signal")
					if loaded and not fresh then
						self.falseRings = (self.falseRings or 0) + 1
						self.ringCooldownUntil = GetTime() + 3
						self:Touch() -- tell the bridge where we really are
					end
				end
			end
		else
			elapsedSinceSignal = elapsedSinceSignal + elapsed
			if elapsedSinceSignal >= SIGNAL_POLL then
				elapsedSinceSignal = 0
				-- Listen a few bells ahead, so one rung out of order can't strand us.
				local sig = ns.db.sigNext or 1
				local bells = {}
				for k = sig, sig + 3 do
					table.insert(bells, { k = k, handle = Ring(BellPath(k)) or nil })
				end
				local control = Ring(SIG_FMT:format(CTL_EMPTY)) or nil
				self.bellProbe = { at = GetTime(), bells = bells, control = control }
			end
		end
	else
		-- No signals (yet): retry the self-test now and then (sound may not have been
		-- ready at login), and meanwhile poll slots (costs a slot each time).
		self.retestIn = (self.retestIn or 10) - elapsed
		if self.retestIn <= 0 and self.signals ~= "unreliable" and not self.testing then
			self.retestIn = 10
			self:SelfTest()
		end
		elapsedSinceFallback = elapsedSinceFallback + elapsed
		-- Each poll costs a slot whether or not anything changed, so only poll briskly
		-- while the player is actually using the window.
		local every = 90
		if self.attending then every = 3
		elseif ns.windowOpen then every = 20 end
		if self.stripShown then every = 2 end
		if elapsedSinceFallback >= every then
			elapsedSinceFallback = 0
			self:LoadNextSlot("poll")
		end
	end
end

function T:Start()
	self.slotCount = CountSlots()
	self:SelfTest()
	if self.slotCount == 0 then
		self.slotError = "MISSING"
	else
		self:LoadNextSlot("bootstrap")
	end
	self:Touch() -- hello
	local ticker = CreateFrame("Frame")
	ticker:SetScript("OnUpdate", function(_, elapsed) T:OnUpdate(elapsed) end)
	self.ticker = ticker
	ns:Fire("LinkChanged")
end

ns:On("Login", function()
	T:Start()
end)

-- Combat and instance changes alter the quiet flag; tell the bridge.
ns:On("Combat", function() if T.ticker then T:Touch() end end)
ns:On("EnteringWorld", function() if T.ticker then T:Touch() end end)

ns:RegisterEvent("DISPLAY_SIZE_CHANGED", function()
	if T.stripShown then T:DrawStrip() end
end)
ns:RegisterEvent("UI_SCALE_CHANGED", function()
	if T.stripShown then T:DrawStrip() end
end)
