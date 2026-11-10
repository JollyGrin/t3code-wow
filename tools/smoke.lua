-- Headless smoke test: load the addon against tools/wowstub.lua and drive it.
--   lua5.1 tools/smoke.lua <addon dir> <snapshot.lua> [viewId]
local addonDir, snapshot, viewId = arg[1], arg[2], arg[3]
package.path = "./tools/?.lua;" .. package.path
local Stub = dofile("tools/wowstub.lua")
Stub.slotData.default = snapshot

local function check(cond, msg)
	if not cond then for _, e in ipairs(T3Code and T3Code.errors or {}) do print("RECORDED ERROR: " .. e.msg) end error("CHECK FAILED: " .. msg, 2) end
	print("ok - " .. msg)
end

-- Load files in TOC order.
local ns = {}
for line in io.lines(addonDir .. "/T3Code.toc") do
	line = line:gsub("\r", "")
	if line ~= "" and not line:match("^#") and line:match("%.lua$") then
		local path = addonDir .. "/" .. line:gsub("\\", "/")
		local chunk = assert(loadfile(path))
		chunk("T3Code", ns)
	end
end
check(T3Code == ns, "namespace exported")

Stub.Fire("ADDON_LOADED", "T3Code")
check(ns.db and ns.db.session and #ns.db.session == 8, "saved variables initialised")
Stub.Fire("PLAYER_LOGIN")
check(ns.Transport.slotCount == 600, "found 600 slots by binary search")
check(ns.Store.applied == 1, "bootstrap slot applied")
check(#ns.Store.data.threads > 0, "threads loaded: " .. #ns.Store.data.threads)
check(ns.Transport.stripShown, "hello strip shown")
check(ns.Transport:Encrypted(), "link keys loaded from the bootstrap slot")
check(T3Code_Inbox == nil, "slot global cleared after loading")
do
	local drawn = WOWSTUB.StripCells()
	-- Header byte 3 (version) spans cells 6..8: bits 16..23 of the frame.
	local bits = {}
	for i = 1, 9 do local v = drawn[i] bits[#bits + 1] = math.floor(v / 4) % 2 bits[#bits + 1] = math.floor(v / 2) % 2 bits[#bits + 1] = v % 2 end
	local version = 0
	for i = 17, 24 do version = version * 2 + bits[i] end
	check(version == 2, "strip is drawn encrypted (frame version 2)")
end
local payload = ns.Transport:Payload()
check(payload:sub(1, 2) == "H\031", "payload starts with hello record")

-- Strip encodes within capacity and the cells are valid.
local cells = ns.Codec.Encode(ns.Transport.stripSeq, payload)
check(#cells > 0, "strip cells: " .. #cells)

-- Simulate the bridge acknowledging the hello via the next slot.
Stub.validSounds = {}
ns.Transport.signals = "ok"
local sig = ns.db.sigNext
-- Patch the snapshot's ack to this UI session.
local chunk = assert(loadfile(snapshot))
chunk()
local data = T3Code_Inbox
T3Code_Inbox = nil
data.ack = { ui = ns.ui, seq = ns.Transport.stripSeq }
data.gen = data.gen + 1
data.nextSig = sig + 1
ns.Transport:Apply(data)
check(not ns.Transport.stripShown, "strip hidden after ack")

-- Open the window, select a thread, render.
ns.Main:Open()
check(ns.windowOpen, "window open")
check(ns.Transport.stripShown, "window open bumps the strip")
local firstThread = ns.Store.data.threads[1]
ns.Main:SelectThread(viewId ~= "" and viewId or firstThread.id)
check(ns.viewId ~= nil, "thread selected")
ns.Store:Apply(data) -- view arrives
local rows = ns.Transcript.scrollBox._rows or {}
check(#rows > 0, "transcript rendered " .. #rows .. " elements")
local listRows = ns.ThreadList.scrollBox._rows or {}
check(#listRows > 0, "thread list rendered " .. #listRows .. " rows")

-- Send a message: queued, echoed, and present in the strip payload.
ns.Main.composer._text = "Please run the tests"
ns.Main:Send()
check(#ns.Transport.queue >= 1, "command queued")
check(ns.Transport:Payload():find("Please run the tests", 1, true) ~= nil, "message in strip payload")
check(ns.Transport.queue[#ns.Transport.queue].args[3] == "steer", "follow-ups ask to steer by default")
ns.db.settings.steerFollowUps = false
ns.Main:Send("And the linter")
check(ns.Transport.queue[#ns.Transport.queue].args[3] == nil, "with steering off, a follow-up names no mode, so the bridge queues it")
ns.db.settings.steerFollowUps = true
check(ns.Transcript.echo[ns.viewId] ~= nil, "local echo shown")

-- Pages
ns.Main:ShowPage("usage")
ns.Main:ShowPage("settings")
ns.Main:ShowPage("threads")
check(true, "pages switch")

-- New thread flow
ns.Main:StartNewThread()
check(ns.Main.mode == "new" and ns.Main.newProject ~= nil, "new thread mode with project " .. tostring(ns.Main.newProject))
local hdr = ns.Main.frame.Pages.threads.Right.Header
check(ns.Transport:Payload():find(ns.Store.modelsHash, 1, true) ~= nil and ns.Store.modelsHash ~= "", "hello reports the model list it has: " .. ns.Store.modelsHash)
local function Choices(dd)
	local list = {}
	for _, o in ipairs(dd.options) do if not o.header then table.insert(list, o) end end
	return list
end
local groups = {}
for _, o in ipairs(hdr.Model.options) do if o.header then table.insert(groups, o.label) end end
check(hdr.Model:IsShown() and #Choices(hdr.Model) >= 1, "model picker shown for a new thread: " .. #Choices(hdr.Model) .. " models")
check(hdr.Model.options[1].header and #groups >= 2, "models grouped under headers: " .. table.concat(groups, ", "))
check(hdr.Model.Text:GetText():find(" · ", 1, true) ~= nil, "the button names the provider: " .. hdr.Model.Text:GetText())
do
	-- A search for a provider keeps its header and its models; headers aren't choices.
	local provider = groups[#groups]
	ns.UI.OpenList(hdr.Model)
	local l = ns.UI.ListOpen()
	l.Search:SetText(provider:lower())
	ns.UI.RefreshList()
	local at, others
	for n, o in ipairs(l.filtered) do
		if o.header and o.label == provider then at = n end
		-- Another provider's model may match on its own name ("GPT-5 Codex" under OpenCode, say).
		if not o.header and o.group ~= provider and o.group ~= "Recent" and not o.label:lower():find(provider:lower(), 1, true) then others = true end
	end
	check(at and l.filtered[at + 1] and not l.filtered[at + 1].header and not others, "searching a provider's name lists its models under its header")
	l:Hide()
end
do
	local seq = ns.Transport.stripSeq
	ns.Transport:Apply({ gen = data.gen + 1, threads = data.threads, projects = data.projects, bridge = data.bridge, usage = data.usage, models = { h = "00000000", g = {} } })
	check(ns.Transport.stripSeq ~= seq and ns.Transport:Payload():find("00000000", 1, true) ~= nil, "a new model list is announced straight away")
	check(ns.Store:ModelOptions("", nil) == nil, "an empty list clears the models")
	check(not hdr.Model:IsShown() and not hdr.Effort:IsShown(), "no models: neither picker is left on screen")
	data.gen = data.gen + 1
	ns.Transport:Apply({ gen = data.gen + 1, threads = data.threads, projects = data.projects, bridge = data.bridge, usage = data.usage, models = data.models })
	data.gen = data.gen + 1
	check(hdr.Model:IsShown(), "the list comes back")
end
check(ns.Main:ChosenNewModel() == nil and ns.Main:NewThreadModel() ~= nil, "no pick yet: the picker shows T3's default but sends none")
-- Pick the last model that has reasoning levels (any model when none has).
local pick
for _, o in ipairs(Choices(hdr.Model)) do
	if not pick or ns.Store:EffortOptions("", o.value) then pick = o end
end
ns.Main:PickModel(pick.value)
check(ns.db.models[ns.Main.newProject] == pick.value and ns.Main:NewThreadModel() == pick.value, "picked model remembered for the project: " .. pick.label)
local level
if hdr.Effort:IsShown() then
	local levels, default = ns.Store:EffortOptions("", pick.value)
	for _, o in ipairs(levels) do if o.value ~= default then level = o.value end end
	local proj = ns.Store.projectsById[ns.Main.newProject]
	local inherited = (proj.dm == pick.value and proj.de) or ns.Store:LastEffort("", pick.value) or default
	check(ns.Main:ChosenNewEffort() == nil and hdr.Effort.value == inherited, "no level picked: the picker shows the level the thread would get: " .. inherited)
	ns.Main:PickEffort(level)
	check(ns.db.efforts[ns.Main.newProject] == level and hdr.Effort.value == level, "picked level remembered for the project: " .. level)
else
	check(false, "the reasoning picker shows for " .. pick.label)
end
ns.Main.composer._text = "Build a thing"
ns.Main:Send()
check(ns.Transport:Payload():find("\031new\031", 1, true) ~= nil, "new-thread command in payload")
local pickI, pickS = ns.Store.SplitModelKey(pick.value)
check(ns.Transport:Payload():find("Build a thing\031" .. pickI .. "\031" .. pickS .. (level and ("\031" .. level) or ""), 1, true) ~= nil, "picked model and level ride along with the new thread")
ns.Transport:Apply({ gen = data.gen + 2, results = { { id = ns.Main.pendingNew, ok = true, open = firstThread.id } }, threads = data.threads, projects = data.projects, bridge = data.bridge, usage = data.usage, ack = { ui = ns.ui, seq = ns.Transport.stripSeq } })
check(ns.Main.mode == "thread" and ns.viewId == firstThread.id, "result opened the new thread")
check(#ns.Transport.queue == 0, "all commands acknowledged")
check(hdr.Model:IsShown(), "model picker shown for an open thread")
local cur = ns.Main:ThreadModel(ns.Store:Thread(ns.viewId))
local other
for _, o in ipairs(Choices(hdr.Model)) do if o.value ~= cur then other = o break end end
if other then
	ns.Main:PickModel(other.value)
	local oi, os_ = ns.Store.SplitModelKey(other.value)
	check(ns.Transport:Payload():find("\031model\031" .. ns.viewId .. "\031" .. oi .. "\031" .. os_, 1, true) ~= nil, "switching a thread's model sends model")
	check(hdr.Model.value == other.value, "the picker shows the new model straight away")
	ns.Transport:Apply({ gen = data.gen + 3, results = { { id = ns.Main.pendingModel.cmd, ok = false, msg = "Codex is switched off in T3 Code. Pick another model." } }, threads = data.threads, projects = data.projects, bridge = data.bridge, usage = data.usage, ack = { ui = ns.ui, seq = ns.Transport.stripSeq } })
	check(ns.Main.pendingModel == nil and hdr.Model.value == cur, "a refused switch puts the picker back")
end
do
	local t = ns.Store:Thread(ns.viewId)
	local levels = ns.Store:EffortOptions(ns.Store.EnvOf(t.id), ns.Store.ModelKey(t.mi, t.m))
	check(hdr.Effort:IsShown() == (levels ~= nil), "the reasoning picker shows when the thread's model has levels")
	if levels then
		local next
		for _, o in ipairs(levels) do if o.value ~= hdr.Effort.value then next = o.value break end end
		ns.Main:PickEffort(next)
		check(ns.Transport:Payload():find("\031model\031" .. ns.viewId .. "\031" .. t.mi .. "\031" .. t.m .. "\031" .. next, 1, true) ~= nil, "changing a thread's level sends model with it")
		check(hdr.Effort.value == next, "the picker shows the new level straight away")
		ns.Transport:Apply({ gen = data.gen + 4, results = { { id = ns.Main.pendingEffort.cmd, ok = false, msg = "That level is gone." } }, threads = data.threads, projects = data.projects, bridge = data.bridge, usage = data.usage, ack = { ui = ns.ui, seq = ns.Transport.stripSeq } })
		check(ns.Main.pendingEffort == nil and hdr.Effort.value ~= next, "a refused level puts the picker back")
	end
end

-- Question / approval rendering
data.gen = data.gen + 10
data.view = data.view or { id = ns.viewId }
data.view.id = ns.viewId
data.view.pending = { id = "req1", kind = "question", questions = { { id = "q1", h = "Mode", q = "Which mode?", opts = { { l = "Fast", d = "quick", v = "fast" }, { l = "Careful", d = "slow", v = "careful" } } } } }
ns.Transport:Apply(data)
local optionRows = 0
for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.ed.kind == "option" then optionRows = optionRows + 1 end end
check(optionRows >= 2, "question options rendered: " .. optionRows)
for _, r in ipairs(ns.Transcript.scrollBox._rows) do
	if r.ed.kind == "option" and r.ed.label == "Fast" then r.frame:Click() break end
end
check(ns.Transport:Payload():find("answer\031" .. ns.viewId .. "\031req1\031q1\031fast", 1, true) ~= nil, "answer command queued")

-- Dictation result from the bridge lands in the message box
ns.Main.composer._text = "Hello"
data.gen = data.gen + 1
data.dict = { n = os.time() * 1000, state = "done", text = "run the tests" }
ns.Transport:Apply(data)
check(ns.Main.composer._text == "Hello run the tests", "dictated text typed into the box: " .. tostring(ns.Main.composer._text))
data.gen = data.gen + 1
ns.Transport:Apply(data)
check(ns.Main.composer._text == "Hello run the tests", "same dictation not typed twice")
ns.Main.composer._text = "already pasted words"
data.gen = data.gen + 1
data.dict = { n = os.time() * 1000 + 5, state = "done", text = "pasted words" }
ns.Transport:Apply(data)
check(ns.Main.composer._text == "already pasted words", "text the backend already pasted isn't added again")
ns.Main.composer._text = ""

-- A desktop with no dictation backend (macOS today): the mic says why and sends nothing.
data.bridge.dictation = nil
data.bridge.dictationHint = "Dictation isn't available on macOS yet."
data.gen = data.gen + 1
ns.Transport:Apply(data)
Stub.printed = {}
local queued = #ns.Transport.queue
ns.Main.dictating = false
ns.Main.dictNoteAt = nil
ns.Main:ToggleDictation()
check(not ns.Main.dictating and #ns.Transport.queue == queued, "no dictation backend: nothing is sent")
check(Stub.printed[1] and Stub.printed[1]:find("macOS", 1, true) ~= nil, "the mic explains why: " .. tostring(Stub.printed[1]))
ns.Main:ToggleDictation()
check(#Stub.printed == 1, "a repeated press doesn't repeat the note")
ns.Main:Open()
ns.Main:Refresh()
check(not ns.Main.frame.Bar.Mic:IsEnabled(), "the mic is dimmed while there is no backend")
data.bridge.dictation = "test backend"
data.bridge.dictationHint = nil
data.gen = data.gen + 1
ns.Transport:Apply(data)
ns.Main:Refresh()
check(ns.Main.frame.Bar.Mic:IsEnabled(), "the mic is ready again once a backend is reported")

-- A refused dictate command doesn't leave the mic stuck on.
ns.Main.dictating = false
ns.Main:ToggleDictation()
check(ns.Main.dictating, "dictation starts when a backend is reported")
data.gen = data.gen + 1
ns.Transport:Apply({ gen = data.gen, results = { { id = ns.Main.dictCmd, ok = false, msg = "no microphone" } }, threads = data.threads, projects = data.projects, bridge = data.bridge, usage = data.usage, ack = { ui = ns.ui, seq = ns.Transport.stripSeq } })
check(not ns.Main.dictating, "a refused dictate command puts the mic back")

-- Plan, approval details, run summary, queued note
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == ns.viewId then th.s = "plan" end end
data.view = data.view or {}
data.view.id = ns.viewId
data.view.pending = nil
data.view.plan = "|cffffd100Plan|r\n• step one"
data.view.sum = "Last run: 2 commands · 4m 12s"
data.view.queued = 1
ns.Transport:Apply(data)
local found = {}
for _, r in ipairs(ns.Transcript.scrollBox._rows) do
	if r.ed.text then
		if r.ed.text:find("step one", 1, true) then found.plan = true end
		if r.ed.text:find("Last run", 1, true) then found.sum = true end
		if r.ed.text:find("queued", 1, true) then found.queued = true end
	end
	if r.ed.label == "Read the plan aloud" then found.readPlan = true end
end
check(found.plan and found.readPlan, "plan text shown with a read-aloud option")
check(found.sum and found.queued, "run summary and queued follow-ups shown")
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == ns.viewId then th.s = "input" end end
data.view.plan, data.view.queued = nil, nil
data.view.pending = { id = "ap1", kind = "approval", what = "Change files", detail = "", files = { { f = "a.lua", a = 12, d = 3 } }, always = true }
ns.Transport:Apply(data)
found = {}
for _, r in ipairs(ns.Transcript.scrollBox._rows) do
	if r.ed.text and r.ed.text:find("a.lua", 1, true) and r.ed.text:find("+12", 1, true) then found.files = true end
	if r.ed.label == "Always allow this" then found.always = r end
end
check(found.files, "approval lists the files with +/- counts")
found.always.frame:Click()
check(ns.Transport:Payload():find("approve\031" .. ns.viewId .. "\031ap1\031acceptAlways", 1, true) ~= nil, "Always allow sends acceptAlways")
data.gen = data.gen + 1
data.view.pending = nil
for _, th in ipairs(data.threads) do if th.id == ns.viewId then th.s = "open" end end
ns.Transport:Apply(data)

-- Notices wait during combat
_G.InCombatLockdown = function() return true end
local t1 = ns.Store.data.threads[2]
ns.Toasts.held = {}
ns:Fire("ThreadTransition", t1, "working", "open")
check(#ns.Toasts.held == 1, "notice held during combat")
_G.InCombatLockdown = function() return false end
ns:Fire("Combat", false)
check(#ns.Toasts.held == 0, "held notice shown after combat")

-- Search and machine filter
ns.ThreadList.query = "zzzz-no-match"
ns.ThreadList:Refresh(true)
local threadRows = 0
for _, r in ipairs(ns.ThreadList.scrollBox._rows) do if r.ed.thread then threadRows = threadRows + 1 end end
check(threadRows == 0, "search hides non-matching threads")
ns.ThreadList.query = nil
local groups = ns.Store:Groups("m:local")
check(#groups.working + #groups.open + #groups.settled > 0, "machine filter (this computer) keeps local threads")
groups = ns.Store:Groups("m:foundry")
check(#groups.working + #groups.open + #groups.settled == 0, "machine filter (foundry) excludes local threads")
ns.ThreadList:Refresh(true)

-- Report: diagnostics in the box + a screenshot request
ns.Main.composer._text = ""
ns.Main:Report("the list flickers")
check(ns.Main.composer._text:find("the list flickers", 1, true) and ns.Main.composer._text:find("diagnostics", 1, true), "report fills the message box")
check(ns.Transport:Payload():find("\031shot\031", 1, true) ~= nil, "report asks the bridge for a screenshot")
ns.Main.composer._text = ""

-- Attending flag: set while the window is in use, cleared after 90s idle
ns.Main:Open()
ns.Interacted()
Stub.Tick(0.1)
check(ns.Transport:Flags():find("a", 1, true) ~= nil, "attending while using the window")
Stub.now = Stub.now + 100
Stub.Tick(0.1)
check(ns.Transport:Flags():find("a", 1, true) == nil, "not attending after 90s idle")

-- Self-test runs
ns.SelfTest()
check(true, "self-test ran")

-- Window size
ns.db.settings.windowScale = "xlarge"
ns.Main:ApplyScale()
check(true, "window scale applied")
ns.db.settings.windowScale = "auto"

-- Transitions -> toast
local t = ns.Store.data.threads[1]
local before = t.s
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == t.id then th.s = "working" end end
ns.Transport:Apply(data)
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == t.id then th.s = "open" th.un = true end end
ns.Transport:Apply(data)
local toastShown = ns.Toasts.frames[1] and ns.Toasts.frames[1]._shown
check(toastShown or (ns.windowOpen and ns.viewId == t.id), "finish transition produced a toast")

-- Tracker and tickers run
ns.Tracker:Refresh()
for _ = 1, 5 do Stub.Tick(1) end
check(true, "tickers ran")

-- Gamepad mode: the window captures the controller itself.
Stub.gamepad = true
ns.Main.frame:Hide()
ns.Main:Open()
local f = ns.Main.frame
check(ns.Gamepad.capturing, "window captures the controller in gamepad mode")
local down = f._scripts.OnGamePadButtonDown
check(down ~= nil and f._scripts.OnGamePadStick ~= nil, "button and stick handlers installed")
ns.Gamepad:SelectDefault()
check(ns.Gamepad.selected ~= nil, "cursor starts on a control")
check(down(f, "PADDDOWN") == false, "D-pad consumed (character doesn't move)")
check(f._scripts.OnGamePadStick(f, "Left", 0, -1) == false, "left stick consumed")
check(down(f, "PADFORWARD") == false and f._shown == false and not ns.Gamepad.capturing, "Start closes the window and gives the controller back")
ns.Main:Open()
check(ns.Gamepad.capturing, "reopened window takes the controller again")
-- The model picker sits on the header row: D-pad to it, A opens its list, B closes it.
do
	local prevView = ns.viewId
	ns.Main:StartNewThread()
	ns.Gamepad:Highlight(hdr.Project)
	down(f, "PADDRIGHT")
	check(ns.Gamepad.selected == hdr.Model, "Right from the project goes to the model picker")
	down(f, "PAD1")
	local l = ns.UI.ListOpen()
	check(l ~= nil and l.owner == hdr.Model, "A opens the model list")
	local rows, onHeader = 0, false
	for _, c in ipairs(ns.Gamepad:Candidates()) do
		rows = rows + 1
		if c.ed and c.ed.header then onHeader = true end
	end
	check(rows > 0 and not onHeader, "the D-pad skips group headers in the list: " .. rows .. " rows")
	down(f, "PAD2")
	check(ns.UI.ListOpen() == nil and f._shown, "B closes the model list, not the window")
	if hdr.Effort:IsShown() then
		down(f, "PADDRIGHT")
		check(ns.Gamepad.selected == hdr.Effort, "Right from the model goes to the reasoning picker")
		down(f, "PAD1")
		local open = ns.UI.ListOpen()
		check(open ~= nil and open.owner == hdr.Effort, "A opens the reasoning list")
		down(f, "PAD2")
		down(f, "PADDLEFT")
		check(ns.Gamepad.selected == hdr.Model, "Left from the reasoning picker goes back to the model")
	end
	down(f, "PADDLEFT")
	check(ns.Gamepad.selected == hdr.Project, "Left goes back to the project")
	ns.Main:SelectThread(prevView)
end
check(down(f, "PADRSHOULDER") == false and ns.Main.page == "usage", "RB switched to usage")
down(f, "PADLSHOULDER")
check(ns.Main.page == "threads", "LB switched back")
down(f, "PAD4")
check(ns.Main.dictating, "Y starts dictation")
f._scripts.OnGamePadButtonUp(f, "PAD4")
check(not ns.Main.dictating, "Y release stops dictation")
-- A on a thread row opens it
for _, r in ipairs(ns.ThreadList.scrollBox._rows) do
	if r.ed.thread then ns.Gamepad:Highlight(r.frame) break end
end
ns.viewId = nil
down(f, "PAD1")
check(ns.viewId ~= nil, "A opened the highlighted thread")
-- D-pad routes between the list, the conversation and the message box
local function rowFor(id)
	for _, r in ipairs(ns.ThreadList.scrollBox._rows) do if r.ed.thread and r.ed.thread.id == id then return r.frame end end
end
data.gen = data.gen + 1
data.view = data.view or {}
data.view.id = ns.viewId
data.view.pending = nil
ns.Transport:Apply(data)
ns.Gamepad:Highlight(rowFor(ns.viewId) or ns.ThreadList.scrollBox._rows[2].frame)
down(f, "PADDRIGHT")
check(ns.Gamepad.selected == ns.Main.composer, "Right from the list goes to the message box")
down(f, "PADDDOWN")
check(ns.Gamepad.selected == f.Bar.Send, "Down from the message box goes to Send")
down(f, "PADDUP")
check(ns.Gamepad.selected == ns.Main.composer, "Up from Send goes back to the message box")
down(f, "PADDLEFT")
local sel = ns.Gamepad.selected
local onRow = false
for _, r in ipairs(ns.ThreadList.scrollBox._rows) do if r.frame == sel and r.ed.thread and r.ed.thread.id == ns.viewId then onRow = true end end
check(onRow, "Left from the conversation returns to the open thread's row")
data.gen = data.gen + 1
data.view.pending = { id = "req2", kind = "question", questions = { { id = "q", h = "Pick", q = "Which?", opts = { { l = "One", d = "", v = "1" }, { l = "Two", d = "", v = "2" } } } } }
ns.Transport:Apply(data)
down(f, "PADDRIGHT")
local selEd
for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.frame == ns.Gamepad.selected then selEd = r.ed end end
check(selEd and selEd.kind == "option" and selEd.label == "One", "Right goes straight to the first answer when the agent is asking")
down(f, "PADDDOWN")
for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.frame == ns.Gamepad.selected then selEd = r.ed end end
check(selEd and selEd.label == "Two", "Down steps to the next answer")
data.gen = data.gen + 1
data.view.pending = nil
ns.Transport:Apply(data)
-- A on the project dropdown opens a real list; the cursor moves inside it
ns.Gamepad:Highlight(ns.ThreadList.dropdown)
down(f, "PAD1")
local listFrame = ns.UI.ListOpen()
check(listFrame ~= nil, "A opens the project list")
local rows = listFrame.Box._rows or {}
check(#rows >= 2, "list shows the projects: " .. #rows)
local cands = ns.Gamepad:Candidates()
check(#cands == #rows, "cursor is confined to the list rows")
ns.Gamepad:SelectDefault()
check(ns.Gamepad.selected and ns.Gamepad.selected == rows[1].frame, "cursor starts on the current choice (All projects)")
ns.Gamepad:Highlight(rows[2].frame)
down(f, "PAD1")
check(ns.UI.ListOpen() == nil, "picking closes the list")
check(ns.db.settings.project == rows[2].ed.value, "picked project applied: " .. ns.db.settings.project)
ns.Gamepad:Highlight(ns.ThreadList.dropdown)
down(f, "PAD1")
down(f, "PAD2")
check(ns.UI.ListOpen() == nil and f._shown, "B closes the list, not the window")
ns.db.settings.project = "all"
-- Mouse: click opens, clicking a row picks
ns.ThreadList.dropdown._scripts.OnClick(ns.ThreadList.dropdown, "LeftButton")
check(ns.UI.ListOpen() ~= nil, "click opens the list")
ns.UI.ListOpen().Box._rows[2].frame:Click()
check(ns.db.settings.project ~= "all", "click on a row picks it")
ns.db.settings.project = "all"
-- B leaves the composer, then closes
ns.Main.composer._focus = true
down(f, "PAD2")
check(not ns.Main.composer._focus, "B leaves the message box")
down(f, "PAD2")
check(not f._shown, "B closes the window")
check(not ns.Gamepad.capturing, "controller released on close")

-- Launching without a keyboard
check(ns.Launcher.chord == "PADLTRIGGER-PADRTRIGGER-PADBACK", "controller shortcut: both triggers + Back")
check(next(Stub.overrides) == nil, "no key bindings overridden (Forever's controller mode ignores them)")
GameMenuFrame:InitButtons()
local entry
for _, b in ipairs(GameMenuFrame.buttons) do if b.text == "T3 Code" then entry = b end end
check(entry and entry.layoutIndex == 4.5, "game menu entry sits above Log Out")
_G.HideUIPanel = function() end
entry.cb()
check(f._shown, "game menu entry opens the window")
T3Code_Binding("toggle")
check(not f._shown, "shortcut toggles it closed")
check(#(ns.db.errors or {}) == 0, "no errors recorded")

-- Slash command
SlashCmdList.T3CODE("status")
check(#Stub.printed > 0, "status printed: " .. Stub.printed[#Stub.printed])

-- Self-test: the long control plays, the empty one doesn't -> bells usable
Stub.validSounds = { ["Interface\\AddOns\\T3Code\\Signals\\03999.wav"] = true }
ns.Transport.signals = "untested"
ns.Transport.testing = nil
ns.Transport:SelfTest()
check(ns.Transport.signals == "ok", "self-test passes when the long control plays: " .. ns.Transport.signals)
Stub.validSounds = {}
ns.Transport.testing = nil
ns.Transport:SelfTest()
check(ns.Transport.signals == "muted", "self-test fails when nothing really plays (Forever says willPlay=true anyway)")
ns.Transport.signals = "ok"

-- A bell rung a couple of numbers ahead is still heard; bells map onto 8 rotating
-- files. Only a fresh snapshot moves the bell position (to the bridge's nextSig).
local function BellPath(k) return string.format("Interface\\AddOns\\T3Code\\Signals\\%05d.wav", 3991 + (k - 1) % 8) end
local freshFile = os.tmpname()
do
	local fh = assert(io.open(freshFile, "w"))
	fh:write(string.format("dofile(%q) T3Code_Inbox.gen = 9e15 T3Code_Inbox.nextSig = 503\n", snapshot))
	fh:close()
end
ns.Transport.exhausted = nil
ns.Transport.bellProbe = nil
ns.Transport.ringCooldownUntil = nil
ns.db.sigNext = 500
Stub.slotData[ns.Transport.slotCursor] = freshFile
Stub.validSounds = { [BellPath(502)] = true }
local loadsBefore = Stub.loadCount or 0
Stub.Tick(0.6) -- starts listening
Stub.Tick(0.2) -- checks which bell is really playing
check((Stub.loadCount or 0) > loadsBefore, "loaded a slot when bell 502 rang")
check(ns.db.sigNext == 503, "took the bridge's next bell from the fresh snapshot: " .. ns.db.sigNext)

-- A bell that leads to old data is a false alarm: no moving ahead (which would
-- alias still-rung bells and run away), a short cooldown, and a fresh strip.
Stub.validSounds = { [BellPath(504)] = true }
local loads1 = Stub.loadCount
ns.Transport.bellProbe = nil
Stub.Tick(0.6)
Stub.Tick(0.2)
check(Stub.loadCount == loads1 + 1 and ns.db.sigNext == 503, "false ring: one slot loaded, position kept at " .. ns.db.sigNext)
check(ns.Transport.falseRings == 1 and ns.Transport.stripShown, "false ring counted and the strip redrawn")
Stub.Tick(0.6)
Stub.Tick(0.2)
check(Stub.loadCount == loads1 + 1, "cooldown: no slot burned by the same false alarm")

-- A laggy client: even the empty control still "plays" at check time. Wait it out
-- instead of trusting the bells.
Stub.now = Stub.now + 5
ns.Transport:HideStrip() -- (as if the bridge acknowledged it; isolates the bell check)
ns.Transport.lastLoadAt = Stub.now
ns.Transport.bellProbe = nil
Stub.validSounds = { [BellPath(503)] = true, ["Interface\\AddOns\\T3Code\\Signals\\04000.wav"] = true }
local loads2 = Stub.loadCount
for _ = 1, 12 do Stub.Tick(0.2) end
check(Stub.loadCount == loads2, "no slot loaded while the client is too slow to tell bells apart")
Stub.validSounds = {}
ns.Transport.bellProbe = nil
local loads3 = Stub.loadCount
Stub.Tick(0.6)
Stub.Tick(0.2)
check(Stub.loadCount == loads3, "no slot spent while no bell rings")
os.remove(freshFile)

-- Controller shortcut: hold both triggers, press Back. Read from the controller's
-- state only: the watcher must never take gamepad input (that breaks LT + RT action bars).
do
	local L = ns.Launcher
	L:SetupChord()
	check(L.chordText and L.chordText:find("Left trigger", 1, true) and L.chordText:find("Gamepad_Ltr_View", 1, true), "shortcut shown as the player's buttons: " .. tostring(L.chordText))
	check(not L.chordText:find("RT", 1, true), "no hard-coded Xbox names")
	local w = L.watcher
	check(w._scripts.OnGamePadButtonDown == nil and not w._gamepadEnabled, "the watcher never takes controller input")
	local function frame() w._scripts.OnUpdate(w, 0.016) end
	local wasOpen = ns.windowOpen
	WOWSTUB.padHeld = { PADLTRIGGER = true, PADRTRIGGER = true }
	frame()
	check(ns.windowOpen == wasOpen, "holding the triggers alone does nothing (LT + RT action bars stay the game's)")
	WOWSTUB.padHeld.PADBACK = true
	frame()
	check(ns.windowOpen ~= wasOpen, "triggers + Back toggles T3 Code")
	frame()
	frame()
	check(ns.windowOpen ~= wasOpen, "holding Back doesn't toggle it again")
	WOWSTUB.padHeld = { PADBACK = true }
	if ns.windowOpen ~= wasOpen then ns.Launcher:Open() end
	frame()
	WOWSTUB.padHeld = {}
	frame()
	WOWSTUB.padHeld = { PADBACK = true }
	frame()
	check(ns.windowOpen == wasOpen, "Back on its own is left to the game")
	WOWSTUB.padHeld = {}
	frame()
end

-- Tracker section follows the objective tracker, in the quest column.
do
	local f = ns.Tracker.frame
	local function anchoredTo(target)
		for _, pt in ipairs(f._points or {}) do if pt[2] == target then return true end end
		return false
	end
	WOWSTUB.Tick(0.3)
	check(ns.Tracker.attached == "below" and anchoredTo(ObjectiveTrackerFrame.NineSlice), "tracker section sits under the quests: " .. tostring(ns.Tracker.attached))
	check(f:GetWidth() == 280, "same width as the objective tracker")
	ObjectiveTrackerFrame.isCollapsed = true
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "header" and anchoredTo(ObjectiveTrackerFrame.Header), "under the header when All Objectives is collapsed")
	ObjectiveTrackerFrame.isCollapsed = nil
	ObjectiveTrackerFrame._shown = false
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "replace", "takes the tracker's place when it's empty")
	ObjectiveTrackerFrame._shown = true
	ns.db.settings.trackerPoint = { "CENTER", "CENTER", 10, 10 }
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "custom", "a dragged position is kept")
	ns.db.settings.trackerPoint = nil
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "below", "reset reattaches it")
end

-- Minimap button
do
	local mb = ns.MinimapButton.button
	check(mb ~= nil, "minimap button created")
	local wasOpen = ns.windowOpen
	mb._scripts.OnClick(mb, "LeftButton")
	check(ns.windowOpen ~= wasOpen, "minimap click toggles the window")
	mb._scripts.OnClick(mb, "LeftButton")
	mb._scripts.OnEnter(mb)
	mb._scripts.OnDragStart(mb)
	mb._scripts.OnDragStop(mb)
	check(type(ns.db.settings.minimapAngle) == "number", "minimap drag saves its position")
	ns.db.settings.minimapButton = false
	ns.MinimapButton:Refresh()
	check(mb._shown == false, "minimap button can be hidden")
	ns.db.settings.minimapButton = true
	ns.MinimapButton:Refresh()
end

-- Exhaustion
Stub.now = Stub.now + 2
ns.Transport.slotCursor = ns.Transport.slotCount + 1
ns.Transport:LoadNextSlot("signal")
check(ns.Transport:BridgeState() == "exhausted", "slot exhaustion detected")
ns.Tracker:Refresh()

print("\nall smoke checks passed; slots loaded: " .. tostring(Stub.loadCount))
