-- A permissive stand-in for the WoW client API, enough to load the T3Code addon in
-- plain Lua 5.1 and drive it through login, snapshots and UI interaction.
-- Unknown methods on frames are no-ops; known getters return plausible values.

dofile("tools/bitstub.lua") -- the client's `bit` library (LuaJIT has its own)

local Stub = { frames = {}, events = {}, tickers = {}, sounds = {}, loaded = {}, printed = {}, slotData = {} }
_G.WOWSTUB = Stub

local function noop() end

local GETTERS = {
	GetWidth = function(self) return self._w or 600 end,
	GetHeight = function(self) return self._h or 400 end,
	GetText = function(self) return (self._text or "") end,
	GetInputText = function(self) return (self._text or "") end,
	IsShown = function(self) return self._shown ~= false end,
	IsVisible = function(self) local p = self while p do if p._shown == false then return false end p = p._parent end return true end,
	GetChecked = function(self) return self._checked end,
	HasFocus = function(self) return self._focus or false end,
	GetStringHeight = function(self) local t = (self._text or "") local n = 1 for _ in t:gmatch("\n") do n = n + 1 end return n * 14 + math.floor(#t / 80) * 14 end,
	GetScrollPercentage = function() return 1 end,
	HasScrollableExtent = function() return false end,
	IsEnabled = function(self) return self._enabled ~= false end,
	GetAtlas = function(self) return self._atlas end,
	GetPoint = function() return "CENTER", nil, "CENTER", 0, 0 end,
	GetEditBox = function(self) self._eb = self._eb or Stub.NewFrame("EditBox") return self._eb end,
	IsObjectType = function() return false end,
	GetName = function(self) return self._name end,
	GetParent = function(self) return self._parent end,
	IsMouseMotionFocus = function() return false end,
	CreateAnimationGroup = function() return Stub.NewFrame("AnimationGroup") end,
	CreateAnimation = function() return Stub.NewFrame("Animation") end,
	GetNormalTexture = function() return Stub.NewFrame("Texture") end,
	GetPushedTexture = function() return Stub.NewFrame("Texture") end,
	GetFontHeight = function() return 14 end,
	GetFrameLevel = function(self) return self._level or 1 end,
	GetScale = function(self) return self._scale or 1 end,
	GetCenter = function(self) Stub.geo = (Stub.geo or 0) + 1 return 100 + (Stub.geo % 7) * 40, 500 - Stub.geo * 3 end,
	GetTop = function() return 300 end,
	GetBottom = function() return 280 end,
	GetEffectiveScale = function() return 1 end,
	GetDataProviderSize = function(self) return self._dp and #self._dp._items or 0 end,
	FindElementData = function(self, i) return self._dp and self._dp._items[i] end,
	FindElementDataIndex = function(self, ed) for i, e in ipairs(self._dp and self._dp._items or {}) do if e == ed then return i end end end,
	FindFrame = function(self, ed) for _, r in ipairs(self._rows or {}) do if r.ed == ed then return r.frame end end end,
}

local SETTERS = {
	SetWidth = function(self, w) self._w = w end,
	SetHeight = function(self, h) self._h = h end,
	SetSize = function(self, w, h) self._w, self._h = w, h end,
	SetText = function(self, t) self._text = t and tostring(t) or "" end,
	Show = function(self)
		local was = self._shown
		self._shown = true
		if not was and self._scripts.OnShow then self._scripts.OnShow(self) end
	end,
	Hide = function(self)
		local was = self._shown
		self._shown = false
		if was and self._scripts.OnHide then self._scripts.OnHide(self) end
	end,
	SetShown = function(self, s) if s then self:Show() else self:Hide() end end,
	SetChecked = function(self, c) self._checked = c end,
	SetAtlas = function(self, a) self._atlas = a end,
	SetFrameLevel = function(self, l) self._level = l end,
	EnableGamePadButton = function(self, on) self._gamepadEnabled = on end,
	SetPoint = function(self, point, rel, ...) self._points = self._points or {} table.insert(self._points, { point, rel, ... }) end,
	ClearAllPoints = function(self) self._points = {} end,
	SetColorTexture = function(self, r, g, b) self._color = { r, g, b } end,
	SetScript = function(self, name, fn) self._scripts[name] = fn end,
	HookScript = function(self, name, fn)
		local old = self._scripts[name]
		self._scripts[name] = function(...) if old then old(...) end fn(...) end
	end,
	GetScript = function(self, name) return self._scripts[name] end,
	SetFocus = function(self) self._focus = true end,
	ClearFocus = function(self) self._focus = false end,
	Enable = function(self) self._enabled = true end,
	Disable = function(self) self._enabled = false end,
	SetEnabled = function(self, e) self._enabled = e and true or false end,
	RegisterEvent = function(self, e) Stub.events[e] = Stub.events[e] or {} Stub.events[e][self] = true end,
	CreateTexture = function(self) return Stub.NewFrame("Texture", self) end,
	CreateFontString = function(self, _, _, font) local f = Stub.NewFrame("FontString", self) return f end,
	CreateMaskTexture = function(self) return Stub.NewFrame("Texture", self) end,
	Click = function(self) if self._scripts.OnClick then self._scripts.OnClick(self, "LeftButton") end end,
	-- ScrollBox
	SetDataProvider = function(self, dp)
		self._dp = dp
		self._rows = {}
		local view = self._view
		if not view or not view._factory then return end
		for _, ed in ipairs(dp._items) do
			if view._extent then view._extent(1, ed) end
			view._factory(function(template, init)
				local frame = Stub.NewFrame(template, self)
				init(frame, ed)
				table.insert(self._rows, { frame = frame, ed = ed })
			end, ed)
		end
	end,
	ForEachFrame = function(self, fn) for _, r in ipairs(self._rows or {}) do fn(r.frame, r.ed) end end,
	-- ScrollingEditBox
	RegisterCallback = function(self, event, fn, owner)
		local cbs = rawget(self, "_callbacks") or {}
		rawset(self, "_callbacks", cbs)
		cbs[event] = function(...) fn(owner, ...) end
	end,
	Insert = function(self, t) self._text = ((self._text or "")) .. t end,
	SetupMenu = function(self, gen) self._menu = gen end,
	GenerateMenu = function(self)
		if not self._menu then return end
		local root = Stub.MenuRoot()
		self._menu(self, root)
	end,
}

function Stub.MenuRoot()
	local root = {}
	setmetatable(root, { __index = function(_, k)
		return function(_, label, a, b)
			if k == "CreateRadio" and type(a) == "function" then a() end
			return Stub.MenuRoot()
		end
	end })
	return root
end

-- Real widget methods (C side) from the client's API documentation, plus the Lua
-- mixin methods the templates we use provide. Anything else is nil, like in game,
-- so calling a method that doesn't exist fails here too.
local WIDGET = dofile("tools/widget_methods.lua")
local MIXIN = {}
for _, n in ipairs({
	"SetTitle", "SetPortraitToAsset", -- ButtonFrameTemplate
	"SetBackdrop", "SetBackdropColor", "SetBackdropBorderColor", -- BackdropTemplate
	"SetFillToInterior", "SetCustomOnMouseUpHandler", -- LargeSideTabButtonTemplate
	"SetDefaultText", "GetInputText", "GetEditBox", "Insert", "RegisterCallback", -- ScrollingEditBox
	"SetupMenu", "GenerateMenu", "SetScrollMode", -- DropdownButton
	"SetDataProvider", "ForEachFrame", "ScrollToEnd", "HasScrollableExtent", "GetScrollPercentage", -- ScrollBox
	"SetCollapsed", -- ObjectiveTrackerModuleHeaderTemplate
	"SetOwner", "AddLine", "AddDoubleLine", "ClearLines", -- GameTooltip (missing from the generated list)
	"FindElementDataIndex", "GetDataProviderSize", "FindElementData", "FindFrame", "ScrollToElementDataIndex", "ScrollDecrease", "ScrollIncrease",
}) do MIXIN[n] = true end

local FrameMT = {}
FrameMT.__index = function(self, k)
	if type(k) ~= "string" or k:sub(1, 1) == "_" then return nil end
	if GETTERS[k] then return GETTERS[k] end
	if SETTERS[k] then return SETTERS[k] end
	if WIDGET[k] or MIXIN[k] then return noop end
	return nil
end

local TEMPLATE_CHILDREN = {
	ButtonFrameTemplate = { "Inset", "TitleContainer", "CloseButton", "NineSlice" },
	LargeSideTabButtonTemplate = { "Icon", "SelectedTexture" },
	UICheckButtonTemplate = { "Text" },
	ObjectiveTrackerModuleHeaderTemplate = { "Text", "MinimizeButton", "Background" },
}

-- The strip's cell values (0..7) as currently drawn, in order.
function Stub.StripCells()
	local strip = _G.T3CodeLinkStrip
	local out = {}
	if not strip or strip._shown == false then return out end
	for _, f in ipairs(Stub.frames) do
		if f._parent == strip and f._kind == "Texture" and f._shown ~= false and f._color then
			out[#out + 1] = f._color[1] * 4 + f._color[2] * 2 + f._color[3]
		end
	end
	return out
end

function Stub.NewFrame(kind, parent, name, template)
	local f = setmetatable({ _kind = kind, _scripts = {}, _parent = parent, _name = name, _shown = kind ~= "Frame" and nil or nil }, FrameMT)
	-- Frames start shown in WoW unless hidden; track only explicit Show/Hide for OnShow.
	f._shown = nil
	for tmpl in tostring(template or ""):gmatch("[^,%s]+") do
		for _, child in ipairs(TEMPLATE_CHILDREN[tmpl] or {}) do f[child] = Stub.NewFrame("Frame", f) end
	end
	if template == "ButtonFrameTemplate" then
		f.SetTitle = noop
		f.SetPortraitToAsset = noop
	end
	if name then _G[name] = f end
	table.insert(Stub.frames, f)
	return f
end

-- Globals ---------------------------------------------------------------------

_G.CreateFrame = function(kind, name, parent, template) return Stub.NewFrame(kind, parent, name, template) end
_G.UIParent = Stub.NewFrame("Frame", nil, "UIParent")
_G.UIParent._shown = true
_G.WorldFrame = Stub.NewFrame("Frame")
_G.Minimap = Stub.NewFrame("Frame", _G.UIParent, "Minimap")
_G.GetCursorPosition = function() return 400, 300 end
Stub.cvars = { GamePadEmulateShift = "PADLTRIGGER", GamePadEmulateCtrl = "PADRTRIGGER", GamePadEmulateAlt = "none" }
_G.C_CVar = { GetCVar = function(name) return Stub.cvars[name] end }
_G.KEY_ABBR_PADBACK_LTR = "|A:Gamepad_Ltr_View_32:14:14|a"
_G.DEFAULT_CHAT_FRAME = { AddMessage = function(_, msg) table.insert(Stub.printed, msg) end }
_G.UIErrorsFrame = { AddMessage = function(_, msg) table.insert(Stub.printed, "ERR " .. msg) end }
_G.GameTooltip = Stub.NewFrame("GameTooltip")
_G.GetAppropriateTooltip = function() return _G.GameTooltip end
_G.UISpecialFrames = {}
_G.tinsert = table.insert
_G.strtrim = function(s) return (tostring(s or ""):gsub("^%s+", ""):gsub("%s+$", "")) end
_G.strjoin = function(sep, ...) return table.concat({ ... }, sep) end
_G.tostringall = function(...) local t = { ... } for i = 1, select("#", ...) do t[i] = tostring(t[i]) end return unpack(t, 1, select("#", ...)) end
_G.strlenutf8 = function(s) local n = 0 for _ in tostring(s):gmatch("[^\128-\191]") do n = n + 1 end return n end
_G.date = os.date
_G.time = os.time
_G.GetTime = function() return Stub.now or os.clock() end
_G.debugprofilestop = function() return os.clock() * 1000 end
_G.geterrorhandler = function() return function(e) error(e, 2) end end
_G.InCombatLockdown = function() return false end
_G.IsShiftKeyDown = function() return false end
_G.PlaySound = function(id) table.insert(Stub.sounds, id) end
_G.StopSound = noop
_G.ReloadUI = function() Stub.reloaded = true end
_G.GetPhysicalScreenSize = function() return 3840, 2160 end
_G.CreateAtlasMarkup = function(a) return "|A:" .. tostring(a) .. "|a" end
_G.HideUIPanel = noop
_G.NORMAL_FONT_COLOR = { GetRGB = function() return 1, 0.82, 0 end }
_G.HIGHLIGHT_FONT_COLOR = { GetRGB = function() return 1, 1, 1 end }
_G.OBJECTIVE_TRACKER_COLOR = { Header = { r = 0.75, g = 0.61, b = 0 } }
_G.SOUNDKIT = setmetatable({}, { __index = function(_, k) return k end })
_G.ScrollBoxConstants = { RetainScrollPosition = true, DiscardScrollPosition = false, NoScrollInterpolation = true, UpdateImmediately = true }
_G.Enum = setmetatable({}, { __index = function() return setmetatable({}, { __index = function(_, k) return k end }) end })

-- Like Forever: PlaySoundFile always says it will play and returns a handle; only a
-- real (valid) file is actually playing a moment later.
Stub.handles = {}
_G.PlaySoundFile = function(path)
	local valid = Stub.validSounds and Stub.validSounds[path]
	table.insert(Stub.sounds, path)
	local h = #Stub.sounds
	Stub.handles[h] = valid and true or false
	return true, h
end
_G.C_Sound = { IsPlaying = function(h) return Stub.handles[h] or false end }

_G.C_Timer = {
	NewTicker = function(interval, fn) local t = { fn = fn, Cancel = noop } table.insert(Stub.tickers, t) return t end,
	NewTimer = function(_, fn) return { Cancel = noop, fn = fn } end,
	After = function(_, fn) fn() end,
}
_G.C_Texture = { GetAtlasInfo = function(a) return a and a:find("^[%w%-_]+$") and { width = 50, height = 50 } or nil end }
_G.C_VoiceChat = { GetTtsVoices = function() return {} end, SpeakText = noop, StopSpeakingText = noop }
_G.C_TTSSettings = { GetVoiceOptionID = function() return 0 end, GetSpeechRate = function() return 0 end, GetSpeechVolume = function() return 100 end }
local PAD_INDEX = { PAD1 = 0, PAD2 = 1, PAD3 = 2, PAD4 = 3, PADLSHOULDER = 4, PADRSHOULDER = 5, PADLTRIGGER = 6, PADRTRIGGER = 7, PADBACK = 8, PADFORWARD = 9 }
Stub.padHeld = {}
_G.IsKeyDown = function(key) return Stub.padHeld[key] or false end
_G.C_GamePad = {
	GetActiveDeviceID = function() return nil end,
	ButtonBindingToIndex = function(name) return PAD_INDEX[name] end,
	GetDeviceMappedState = function()
		local buttons = {}
		for name, i in pairs(PAD_INDEX) do buttons[i + 1] = Stub.padHeld[name] or false end
		return { name = "Stub Pad", labelStyle = "Letters", buttonCount = 10, axisCount = 0, stickCount = 0, buttons = buttons, axes = {}, sticks = {} }
	end,
}

Stub.slotCount = 600
Stub.loadedSlots = {}
_G.C_AddOns = {
	GetAddOnMetadata = function(_, key) return key == "Version" and "0.3.0" or nil end,
	DoesAddOnExist = function(name)
		local n = tonumber(name:match("T3Code_S(%d+)"))
		return n ~= nil and n <= Stub.slotCount
	end,
	IsAddOnLoaded = function(name) return Stub.loadedSlots[name] or name == "Blizzard_ObjectiveTracker" end,
	LoadAddOn = function(name)
		Stub.loadedSlots[name] = true
		local n = tonumber(name:match("T3Code_S(%d+)"))
		local file = Stub.slotData[n] or Stub.slotData.default
		if file then
			local chunk = assert(loadfile(file))
			chunk()
		end
		Stub.loadCount = (Stub.loadCount or 0) + 1
		return true
	end,
	EnableAddOn = noop,
}

_G.CreateScrollBoxListLinearView = function()
	local view = {}
	function view:SetElementFactory(f) self._factory = f end
	function view:SetElementExtentCalculator(f) self._extent = f end
	function view:SetElementExtent() end
	function view:SetElementInitializer(template, init) self._factory = function(factory) factory(template, init) end end
	function view:SetPanExtent() end
	return view
end
_G.ScrollUtil = { InitScrollBoxListWithScrollBar = function(box, _, view) box._view = view end }
_G.CreateDataProvider = function(items)
	local dp = { _items = items or {} }
	function dp:Insert(x) table.insert(self._items, x) end
	return dp
end
_G.MenuUtil = { CreateContextMenu = function(owner, gen) gen(owner, Stub.MenuRoot()) end }
_G.Settings = {
	RegisterCanvasLayoutCategory = function() return {} end,
	RegisterAddOnCategory = noop,
}
_G.ObjectiveTrackerModuleHeaderMixin = {}
_G.ObjectiveTrackerFrame = Stub.NewFrame("Frame", _G.UIParent, "ObjectiveTrackerFrame")
ObjectiveTrackerFrame._shown, ObjectiveTrackerFrame._w = true, 280
ObjectiveTrackerFrame.Header = Stub.NewFrame("Frame", ObjectiveTrackerFrame)
ObjectiveTrackerFrame.NineSlice = Stub.NewFrame("Frame", ObjectiveTrackerFrame)
ObjectiveTrackerFrame.NineSlice._shown = true
function ObjectiveTrackerFrame:IsCollapsed() return self.isCollapsed end
_G.InputUtil = { IsGamepadUIEnabled = function() return Stub.gamepad or false end }
_G.GamepadMode = { FrameControlsManager = { FrameShown = function() Stub.gamepadShown = true end, FrameHidden = function() Stub.gamepadShown = false end } }
_G.SmartNavigation = { RefreshButtonGroups = noop, SetSmartNavPanelInfoAddedCallback = function(_, f, cb) cb() end, SetScrollFrameForFrame = noop }
_G.SmartNavigation_MarkFrameIgnored = noop
_G.SmartNavigation_MarkScrollFrameMaintainPreviousButtonOnScroll = noop
_G.SlashCmdList = {}
Stub.overrides = {}
_G.ClearOverrideBindings = function() Stub.overrides = {} end
_G.SetOverrideBinding = function(_, _, key, action) Stub.overrides[key] = action end
_G.GetBindingKey = function() return nil end
_G.GetBindingAction = function(key) return Stub.overrides[key] or (key == "CTRL-SHIFT-PADBACK" and "TOGGLEWORLDMAP" or "") end
_G.hooksecurefunc = function(t, name, fn)
	if type(t) == "string" then t, name, fn = _G, t, name end
	local old = t[name]
	t[name] = function(...) local r = { old(...) } fn(...) return unpack(r) end
end
_G.LOG_OUT = "Log Out"
_G.IsMouseButtonDown = function() return false end
_G.debugstack = function() return "" end
_G.GameMenuFrame = { buttons = {}, InitButtons = function(self)
	self.buttons = {}
	table.insert(self.buttons, { GetText = function() return "Log Out" end, layoutIndex = 5 })
end, GetLogoutText = function() return "Log Out" end }
function _G.GameMenuFrame:AddButton(text, cb)
	local b = { text = text, cb = cb, GetText = function() return text end, layoutIndex = 99 }
	table.insert(self.buttons, b)
	return b
end

function Stub.Fire(event, ...)
	for frame in pairs(Stub.events[event] or {}) do
		if frame._scripts.OnEvent then frame._scripts.OnEvent(frame, event, ...) end
	end
end

function Stub.Tick(seconds)
	Stub.now = (Stub.now or 0) + seconds
	for _, f in ipairs(Stub.frames) do
		if f._scripts.OnUpdate then f._scripts.OnUpdate(f, seconds) end
	end
	for _, t in ipairs(Stub.tickers) do t.fn() end
end

return Stub
