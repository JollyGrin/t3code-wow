-- Controller support.
--
-- While the T3 Code window is open in Forever's gamepad UI, the window takes the
-- controller for itself (EnableGamePadButton/EnableGamePadStick, the same way other
-- Forever addons drive their own windows), so nothing reaches your character:
--   D-pad / left stick  move the gamepad cursor between controls
--   A                   press the control (on the message box: type / send)
--   B                   leave the message box, then go back, then close
--   X                   read the latest reply aloud
--   Y (hold)            talk: dictation on your desktop, release to finish
--   LB / RB             switch tabs (Threads, Usage, Settings)
--   LT / RT, right stick  scroll the conversation
--   Start / Menu        still opens the game menu
-- Nothing here touches Blizzard's smart-navigation or binding-group code, so the
-- gamepad action bars can't be tainted by it.

local _, ns = ...
local UI = ns.UI

local G = {}
ns.Gamepad = G

local PAGES = { "threads", "usage", "settings" }
local LEFT_STICKS = { Left = true, Movement = true }
local RIGHT_STICKS = { Right = true, Camera = true, Look = true }
local PASS_THROUGH = { PADFORWARD = true, PADSYSTEM = true, PADSOCIAL = true }
local REPEAT_FIRST, REPEAT_NEXT = 0.32, 0.12


function G:IsActive()
	return InputUtil and InputUtil.IsGamepadUIEnabled and InputUtil.IsGamepadUIEnabled() and true or false
end

---------------------------------------------------------------------------
-- What can be selected right now

local function Usable(w)
	if not w or not w.IsVisible or not w:IsVisible() then return false end
	if w.IsEnabled and not w:IsEnabled() then return false end
	return true
end

local function InsideBox(frame, box)
	local t, b, bt, bb = frame:GetTop(), frame:GetBottom(), box:GetTop(), box:GetBottom()
	return t and b and bt and bb and t <= bt + 2 and b >= bb - 2
end

function G:Candidates()
	local main = ns.Main
	local f = main.frame
	local list = {}
	local function add(w, box, ed)
		if not Usable(w) then return end
		local x, y = w:GetCenter()
		if not x then return end
		local s = w:GetEffectiveScale()
		table.insert(list, { w = w, x = x * s, y = y * s, box = box, ed = ed })
	end
	-- An open dropdown list takes over: only its rows can be selected.
	local open = UI.ListOpen()
	if open then
		local box = open.Box
		box:ForEachFrame(function(frame, ed)
			if not ed.header and InsideBox(frame, box) then add(frame, box, ed) end
		end)
		return list
	end
	add(f.RefreshSlots)
	if main.page == "threads" then
		local page = f.Pages.threads
		if page.Left:IsShown() then
			add(ns.ThreadList.dropdown)
			local box = ns.ThreadList.scrollBox
			box:ForEachFrame(function(frame, ed)
				if (ed.thread or ed.header) and InsideBox(frame, box) then add(frame, box, ed) end
			end)
		end
		local header = page.Right.Header
		add(header.Action)
		add(header.Archive)
		add(header.Project)
		add(header.Model)
		add(header.Effort)
		local tbox = ns.Transcript.scrollBox
		tbox:ForEachFrame(function(frame, ed)
			if ed.kind == "option" and InsideBox(frame, tbox) then add(frame, tbox, ed) end
		end)
		add(main.composer)
		for _, key in ipairs({ "Refresh", "New", "Back", "Stop", "Mic", "Speak", "Shot", "Send" }) do add(f.Bar[key]) end
	elseif main.page == "settings" then
		for _, cb in ipairs(ns.Settings.checks or {}) do add(cb) end
		for _, w in ipairs(ns.Settings.controls or {}) do add(w) end
	end
	return list
end

---------------------------------------------------------------------------
-- The cursor

local pointer, glow

