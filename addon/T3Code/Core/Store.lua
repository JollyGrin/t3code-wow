-- The latest snapshot from the bridge, plus derived views of it.

local _, ns = ...

local Store = {
	data = { threads = {}, projects = {}, usage = {}, bridge = {} },
	byId = {},
	projectsById = {},
	applied = 0,
	-- Model lists by machine ("" for this one). The bridge sends them only when they
	-- change (we report modelsHash in the hello), so they outlive each snapshot.
	models = {},
	modelsHash = "",
}
ns.Store = Store

local GROUP_OF = {
	working = "working", input = "working", plan = "working",
	open = "open", failed = "open",
	settled = "settled",
}
Store.GROUP_OF = GROUP_OF

function Store:Apply(data)
	data.threads = data.threads or {}
	data.projects = data.projects or {}
	data.usage = data.usage or {}
	data.bridge = data.bridge or {}
	local before = self.byId
	local byId, projectsById = {}, {}
	for _, t in ipairs(data.threads) do byId[t.id] = t end
	for _, p in ipairs(data.projects) do projectsById[p.id] = p end
	self.data, self.byId, self.projectsById = data, byId, projectsById
	self.applied = self.applied + 1
	if type(data.models) == "table" and type(data.models.g) == "table" then
		-- Flattened per machine, in T3's order: { i, s, l, p = provider, r = levels }.
		local models = {}
		for _, g in ipairs(data.models.g) do
			local list = {}
			for _, p in ipairs(type(g.p) == "table" and g.p or {}) do
				for _, m in ipairs(type(p.m) == "table" and p.m or {}) do
					local levels = m.r and g.x and g.x[m.r]
					table.insert(list, { i = p.i, s = m.s, l = m.l, p = p.n or p.i, r = type(levels) == "table" and levels or nil })
				end
			end
			models[g.e or ""] = list
		end
		self.models, self.modelsHash = models, tostring(data.models.h or "")
	end

	if self.applied > 1 then
		for id, t in pairs(byId) do
			local old = before[id]
			if old and old.s ~= t.s then
				ns:Fire("ThreadTransition", t, old.s, t.s)
			elseif not old and (t.s == "working" or t.s == "input") then
				ns:Fire("ThreadTransition", t, nil, t.s)
			end
		end
	end
	ns:Fire("DataChanged")
	if data.view and data.view.id == ns.viewId then ns:Fire("ViewChanged") end
end

function Store:Thread(id)
	return id and self.byId[id]
end

function Store:ProjectName(id)
	local p = id and self.projectsById[id]
	return p and p.name or ""
end

-- Threads grouped for the sidebar, filtered by project.
-- projectFilter: "all", a project id, or "m:<machine>" ("m:local" for this one).
function Store:Groups(projectFilter, query)
	local groups = { working = {}, open = {}, settled = {} }
	local machine = projectFilter and projectFilter:match("^m:(.+)$")
	for _, t in ipairs(self.data.threads) do
		local match
		if machine then
			match = (machine == "local" and not t.env) or t.env == machine
		else
			match = projectFilter == "all" or projectFilter == nil or t.p == projectFilter
		end
		if match and query and query ~= "" then
			match = t.title:lower():find(query, 1, true) or self:ProjectName(t.p):lower():find(query, 1, true)
		end
		if match then
			local g = GROUP_OF[t.s] or "open"
			table.insert(groups[g], t)
		end
	end
	return groups
end

function Store:Active()
	local list = {}
	for _, t in ipairs(self.data.threads) do
		if t.s == "working" or t.s == "input" or t.s == "plan" then table.insert(list, t) end
	end
	return list
end

---------------------------------------------------------------------------
-- Models

-- A model's key: instance and slug joined by a tab, as the bridge writes them.
function Store.ModelKey(instanceId, slug)
	if not instanceId or not slug then return nil end
	return instanceId .. "\t" .. slug
end

function Store.SplitModelKey(key)
	return (key or ""):match("^(.-)\t(.+)$")
end

-- The machine a thread or project id belongs to: the bridge prefixes other
-- machines' ids with their code and "~" ("" for this one).
function Store.EnvOf(id)
	return id and id:match("^([^~]+)~") or ""
end

local function Find(self, env, key)
	if not key then return nil end
	for _, m in ipairs(self.models[env or ""] or {}) do
		if Store.ModelKey(m.i, m.s) == key then return m end
	end
end

function Store:Offers(env, key)
	return Find(self, env, key) ~= nil
end

local DIM = "|cff9d9d9d"

-- "Name · Provider", with the provider dimmed when `dim` is set.
function Store:ModelLabel(env, key, dim)
	local m = Find(self, env, key)
	if not m then return select(2, Store.SplitModelKey(key)) end
	if dim then return m.l .. DIM .. " · " .. m.p .. "|r" end
	return m.l .. " · " .. m.p
end

