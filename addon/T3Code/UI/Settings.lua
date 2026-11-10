-- Settings tab (also reachable from the game's Options > AddOns list).

local _, ns = ...
local UI = ns.UI

local S = {}
ns.Settings = S

local CHECKS = {
	{ key = "tracker", label = "Show T3 Code in the tracker area", after = function() ns.Tracker:Refresh() end },
	{ key = "trackerAlways", label = "Keep its header when nothing is running", after = function() ns.Tracker:Refresh() end },
	{ key = "trackerLocked", label = "Lock the tracker in place", after = function() ns.Tracker:Refresh() end },
	{ key = "toasts", label = "Pop up a notice when a thread finishes or needs you" },
	{ key = "sounds", label = "Play a sound with notices" },
	{ key = "quietInstances", label = "Stay quiet in dungeons, raids and PvP", tip = "Notices and read-aloud wait until you're out. They always wait during combat.", after = function() ns.Transport:Touch() end },
	{ key = "autoRead", label = "Read finished replies aloud", after = function() ns.Transport:Touch() end },
	{ key = "steerFollowUps", label = "Steer a working thread with follow-ups", tip = "A message to a thread that's still working goes into its current run, as in T3 Code. Turn this off to queue it until the run finishes.", after = function() ns.Main:Refresh() end },
	{ key = "dictateSend", label = "Send dictated messages right away" },
	{ key = "quickReplies", label = "Show quick replies under finished threads", after = function() ns.Transcript:Refresh(true) end },
	{ key = "gameMenu", label = "Add T3 Code to the game menu" },
	{ key = "minimapButton", label = "Show the minimap button", after = function() ns.MinimapButton:Refresh() end },
}

local VOICES = {
	{ "auto", "Automatic" },
	{ "system", "Desktop voice (via the bridge)" },
	{ "game", "Game voice" },
	{ "off", "Off" },
}

function S:Create(page)
	self.page = page
	local title = UI.Text(page, "GameFontNormalLarge")
	title:SetPoint("TOPLEFT", 20, -16)
	title:SetText("Settings")

	local y = -48
	self.checks = {}
	for _, c in ipairs(CHECKS) do
		local cb = CreateFrame("CheckButton", nil, page, "UICheckButtonTemplate")
		cb:SetPoint("TOPLEFT", 16, y)
		cb.Text:SetFontObject("GameFontHighlight")
		cb.Text:SetText(c.label)
		cb:SetScript("OnClick", function(self)
			ns.db.settings[c.key] = self:GetChecked() and true or false
			PlaySound(self:GetChecked() and SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON or SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_OFF)
			if c.after then c.after() end
		end)
		cb.key = c.key
		cb.Text:SetWidth(400)
		cb.Text:SetWordWrap(false)
		if c.tip then UI.Tooltip(cb, c.label, c.tip) end
		table.insert(self.checks, cb)
		y = y - 28
	end

	local voiceLabel = UI.Text(page, "GameFontHighlight")
	voiceLabel:SetPoint("TOPLEFT", 22, y - 12)
	voiceLabel:SetText("Voice for reading aloud")
	local dd = UI.Dropdown(page, 240, function(value)
		ns.db.settings.tts = value
		ns.Transport:Touch()
		S:Refresh()
	end)
	dd:SetPoint("LEFT", voiceLabel, "RIGHT", 16, 0)
	local options = {}
	for _, v in ipairs(VOICES) do table.insert(options, { value = v[1], label = v[2] }) end
	dd:SetOptions(options, ns.db.settings.tts)
	self.voice = dd
	local test = UI.Button(page, "Test voice", 110, function()
		ns.Speak("Hello from T3 Code. This is how replies will sound.", "", "test")
	end)
	test:SetPoint("LEFT", dd, "RIGHT", 10, 0)
	y = y - 40

	local sizeLabel = UI.Text(page, "GameFontHighlight")
	sizeLabel:SetPoint("TOPLEFT", 22, y - 12)
	sizeLabel:SetText("Window size")
	local size = UI.Dropdown(page, 240, function(value)
		ns.db.settings.windowScale = value
		ns.Main:ApplyScale()
	end)
	size:SetPoint("LEFT", sizeLabel, "RIGHT", 16, 0)
	size:SetOptions({
		{ value = "auto", label = "Automatic (larger with a controller)" },
		{ value = "normal", label = "Normal" },
		{ value = "large", label = "Large" },
		{ value = "xlarge", label = "Extra large" },
	}, ns.db.settings.windowScale or "auto")
	self.size = size
	y = y - 48

	local infoTitle = UI.Text(page, "GameFontNormal")
	infoTitle:SetPoint("TOPLEFT", 480, -16)
	infoTitle:SetText("Connection")
	self.info = UI.Text(page, "GameFontHighlightSmall")
	self.info:SetPoint("TOPLEFT", infoTitle, "BOTTOMLEFT", 0, -8)
	self.info:SetWidth(400)
	self.info:SetJustifyV("TOP")
	self.info:SetSpacing(3)

	local reload = UI.Button(page, "Reload UI", 130, function() ReloadUI() end)
	reload:SetPoint("BOTTOMLEFT", 20, 16)
	UI.Tooltip(reload, "Reload UI", "Frees up a fresh set of live updates. Does the same as typing /reload.")
	local resetTracker = UI.Button(page, "Reset tracker", 130, function()
		ns.db.settings.trackerPoint = nil
		ns.Tracker:Refresh(true)
	end)
	resetTracker:SetPoint("LEFT", reload, "RIGHT", 10, 0)
	local selftest = UI.Button(page, "Run self-test", 130, function() ns.SelfTest() end)
	selftest:SetPoint("LEFT", resetTracker, "RIGHT", 10, 0)
	UI.Tooltip(selftest, "Run self-test", "Checks the link to your desktop step by step and prints what's wrong, if anything.")
	local report = UI.Button(page, "Report a problem", 150, function() ns.Main:ShowPage("threads") ns.Main:Report() end)
	report:SetPoint("LEFT", selftest, "RIGHT", 10, 0)
	UI.Tooltip(report, "Report a problem", "Puts diagnostics in the message box and attaches a screenshot, for the thread you have open (or a new one).")
	self.controls = { dd, size, test, reload, resetTracker, selftest, report }
end

local SIGNAL_TEXT = {
	ok = "working",
	muted = "unavailable — game sound is off, so updates arrive more slowly",
	unreliable = "unreliable on this client — using slower polling",
	unavailable = "unavailable — using slower polling",
	untested = "starting",
}

function S:Refresh()
	if not self.page then return end
	for _, cb in ipairs(self.checks) do cb:SetChecked(ns.db.settings[cb.key] and true or false) end
	self.voice.value = ns.db.settings.tts
	self.voice:Update()
	self.size.value = ns.db.settings.windowScale or "auto"
	self.size:Update()
	local T = ns.Transport
	local b = ns.Store.data.bridge or {}
	local lines = {
		"Bridge: " .. (b.version and ns.Color("green", "t3code-wow " .. b.version) or ns.Color("red", "not heard from")),
		"T3 Code: " .. (b.t3 == "connected" and ns.Color("green", "connected" .. (b.server and (" (" .. b.server .. ")") or "")) or ns.Color("red", b.t3 or "unknown"))
			.. (b.t3err and ns.Color("grey", " — " .. b.t3err) or ""),
		(function()
			if not b.envs then return "Machines: this computer only " .. ns.Color("grey", "(add more with t3code-wow env add <host>)") end
			local parts = {}
			for _, e in ipairs(b.envs) do
				local ok = e.state == "connected"
				table.insert(parts, ns.Color(ok and "green" or "red", e.label) .. ns.Color("grey", string.format(" (%s)", ok and (e.n .. " threads") or e.state)))
			end
			return "Machines: " .. table.concat(parts, ", ")
		end)(),
		string.format("Live updates left this session: %s of %d (/reload frees more)", ns.Color("white", T:SlotsLeft()), T.slotCount),
		"Update signals: " .. (SIGNAL_TEXT[T.signals] or T.signals),
		"Desktop speech: " .. (b.tts or ns.Color("grey", "none found")) .. "    Dictation: " .. (b.dictation or ns.Color("grey", "none found")),
		"Speaking with: " .. ({ system = "desktop voice", game = "game voice", off = "nothing (off)" })[ns.SpeechEngine()],
		"Controller shortcut: " .. (ns.Launcher.chordText and ns.Color("white", "hold " .. ns.Launcher.KeyText("PADLTRIGGER") .. " + " .. ns.Launcher.KeyText("PADRTRIGGER") .. ", press " .. ns.Launcher.KeyText("PADBACK")) or ns.Color("grey", "off (use the minimap button or the game menu)"))
			.. ns.Color("grey", "  (also in the game menu)"),
		"Errors: " .. ((ns.db.errors and #ns.db.errors > 0) and ns.Color("red", #ns.db.errors .. " recorded — /t3 errors") or ns.Color("green", "none")),
		"Addon " .. ns.version .. ns.Color("grey", "  ·  session " .. (ns.db.session or "?")),
	}
	self.info:SetText(table.concat(lines, "\n"))
end

ns:On("DataChanged", function()
	if ns.Main.page == "settings" and ns.Main.frame and ns.Main.frame:IsShown() then S:Refresh() end
end)

-- Options > AddOns entry that opens the real settings tab.
ns:On("Login", function()
	if not Settings or not Settings.RegisterCanvasLayoutCategory then return end
	local panel = CreateFrame("Frame")
	local title = panel:CreateFontString(nil, "ARTWORK", "GameFontNormalLarge")
	title:SetPoint("TOPLEFT", 16, -16)
	title:SetText("T3 Code")
	local text = panel:CreateFontString(nil, "ARTWORK", "GameFontHighlight")
	text:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 0, -8)
	text:SetText("Watch and run your T3 Code agents from inside the game. Type /t3 to open the window.")
	local open = CreateFrame("Button", nil, panel, "UIPanelButtonTemplate")
	open:SetSize(200, 24)
	open:SetPoint("TOPLEFT", text, "BOTTOMLEFT", 0, -16)
	open:SetText("Open T3 Code settings")
	open:SetScript("OnClick", function()
		if SettingsPanel and SettingsPanel:IsShown() then HideUIPanel(SettingsPanel) end
		ns.Main:Open()
		ns.Main:ShowPage("settings")
	end)
	local category = Settings.RegisterCanvasLayoutCategory(panel, "T3 Code")
	Settings.RegisterAddOnCategory(category)
	ns.settingsCategory = category
end)