local function EnsurePointer(f)
	if pointer then return end
	local ok, p = pcall(CreateFrame, "Frame", nil, f, "SmartNavigationPointerTemplate")
	if ok and p and p.Icon and p.Icon.Cursor then
		p.Icon:SetFrameStrata("TOOLTIP")
		p.Icon.Cursor:ClearAllPoints()
		p.Icon.Cursor:SetPoint("RIGHT", p.Icon, "CENTER")
		pointer = p
	else
		p = CreateFrame("Frame", nil, f)
		p:SetSize(10, 10)
		p:SetFrameStrata("TOOLTIP")
		local t = p:CreateTexture(nil, "OVERLAY")
		t:SetAtlas("common-icon-forwardarrow")
		t:SetSize(20, 20)
		t:SetPoint("RIGHT", p, "CENTER")
		pointer = p
	end
	glow = CreateFrame("Frame", nil, f, "BackdropTemplate")
	glow:SetFrameStrata("TOOLTIP")
	glow:SetBackdrop({ edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border", edgeSize = 14 })
	glow:SetBackdropBorderColor(1, 0.82, 0, 0.9)
	glow:EnableMouse(false)
	pointer:EnableMouse(false)
	pointer:Hide()
	glow:Hide()
end

-- What a list row shows (rows are recycled, so remember content, not the frame).
local function RowKey(ed)
	if not ed then return nil end
	if ed.thread then return "t:" .. ed.thread.id end
	if ed.header then return "h:" .. tostring(ed.key) end
	if ed.kind == "option" then return "o:" .. tostring(ed.label) end
	if ed.value ~= nil then return "d:" .. tostring(ed.value) end
end

local function Boxes()
	local list = {}
	if ns.ThreadList.scrollBox then table.insert(list, ns.ThreadList.scrollBox) end
	if ns.Transcript.scrollBox then table.insert(list, ns.Transcript.scrollBox) end
	local open = UI.ListOpen()
	if open then table.insert(list, open.Box) end
	return list
end

local function KeyOfFrame(w)
	for _, box in ipairs(Boxes()) do
		local found
		box:ForEachFrame(function(frame, ed)
			if frame == w then found = RowKey(ed) end
		end)
		if found then return found, box end
	end
end

-- After a list rebuild, put the cursor back on the same thread/option/choice.
function G:Reresolve()
	if not self.capturing or not self.selectedKey then return end
	local current = self.selected and KeyOfFrame(self.selected)
	if current == self.selectedKey then return end
	for _, box in ipairs(Boxes()) do
		local hit
		box:ForEachFrame(function(frame, ed)
			if not hit and RowKey(ed) == self.selectedKey and InsideBox(frame, box) then hit = frame end
		end)
		if hit then
			local key = self.selectedKey
			self:Highlight(hit)
			self.selectedKey = key
			return
		end
	end
end

function G:Highlight(w)
	if self.selected and self.selected ~= w and self.selected.UnlockHighlight then
		self.selected:UnlockHighlight()
	end
	self.selected = w
	self.selectedKey = w and KeyOfFrame(w) or nil
	if not w then
		if pointer then pointer:Hide() glow:Hide() end
		return
	end
	if w.LockHighlight then w:LockHighlight() end
	pointer:ClearAllPoints()
	pointer:SetPoint("CENTER", w, "LEFT", -4, 0)
	pointer:Show()
	glow:ClearAllPoints()
	glow:SetPoint("TOPLEFT", w, "TOPLEFT", -4, 4)
	glow:SetPoint("BOTTOMRIGHT", w, "BOTTOMRIGHT", 4, -4)
	glow:Show()
end

function G:Validate()
	if self.selectedKey then self:Reresolve() end
	local w = self.selected
	if w and Usable(w) then
		for _, c in ipairs(self:Candidates()) do
			if c.w == w then return c end
		end
	end
	return nil
end

-- Pick a sensible first control: the open thread's row, else the first row.
function G:SelectDefault()
	local cands = self:Candidates()
	local best
	local open = UI.ListOpen()
	if open then
		for _, c in ipairs(cands) do
			if c.ed and open.owner and c.ed.value == open.owner.value then best = c break end
		end
		best = best or cands[1]
		self:Highlight(best and best.w)
		return
	end
	for _, c in ipairs(cands) do
		if c.ed and c.ed.thread and c.ed.thread.id == ns.viewId then best = c break end
	end
	if not best and ns.Main.mode == "new" then
		for _, c in ipairs(cands) do if c.w == ns.Main.composer then best = c end end
	end
	if not best then
		for _, c in ipairs(cands) do
			if c.ed and c.ed.thread then best = c break end
		end
	end
	best = best or cands[1]
	self:Highlight(best and best.w)
end

local DIRS = {
	PADDUP = { 0, 1 }, PADDDOWN = { 0, -1 }, PADDLEFT = { -1, 0 }, PADDRIGHT = { 1, 0 },
}

---------------------------------------------------------------------------
-- Explicit routes on the Threads page. Pure geometry gives odd jumps between the
-- thread list, the conversation and the message box, so those moves are fixed:
--   list  --Right-->  first answer option if the agent is asking, else message box
--   conversation  Up/Down:  Settle -> options (in order, scrolled into view) -> box
--   box  --Down-->  Send
--   conversation  --Left-->  the open thread's row in the list
--   bottom buttons  --Up-->  the list (under it) or the message box

-- Select element `index` of a ScrollBox, scrolling it into view first if needed.
local function SelectInBox(box, index)
	local ed = index and box:FindElementData(index)
	if not ed then return false end
	local frame = box:FindFrame(ed)
	if frame and InsideBox(frame, box) then
		G:Highlight(frame)
		return true
	end
	box:ScrollToElementDataIndex(index, ScrollBoxConstants.AlignCenter, nil, true)
	C_Timer.After(0, function()
		local fr = box:FindFrame(box:FindElementData(index))
		if fr then G:Highlight(fr) end
	end)
	return true
end

-- Indexes of the transcript's option rows (questions, approvals, quick replies).
local function OptionIndexes()
	local out = {}
	local box = ns.Transcript.scrollBox
	for i = 1, box:GetDataProviderSize() do
		local ed = box:FindElementData(i)
		if ed and ed.kind == "option" then table.insert(out, i) end
	end
	return out
end

-- Where "go to the conversation" lands.
function G:SelectConversation()
	local main = ns.Main
	if main.mode ~= "new" then
		-- The agent waiting on you (a question, an approval, a plan) comes first.
		local v = ns.Store:View()
		local t = ns.Store:Thread(ns.viewId)
		local waiting = (v and v.pending and not (ns.Transcript.answered and ns.Transcript.answered[v.pending.id]))
			or (t and t.s == "plan")
		local opts = OptionIndexes()
		if waiting and #opts > 0 then
			return SelectInBox(ns.Transcript.scrollBox, opts[1])
		end
	end
	if Usable(main.composer) then
		self:Highlight(main.composer)
		return true
	end
	return false
end

function G:SelectOpenThreadRow()
	local box = ns.ThreadList.scrollBox
	local first
	for i = 1, box:GetDataProviderSize() do
		local ed = box:FindElementData(i)
		if ed and ed.thread then
			first = first or i
			if ed.thread.id == ns.viewId then return SelectInBox(box, i) end
		end
	end
	return first and SelectInBox(box, first) or false
end

function G:Zone(cur)
	local main = ns.Main
	if main.page ~= "threads" then return nil end
	local w = cur.w
	local right = main.frame.Pages.threads.Right
	if w == ns.ThreadList.dropdown or cur.box == ns.ThreadList.scrollBox then return "list" end
	local h = right.Header
	if w == main.composer or w == h.Action or w == h.Archive or w == h.Project or w == h.Model or w == h.Effort or cur.box == ns.Transcript.scrollBox then
		return "convo"
	end
	for _, key in ipairs({ "Refresh", "New", "Back", "Stop", "Mic", "Speak", "Shot", "Send" }) do
		if w == main.frame.Bar[key] then return "bar", key end
	end
end

-- Returns true when it handled the move.
function G:ExplicitMove(cur, dirKey)
	local zone, barKey = self:Zone(cur)
	if not zone then return false end
	local main = ns.Main
	local right = main.frame.Pages.threads.Right
	local listShown = main.frame.Pages.threads.Left:IsShown()

	if zone == "list" and dirKey == "PADDRIGHT" then
		return self:SelectConversation()
	end

	if zone == "convo" then
		-- The header row, left to right: [Project] [Model] [Reasoning] on a new
		-- thread, [Model] [Reasoning] [Archive] [Settle] on an open one.
		local h = right.Header
		local row = {}
		for _, w in ipairs({ h.Project, h.Model, h.Effort, h.Archive, h.Action }) do
			if Usable(w) then table.insert(row, w) end
		end
		local at
		for n, w in ipairs(row) do if w == cur.w then at = n end end
		if at and (dirKey == "PADDLEFT" or dirKey == "PADDRIGHT") then
			local target = row[at + (dirKey == "PADDRIGHT" and 1 or -1)]
			if target then
				self:Highlight(target)
				return true
			end
			if dirKey == "PADDRIGHT" then return false end
			-- Past the left end: the thread list (on a new thread, let geometry decide).
			if main.mode == "new" then return false end
			return listShown and self:SelectOpenThreadRow() or false
		end
		if dirKey == "PADDLEFT" then
			return listShown and self:SelectOpenThreadRow() or false
		end
		if dirKey == "PADDUP" or dirKey == "PADDDOWN" then
			-- The column, top to bottom.
			local seq = {}
			local top = Usable(right.Header.Action) and right.Header.Action or (Usable(right.Header.Project) and right.Header.Project)
			if top then table.insert(seq, { w = top }) end
			if main.mode ~= "new" then
				for _, i in ipairs(OptionIndexes()) do table.insert(seq, { index = i }) end
			end
			table.insert(seq, { w = main.composer })
			local pos
			local curIndex = cur.box == ns.Transcript.scrollBox and ns.Transcript.scrollBox:FindElementDataIndex(cur.ed)
			for n, entry in ipairs(seq) do
				if (entry.w and entry.w == cur.w) or (entry.index and entry.index == curIndex) then pos = n end
			end
			-- Anywhere on the header row counts as its top.
			if not pos and at and top then pos = 1 end
			if not pos then return false end
			local nextPos = pos + (dirKey == "PADDDOWN" and 1 or -1)
			if nextPos > #seq then
				-- Below the message box: Send.
				if Usable(main.frame.Bar.Send) then self:Highlight(main.frame.Bar.Send) end
				return true
			end
			if nextPos < 1 then return true end
			local target = seq[nextPos]
			if target.index then return SelectInBox(ns.Transcript.scrollBox, target.index) end
			if Usable(target.w) then self:Highlight(target.w) end
			return true
		end
	end

	if zone == "bar" and dirKey == "PADDUP" then
		if (barKey == "Refresh" or barKey == "New") and listShown then
			return self:SelectOpenThreadRow()
		end
		return self:SelectConversation()
	end
	return false
end

function G:Move(dirKey)
	local d = DIRS[dirKey]
	if not d then return end
	local cur = self:Validate()
	if not cur then
		self:SelectDefault()
		return
	end
	if not UI.ListOpen() and self:ExplicitMove(cur, dirKey) then
		PlaySound(SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
		return
	end
	local best, bestScore
	for _, c in ipairs(self:Candidates()) do
		if c.w ~= cur.w then
			local dx, dy = c.x - cur.x, c.y - cur.y
			local along = dx * d[1] + dy * d[2]
			local across = math.abs(dx * d[2]) + math.abs(dy * d[1])
			if along > 4 then
				local score = along + across * (d[2] ~= 0 and 2.5 or 1.2)
				if not bestScore or score < bestScore then best, bestScore = c, score end
			end
		end
	end
	-- Nothing visible that way inside a list: scroll the list to the next row.
	if cur.box and d[2] ~= 0 then
		local box = cur.box
		local index = box:FindElementDataIndex(cur.ed)
		local size = box:GetDataProviderSize()
		local step = d[2] > 0 and -1 or 1
		local nextIndex = index and index + step
		-- A dropdown's group headers aren't choices; the thread list's are.
		local open = UI.ListOpen()
		local headers = not (open and box == open.Box)
		while nextIndex and nextIndex >= 1 and nextIndex <= size do
			local ed = box:FindElementData(nextIndex)
			if ed and (ed.thread or (ed.header and headers) or ed.kind == "option" or ed.value ~= nil) then break end
			nextIndex = nextIndex + step
		end
		local frame = nextIndex and nextIndex >= 1 and nextIndex <= size and box:FindFrame(box:FindElementData(nextIndex))
		local fullyVisible = frame and InsideBox(frame, box)
		if nextIndex and nextIndex >= 1 and nextIndex <= size and not fullyVisible then
			box:ScrollToElementDataIndex(nextIndex, ScrollBoxConstants.AlignNearest, nil, true)
			C_Timer.After(0, function()
				local fr = box:FindFrame(box:FindElementData(nextIndex))
				if fr then G:Highlight(fr) end
			end)
			PlaySound(SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
			return
		end
	end
	if best then
		self:Highlight(best.w)
		PlaySound(SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
	end
end

function G:Activate()
	local cur = self:Validate()
	if not cur then
		self:SelectDefault()
		return
	end
	local w = cur.w
	if w == ns.Main.composer then
		if w:HasFocus() then ns.Main:Send() else w:SetFocus() end
		return
	end
	if w.Click then
		w:Click("LeftButton")
	end
	-- The list may have been rebuilt by the click; keep the cursor on something real.
	C_Timer.After(0, function()
		if not G:Validate() then G:SelectDefault() end
	end)
end

---------------------------------------------------------------------------
-- Input

local function SwitchPage(delta)
	local current = 1
	for i, p in ipairs(PAGES) do if p == ns.Main.page then current = i end end
	ns.Main:ShowPage(PAGES[(current - 1 + delta) % #PAGES + 1])
	PlaySound(SOUNDKIT.IG_CHARACTER_INFO_TAB)
	G:SelectDefault()
end

local function Back()
	local main = ns.Main
	local box = main.composer
	local open = UI.ListOpen()
	if open then
		open:Hide()
	elseif box and box:HasFocus() then
		box:ClearFocus()
	elseif main.page ~= "threads" then
		main:ShowPage("threads")
		G:SelectDefault()
	elseif main.mode == "new" then
		main:Back()
		G:SelectDefault()
	else
		main.frame:Hide()
	end
end

local function ScrollTranscript(amount)
	local box = ns.Transcript.scrollBox
	if not box or not box:IsVisible() then return end
	if amount > 0 then box:ScrollDecrease(amount) else box:ScrollIncrease(-amount) end
end

function G:OnButtonDown(key)
	-- Presses an addon frame hands back don't reach the game's bindings, so Start
	-- closes the window (giving the controller back) rather than relying on that.
	if key == "PADFORWARD" then
		ns.Main.frame:Hide()
		return false
	end
	if PASS_THROUGH[key] then return true end
	ns.Interacted()
	local main = ns.Main
	if DIRS[key] then
		if main.composer:HasFocus() then main.composer:ClearFocus() end
		self:Move(key)
		self.repeatKey, self.repeatAt = key, GetTime() + REPEAT_FIRST
	elseif key == "PAD1" then
		self:Activate()
	elseif key == "PAD2" then
		Back()
	elseif key == "PAD3" then
		if main.page == "threads" then
			local cur = self:Validate()
			local t = cur and cur.ed and cur.ed.thread
			if t and t.id ~= ns.viewId then
				ns.Speak(t.last or t.title, t.id, "last")
			else
				main.frame.Bar.Speak:Click()
			end
		end
	elseif key == "PAD4" then
		if main.page == "threads" and not main.dictating then main:ToggleDictation() end
	elseif key == "PADLSHOULDER" then
		SwitchPage(-1)
	elseif key == "PADRSHOULDER" then
		SwitchPage(1)
	elseif key == "PADLTRIGGER" then
		ScrollTranscript(3)
	elseif key == "PADRTRIGGER" then
		ScrollTranscript(-3)
	elseif key == "PADBACK" then
		if ns.Launcher.ChordHeld() then main.frame:Hide() else main:ToggleSidebar() end
	end
	return false -- everything else stays with the window
end

function G:OnButtonUp(key)
	if PASS_THROUGH[key] then return true end
	if key == self.repeatKey then self.repeatKey = nil end
	if key == "PAD4" and ns.Main.dictating then ns.Main:ToggleDictation() end
	return false
end

function G:OnStick(stick, x, y)
	if math.abs(x) > 0.3 or math.abs(y) > 0.3 then ns.Interacted() end
	if LEFT_STICKS[stick] then
		local dir
		if math.abs(x) > 0.55 or math.abs(y) > 0.55 then
			if math.abs(x) > math.abs(y) then dir = x > 0 and "PADDRIGHT" or "PADDLEFT"
			else dir = y > 0 and "PADDUP" or "PADDDOWN" end
		end
		if dir ~= self.stickDir then
			self.stickDir = dir
			if dir then
				self:Move(dir)
				self.stickAt = GetTime() + REPEAT_FIRST
			end
		end
	elseif RIGHT_STICKS[stick] then
		self.scrollY = math.abs(y) > 0.25 and y or 0
	end
	return false
end

local ticker = CreateFrame("Frame")
ticker:SetScript("OnUpdate", function(_, elapsed)
	if not G.capturing then return end
	local now = GetTime()
	if G.repeatKey and G.repeatAt and now >= G.repeatAt then
		G:Move(G.repeatKey)
		G.repeatAt = now + REPEAT_NEXT
	end
	if G.stickDir and G.stickAt and now >= G.stickAt then
		G:Move(G.stickDir)
		G.stickAt = now + REPEAT_NEXT
	end
	if G.scrollY and G.scrollY ~= 0 then
		ScrollTranscript(G.scrollY * elapsed * 10)
	end
	-- Keep the cursor on something that still exists after list rebuilds.
	if G.selected and not Usable(G.selected) then G:SelectDefault() end
end)

---------------------------------------------------------------------------
-- Capture on/off

function G:StartCapture(f)
	if not self:IsActive() then return end
	if InCombatLockdown() then
		-- In a fight the controller stays with your character; we take it after.
		self.pendingCapture = true
		return
	end
	EnsurePointer(f)
	local ok, err = pcall(function()
		f:EnableGamePadButton(true)
		f:EnableGamePadStick(true)
	end)
	if not ok then
		ns.RecordError("gamepad capture: " .. tostring(err))
		return
	end
	if not self.scriptsSet then
		self.scriptsSet = true
		f:SetScript("OnGamePadButtonDown", ns.Safe(function(_, key) return G:OnButtonDown(key) end, false))
		f:SetScript("OnGamePadButtonUp", ns.Safe(function(_, key) return G:OnButtonUp(key) end, false))
		f:SetScript("OnGamePadStick", ns.Safe(function(_, stick, x, y) return G:OnStick(stick, x, y) end, false))
	end
	self.capturing = true
	self.pendingCapture = nil
	C_Timer.After(0, function() G:SelectDefault() end)
	ns.Main:Refresh()
end

function G:StopCapture(f)
	self.repeatKey, self.stickDir, self.scrollY = nil, nil, 0
	self:Highlight(nil)
	if not self.capturing then return end
	self.capturing = false
	local ok = pcall(function()
		f:EnableGamePadButton(false)
		f:EnableGamePadStick(false)
	end)
	if not ok then self.pendingRelease = true end
end

local function Bumper(button)
	return UI.ButtonIcon(button) or (button == "PADLSHOULDER" and "LB/L1 " or "RB/R1 ")
end

function G:HintText()
	return string.format("%s select   %s back   %s hold to talk   %s read aloud   %s%s tabs",
		UI.Glyph("PAD1", 14), UI.Glyph("PAD2", 14), UI.Glyph("PAD4", 14), UI.Glyph("PAD3", 14), Bumper("PADLSHOULDER"), Bumper("PADRSHOULDER"))
end

function G:HelpText()
	local chord = ns.Launcher and ns.Launcher.chordText
	return string.format("%s select  ·  %s back  ·  %s hold to talk  ·  %s read aloud  ·  %s%s tabs%s",
		UI.Glyph("PAD1"), UI.Glyph("PAD2"), UI.Glyph("PAD4"), UI.Glyph("PAD3"), Bumper("PADLSHOULDER"), Bumper("PADRSHOULDER"),
		chord and ("\nOpen or close T3 Code anywhere: hold " .. ns.Launcher.KeyText("PADLTRIGGER") .. " + " .. ns.Launcher.KeyText("PADRTRIGGER") .. " and press " .. ns.Launcher.KeyText("PADBACK") .. ".") or "\nOpen T3 Code any time from the minimap button or the game menu.")
end


ns:On("WindowShown", function(f) G:StartCapture(f) end)
ns:On("WindowHidden", function(f)
	G:StopCapture(f)
	if ns.Main.dictating then ns.Main:ToggleDictation() end
end)
ns:On("ListRebuilt", function() G:Reresolve() end)
ns:On("TranscriptRebuilt", function() G:Reresolve() end)

ns:On("DropdownOpened", function()
	if G.capturing then C_Timer.After(0, function() G:SelectDefault() end) end
end)
ns:On("DropdownClosed", function(owner)
	if not G.capturing then return end
	C_Timer.After(0, function()
		-- Back to the dropdown button that opened the list.
		if owner and owner:IsVisible() then G:Highlight(owner) elseif not G:Validate() then G:SelectDefault() end
	end)
end)

ns:On("PageChanged", function()
	if G.capturing then C_Timer.After(0, function() if not G:Validate() then G:SelectDefault() end end) end
end)

ns:On("Combat", function(inCombat)
	local f = ns.Main.frame
	if not f then return end
	if inCombat then
		-- Hand the controller back for the fight.
		if G.capturing then
			G:StopCapture(f)
			G.resumeAfterCombat = f:IsShown()
		end
		return
	end
	if G.pendingRelease then
		G.pendingRelease = nil
		pcall(function() f:EnableGamePadButton(false) f:EnableGamePadStick(false) end)
	end
	if (G.pendingCapture or G.resumeAfterCombat) and f:IsShown() then
		G.resumeAfterCombat = nil
		G:StartCapture(f)
	end
end)

ns:RegisterEvent("INPUT_DEVICE_INTERFACE_TRANSITION", function()
	local f = ns.Main.frame
	if f and f:IsShown() then
		if G:IsActive() then G:StartCapture(f) else G:StopCapture(f) end
		ns.Main:Refresh()
	end
	ns.Main:ApplyScale()
	ns.Transport:Touch()
end)

---------------------------------------------------------------------------
-- Launcher (kept in this file so /reload picks it up without a client restart)
---------------------------------------------------------------------------

local L = {}
ns.Launcher = L

-- Plain names, for when the game has no icon for a button.
local BUTTON_NAMES = {
	PADBACK = "Back/Select", PADFORWARD = "Start/Menu", PADLSTICK = "Left stick click", PADRSTICK = "Right stick click",
	PADLTRIGGER = "Left trigger", PADRTRIGGER = "Right trigger", PADLSHOULDER = "Left bumper", PADRSHOULDER = "Right bumper",
	PAD1 = "A/Cross", PAD2 = "B/Circle", PAD3 = "X/Square", PAD4 = "Y/Triangle",
}

-- A binding key ("PADBACK", "CTRL-T") as the player's own buttons or keys.
function L.KeyText(key)
	key = tostring(key)
	if not key:find("PAD") then
		return GetBindingText and GetBindingText(key) or key
	end
	local parts = {}
	for part in key:gmatch("[^-]+") do
		table.insert(parts, ns.UI.ButtonIcon(part) or BUTTON_NAMES[part] or part)
	end
	return table.concat(parts, " + ")
end

function L:Open()
	local main = ns.Main
	if main.frame and main.frame:IsShown() then
		main.frame:Hide()
		return
	end
	local toastThread = ns.Toasts and ns.Toasts:VisibleThread()
	if toastThread then
		main:SelectThread(toastThread, { show = true })
	else
		main:Open()
	end
end

---------------------------------------------------------------------------
-- Controller shortcut: hold both triggers and press Back.
--
-- In Forever's controller mode the triggers are the action-bar modifiers, Back is the
-- game's "focus interface" button, and the keybinding screen can't record controller
-- chords, so a key binding can't do this. Instead we read the controller's state each
-- frame and open T3 Code when Back goes down while both triggers are held.
--
-- We never take controller input outside our own window: an addon frame that
-- receives gamepad buttons breaks the LT + RT action bars (face buttons and D-pad),
-- even when it hands every press back. So the game also sees that Back press; with
-- nothing to focus it shows "no interface frame to focus", which we clear.

L.CHORD = { "PADLTRIGGER", "PADRTRIGGER", "PADBACK" }

local indexCache = {}
local function ButtonIndex(name)
	if indexCache[name] == nil then
		local ok, i = pcall(C_GamePad.ButtonBindingToIndex, name)
		indexCache[name] = ok and type(i) == "number" and i or false
	end
	return indexCache[name] or nil
end

-- Held state of the chord's buttons, or nil if we can't read the controller.
local function ReadButtons()
	if not C_GamePad or not C_GamePad.GetDeviceMappedState then return nil end
	local ok, state = pcall(C_GamePad.GetDeviceMappedState)
	if not ok or type(state) ~= "table" or type(state.buttons) ~= "table" then return nil end
	local held = {}
	for _, name in ipairs(L.CHORD) do
		local i = ButtonIndex(name)
		if not i then return nil end
		held[name] = state.buttons[i + 1] and true or false -- indexes are 0-based
	end
	return held
end

-- Read-only: this frame never enables gamepad input.
local watcher = CreateFrame("Frame")
L.watcher = watcher
local backWasDown = false
watcher:SetScript("OnUpdate", function()
	if not L.enabled or (ns.Gamepad and ns.Gamepad.capturing) then
		backWasDown = false
		return
	end
	local held = ReadButtons()
	if not held then return end
	local back = held.PADBACK
	if back and not backWasDown and held.PADLTRIGGER and held.PADRTRIGGER then
		L.firedAt = GetTime()
		ns.Safe(function() L:Open() end)()
		-- The game's own Back handler ran first; drop its "nothing to focus" error.
		if UIErrorsFrame and UIErrorsFrame.Clear then pcall(UIErrorsFrame.Clear, UIErrorsFrame) end
	end
	backWasDown = back
end)

function L:SetupChord()
	local mine = GetBindingKey("T3CODE_TOGGLE")
	self.keyText = mine and L.KeyText(mine) or nil
	self.enabled = ns.db.settings.padChord ~= "off" and C_GamePad ~= nil and ButtonIndex("PADLTRIGGER") ~= nil
	self.chord = self.enabled and table.concat(L.CHORD, "-") or nil
	self.chordText = self.enabled and L.KeyText(self.chord) or nil
end

-- Inside the T3 Code window (which has the controller to itself), the same chord
-- closes it. Gamepad.lua's window handler asks this.
function L.ChordHeld()
	local held = ReadButtons()
	return held and held.PADLTRIGGER and held.PADRTRIGGER
end

function L:HookGameMenu()
	if self.menuHooked or not GameMenuFrame or not GameMenuFrame.InitButtons then return end
	self.menuHooked = true
	hooksecurefunc(GameMenuFrame, "InitButtons", function(menu)
		if ns.db.settings.gameMenu == false then return end
		local ok, err = pcall(function()
			local button = menu:AddButton("T3 Code", function()
				PlaySound(SOUNDKIT.IG_MAINMENU_OPTION)
				HideUIPanel(menu)
				L:Open()
			end)
			-- Sit just above "Log Out" rather than under "Exit Game".
			local logoutText = menu.GetLogoutText and menu:GetLogoutText() or LOG_OUT
			for _, b in ipairs(menu.buttons or {}) do
				if b ~= button and b.GetText and b:GetText() == logoutText and b.layoutIndex then
					button.layoutIndex = b.layoutIndex - 0.5
					button.topPadding = nil
					break
				end
			end
		end)
		if not ok then ns.RecordError("game menu: " .. tostring(err)) end
	end)
end

ns:On("Login", function()
	L:HookGameMenu()
	L:SetupChord()
	if L.chordText and ns.Gamepad:IsActive() and not ns.db.chordAnnounced then
		ns.db.chordAnnounced = L.chord
		ns.Print("Open T3 Code from your controller: hold " .. L.KeyText("PADLTRIGGER") .. " + " .. L.KeyText("PADRTRIGGER") .. " and press " .. L.KeyText("PADBACK") .. ". It's also in the game menu.")
	end
end)

ns:RegisterEvent("UPDATE_BINDINGS", function()
	local mine = GetBindingKey("T3CODE_TOGGLE")
	L.keyText = mine and L.KeyText(mine) or nil
end)