-- Choices for a model picker on machine `env`, in groups under header rows: the
-- models its latest threads used first (a short reach on a controller), then each
-- provider's models in T3's order. `current` is listed even when it's no longer
-- offered (a legacy model, say). Rows inside a provider group show just the model;
-- the button always shows the provider too.
function Store:ModelOptions(env, current)
	local list = self.models[env or ""]
	if not list or #list == 0 then return nil end
	local options = {}
	local function item(m, group, withProvider)
		local key = Store.ModelKey(m.i, m.s)
		local text = m.l .. DIM .. " · " .. m.p .. "|r"
		table.insert(options, { value = key, label = withProvider and text or m.l, text = text, group = group })
	end
	local recent, seen = {}, {}
	if current and not Find(self, env, current) then
		local slug = select(2, Store.SplitModelKey(current))
		table.insert(recent, { value = current, label = slug, text = slug, group = "Recent" })
	end
	local byRecent = {}
	for _, t in ipairs(self.data.threads) do
		if t.mi and t.m and Store.EnvOf(t.id) == (env or "") then table.insert(byRecent, t) end
	end
	table.sort(byRecent, function(a, b) return (a.st or a.u or 0) > (b.st or b.u or 0) end)
	local recentModels = {}
	for _, t in ipairs(byRecent) do
		if #recentModels >= 4 then break end
		local key = Store.ModelKey(t.mi, t.m)
		local m = Find(self, env, key)
		if m and not seen[key] then
			seen[key] = true
			table.insert(recentModels, m)
		end
	end
	if #recent + #recentModels > 0 then
		table.insert(options, { header = true, label = "Recent" })
		for _, o in ipairs(recent) do table.insert(options, o) end
		for _, m in ipairs(recentModels) do item(m, "Recent", true) end
	end
	local provider
	for _, m in ipairs(list) do
		if m.p ~= provider then
			provider = m.p
			table.insert(options, { header = true, label = provider })
		end
		item(m, provider, false)
	end
	return options
end

-- A model's reasoning levels as picker choices, plus the one T3 uses by default.
-- nil when the model has none.
function Store:EffortOptions(env, key)
	local m = Find(self, env, key)
	local levels = m and m.r
	if not levels or type(levels.o) ~= "table" or #levels.o == 0 then return nil end
	local options = {}
	for _, o in ipairs(levels.o) do table.insert(options, { value = o.i, label = o.l or o.i }) end
	return options, levels.d
end

-- The level the latest active thread on machine `env` used with model `key`, which
-- the bridge carries over when that model is picked without a level (nil: the
-- model's own).
function Store:LastEffort(env, key)
	local best
	for _, t in ipairs(self.data.threads) do
		if Store.EnvOf(t.id) == (env or "") and Store.ModelKey(t.mi, t.m) == key
			and (not best or (t.st or t.u or 0) > (best.st or best.u or 0)) then
			best = t
		end
	end
	return best and best.re
end

function Store.HasOption(options, value)
	for _, o in ipairs(options or {}) do
		if not o.header and o.value == value then return true end
	end
	return false
end

function Store:View()
	local v = self.data.view
	if v and v.id == ns.viewId then return v end
end

---------------------------------------------------------------------------
-- Status words and colors

local STATUS_TEXT = {
	working = "Working", input = "Waiting", plan = "Plan ready",
	open = "Finished", failed = "Failed", settled = "Settled",
}
local STATUS_COLOR = {
	working = "blue", input = "orange", plan = "orange",
	open = "white", failed = "red", settled = "grey",
}

function Store.StatusText(s)
	return STATUS_TEXT[s] or s or ""
end

function Store.StatusColor(s)
	return STATUS_COLOR[s] or "white"
end

---------------------------------------------------------------------------
-- Speech: the game's own voices when it has any, otherwise the desktop's.

function ns.StripMarkup(text)
	text = tostring(text or "")
	text = text:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", ""):gsub("||", "|")
	return text
end

local function GameVoices()
	if not C_VoiceChat or not C_VoiceChat.GetTtsVoices then return nil end
	local ok, voices = pcall(C_VoiceChat.GetTtsVoices)
	return ok and voices and #voices > 0 and voices or nil
end

function ns.SpeechEngine()
	local pref = ns.db and ns.db.settings.tts or "auto"
	if pref == "off" then return "off" end
	if pref == "game" then return GameVoices() and "game" or "off" end
	if pref == "system" then return "system" end
	-- auto: the desktop voice when the bridge has one (Wine rarely has game voices).
	if Store.data.bridge and Store.data.bridge.tts then return "system" end
	if GameVoices() then return "game" end
	return "off"
end

function ns.Speak(text, threadId, messageIndex)
	local engine = ns.SpeechEngine()
	if engine == "system" then
		if threadId and threadId ~= "" then
			ns.Transport:Send("speak", threadId, messageIndex or "last")
		else
			ns.Transport:Send("say", ns.StripMarkup(text):sub(1, 1200))
		end
		return true
	elseif engine == "game" then
		local voices = GameVoices()
		local voice = voices and voices[1].voiceID or 0
		if C_TTSSettings and C_TTSSettings.GetVoiceOptionID and Enum.TtsVoiceType then
			voice = C_TTSSettings.GetVoiceOptionID(Enum.TtsVoiceType.Standard) or voice
		end
		local rate = C_TTSSettings and C_TTSSettings.GetSpeechRate and C_TTSSettings.GetSpeechRate() or 0
		local volume = C_TTSSettings and C_TTSSettings.GetSpeechVolume and C_TTSSettings.GetSpeechVolume() or 100
		C_VoiceChat.StopSpeakingText()
		C_VoiceChat.SpeakText(voice, ns.StripMarkup(text):sub(1, 2000), rate, volume, false)
		return true
	end
	ns.Print("No text-to-speech voice is available. Pick one in T3 Code settings.")
	return false
end

function ns.Hush()
	if ns.SpeechEngine() == "game" then
		C_VoiceChat.StopSpeakingText()
	else
		ns.Transport:Send("hush")
	end
end
