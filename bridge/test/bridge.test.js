import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Bridge, friendlyError, parseFrame, activityLabel, pendingRequest, runSummary, proposedPlan } from '../src/bridge.js';
import { SlotBank } from '../src/slots.js';
import { luaValue } from '../src/luaser.js';
import { markdownToWow, markdownToSpeech } from '../src/format.js';
import { RS, US } from '../src/codec.js';
import { seal } from '../src/strip-crypto.js';
import crypto from 'node:crypto';

let currentKeys = null; // the latest fakeBridge's strip keys: frame() seals with them


function tempAddons(slots = 8) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-addons-'));
  fs.mkdirSync(path.join(dir, 'T3Code'));
  new SlotBank(dir, { slots }).install();
  return dir;
}

function fakeBridge(slots = 8) {
  const dir = tempAddons(slots);
  const b = new Bridge({ addonsDir: dir, config: { slots }, log: () => {}, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-state-')) });
  b.proc = { pid: 1, startTicks: 1 };
  currentKeys = b.stripKeys;
  b.persist = { processKey: '1:1', sigCounter: 1, raised: [], handled: {}, slotGuess: 1, gen: 0 };
  const calls = [];
  b.t3.sendMessage = async (...a) => calls.push(['send', ...a]);
  b.t3.launchThread = async (...a) => (calls.push(['new', ...a]), { threadId: 'new-thread' });
  b.t3.settle = async (...a) => calls.push(['settle', ...a]);
  b.t3.respondAnswers = async (...a) => calls.push(['answer', ...a]);
  b.t3.threadProjection = async () => ({ messages: [], turnItems: [], runtimeRequests: [], runs: [] });
  b.t3.threads.set('t1', { id: 't1', title: 'Fix | the build', projectId: 'p1', status: 'running', activityRunStatus: 'running', updatedAt: new Date().toISOString() });
  b.t3.projects.set('p1', { id: 'p1', title: 'demo' });
  b.voice.speak = () => true;
  return { b, dir, calls };
}

function loadSlot(dir, i) {
  const file = path.join(dir, `T3Code_S${String(i).padStart(3, '0')}`, 'Inbox.lua');
  const out = execFileSync('lua5.1', ['-e', `dofile(${JSON.stringify(file)}) print(T3Code_Inbox and T3Code_Inbox.gen or "nil", T3Code_Inbox and T3Code_Inbox.nextSig or "nil", T3Code_Inbox and T3Code_Inbox.threads and T3Code_Inbox.threads[1] and T3Code_Inbox.threads[1].title or "")`]);
  const [gen, nextSig, title] = out.toString().trim().split('\t');
  return { gen: Number(gen), nextSig: Number(nextSig), title };
}

// Size of the bell file that signal k rings (0 if empty or not created yet).
function rung(dir, k) {
  const file = path.join(dir, 'T3Code', 'Signals', String(3991 + ((k - 1) % 8)).padStart(5, '0') + '.wav');
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function plainFrame(seq, records) {
  return { version: 1, seq, payload: Buffer.from(records.map((r) => r.join(US)).join(RS)) };
}

// What the addon draws once it has the keys.
function frame(seq, records) {
  const plain = plainFrame(seq, records).payload;
  return { version: 2, seq, payload: seal(currentKeys, seq, crypto.randomBytes(12), plain) };
}

test('unencrypted frames: the hello is answered, commands are never run', async () => {
  const { b, dir, calls } = fakeBridge();
  b.onFrame(plainFrame(1, [['H', 1, 'sess', 'ui1', 2, 1, 0, 'o', '', '0.1.0'], ['C', 1, 'send', 't1', 'forged']]));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 0);
  assert.ok(b.client && !b.client.encrypted, 'hello accepted');
  b.publishNow('test');
  const lua = fs.readFileSync(path.join(dir, 'T3Code_S001', 'Inbox.lua'), 'latin1');
  assert.match(lua, new RegExp(`key="${b.stripKeys.hex}"`), 'snapshot carries the keys');
  // A forged "encrypted" frame (wrong keys) is dropped entirely.
  const other = { ...frame(2, [['H', 1, 'sess', 'ui1', 2, 1, 0, 'o', '', '0.1.0'], ['C', 2, 'send', 't1', 'forged']]) };
  other.payload = Buffer.from(other.payload);
  other.payload[20] ^= 0xff;
  b.onFrame(other);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 0);
  assert.equal(b.rejected.forged, 1);
  // The real thing runs.
  b.onFrame(frame(3, [['H', 1, 'sess', 'ui1', 2, 1, 0, 'o', '', '0.1.0'], ['C', 3, 'send', 't1', 'real']]));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls[0][2], 'real');
  assert.ok(b.client.encrypted);
});

test('parseFrame reads hello and commands', () => {
  const f = parseFrame(Buffer.from(['H', 1, 'sess', 'ui1', 5, 9, 123, 'o', 'tid', '0.1.0'].join(US) + RS + ['C', 3, 'send', 'tid', 'hi there'].join(US)));
  assert.equal(f.hello.slot, 5);
  assert.equal(f.hello.sig, 9);
  assert.equal(f.hello.view, 'tid');
  assert.deepEqual(f.commands[0], { id: 3, verb: 'send', args: ['tid', 'hi there'] });
});

test('publish writes the next slots and bootstrap slots, then raises one signal', () => {
  const { b, dir } = fakeBridge();
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 2, 1, 0, 'o', '', '0.1.0']]));
  assert.ok(b.publishNow());
  const s2 = loadSlot(dir, 2);
  const s1 = loadSlot(dir, 1);
  assert.equal(s2.nextSig, 2);
  assert.equal(s1.gen, s2.gen);
  assert.equal(s2.title, 'Fix || the build', 'pipes are escaped for WoW');
  assert.ok(rung(dir, 1) > 174762, 'bell 1 rung with a sound too big for the client to cache');
  assert.equal(rung(dir, 2), 0);
  assert.equal(b.client.slotNext, 3, 'predicts the addon loads one slot');
  // Nothing changed: no publish.
  assert.equal(b.publishNow(), false);
  b.stop();
});

test('commands run once, in order, and results are published', async () => {
  const { b, dir, calls } = fakeBridge();
  const f = frame(2, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', 't1', '0.1.0'], ['C', 1, 'send', 't1', 'hello'], ['C', 2, 'new', 'p1', 'start it']]);
  b.onFrame(f);
  b.onFrame(f); // seen again: not re-run
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls.map((c) => c[0]), ['send', 'new']);
  assert.equal(calls[0][2], 'hello');
  b.publishNow();
  const lua = fs.readFileSync(path.join(dir, 'T3Code_S001', 'Inbox.lua'), 'latin1');
  assert.match(lua, /results=\{\{id=1,ok=true,msg="Sent"\},\{id=2,ok=true,open="new-thread"\}/);
  assert.match(lua, /ack=\{ui="ui1",seq=2\}/);
  b.stop();
});

test('a picked model rides along with new, and model switches a thread', async () => {
  const { b, calls } = fakeBridge();
  b.t3.setModel = async (...a) => calls.push(['model', ...a]);
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', 't1', '0.1.0'], ['C', 1, 'new', 'p1', 'go', 'codex', 'gpt-x'], ['C', 2, 'new', 'p1', 'auto'], ['C', 3, 'model', 't1', 'codex', 'gpt-y'], ['C', 4, 'new', 'p1', 'hard', '', '', 'high'], ['C', 5, 'model', 't1', 'codex', 'gpt-y', 'low']]));
  await new Promise((r) => setTimeout(r, 20));
  const news = calls.filter((c) => c[0] === 'new');
  assert.deepEqual(news.find((c) => c[2] === 'go')[4], { model: { instanceId: 'codex', model: 'gpt-x' } });
  assert.deepEqual(news.find((c) => c[2] === 'auto')[4], {}, 'no pick: T3 picks as before');
  assert.deepEqual(news.find((c) => c[2] === 'hard')[4], { effort: 'high' }, 'only a level picked: on the default model');
  const models = calls.filter((c) => c[0] === 'model');
  assert.deepEqual(models[0], ['model', 't1', 'codex', 'gpt-y', undefined]);
  assert.deepEqual(models[1], ['model', 't1', 'codex', 'gpt-y', 'low']);
  b.stop();
});

test('the model list is only sent while the addon reports a different one', () => {
  const { b } = fakeBridge();
  const levels = (...ids) => ({ capabilities: { optionDescriptors: [{ id: 'effort', type: 'select', options: ids.map((id, n) => ({ id, label: id.toUpperCase(), isDefault: n === 1 })) }] } });
  b.t3.local.client.config = {
    providers: [
      { instanceId: 'codex', displayName: 'Codex', enabled: true, models: [{ slug: 'a', name: 'A | B', ...levels('low', 'high') }, { slug: 'b', name: 'B', ...levels('low', 'high') }, { slug: 'n', name: 'N' }] },
      { instanceId: 'claude', displayName: 'Claude  Harness', enabled: true, models: [{ slug: 'o', name: 'O', ...levels('low', 'max') }] },
    ],
  };
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', '', '0.1.0', '8']]));
  const first = b.buildSnapshot().models;
  assert.equal(first.g[0].e, '');
  assert.deepEqual(first.g[0].p, [
    { i: 'codex', n: 'Codex', m: [{ s: 'a', l: 'A || B', r: 1 }, { s: 'b', l: 'B', r: 1 }, { s: 'n', l: 'N', r: undefined }] },
    { i: 'claude', n: 'Claude Harness', m: [{ s: 'o', l: 'O', r: 2 }] },
  ], 'grouped by provider; models with the same levels share a set');
  assert.deepEqual(first.g[0].x, [
    { k: 'effort', d: 'high', o: [{ i: 'low', l: 'LOW' }, { i: 'high', l: 'HIGH' }] },
    { k: 'effort', d: 'max', o: [{ i: 'low', l: 'LOW' }, { i: 'max', l: 'MAX' }] },
  ]);
  b.onFrame(frame(2, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', '', '0.1.0', '8', first.h]]));
  assert.equal(b.buildSnapshot().models, undefined, 'the addon has this list');
  b.t3.local.client.config.providers[0].models.push({ slug: 'c', name: 'C' });
  assert.ok(b.buildSnapshot().models, 'a changed list goes out again');
  for (const p of b.t3.local.client.config.providers) p.enabled = false;
  assert.deepEqual(b.buildSnapshot().models.g, [], 'switching off the last provider clears the list');
  b.stop();
});

test('a reload (new ui token) resets the slot pointer; stale beacons do not', () => {
  const { b } = fakeBridge();
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 6, 4, 0, 'o', '', '0.1.0']]));
  assert.equal(b.client.slotNext, 6);
  assert.equal(b.persist.sigCounter, 4);
  b.publishNow('test');
  assert.equal(b.client.slotNext, 7);
  // An old frame still on screen (gen older than our publish) must not rewind us.
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 6, 4, 0, 'o', '', '0.1.0']]));
  assert.equal(b.client.slotNext, 7);
  // /reload: new ui, addon bootstrapped slot 1, now at 2.
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui2', 2, 5, b.lastGen, 'o', '', '0.1.0']]));
  assert.equal(b.client.slotNext, 2);
  b.stop();
});

test('an addon waiting on a stale signal gets that signal raised too', () => {
  const { b, dir } = fakeBridge();
  b.persist.sigCounter = 9;
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 2, 4, 0, 'o', '', '0.1.0']]));
  b.persist.sigCounter = 9; // e.g. restored from a restarted bridge
  b.client.slotNext = 2;
  b.publishNow('test');
  assert.ok(rung(dir, 4) > 0, 'bell the addon listens for is rung');
  assert.ok(rung(dir, 9) > 0);
  assert.equal(loadSlot(dir, 2).nextSig, 10);
  b.stop();
});

test('signals are never skipped, and never rung ahead of our counter', () => {
  const { b, dir } = fakeBridge();
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 2, 5, 0, 'o', '', '0.1.0']]));
  b.persist.sigCounter = 5;
  b.client.pollSig = 8; // an addon that ran ahead (bells it listens to would alias rung ones)
  b.publishNow('test');
  assert.ok(rung(dir, 5) > 0, 'our next bell rung');
  for (const k of [6, 7, 8]) assert.equal(rung(dir, k), 0, `bell ${k} not rung ahead`);
  assert.equal(b.persist.sigCounter, 6);
  b.stop();
});

test('a drifted slot prediction still covers the slot the addon will load', () => {
  const { b, dir } = fakeBridge(120);
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 40, 5, 0, 'o', '', '0.1.0']]));
  b.client.slotNext = 101; // we kept predicting while the game didn't load anything
  b.publishNow('test');
  const gen = loadSlot(dir, 40).gen;
  assert.ok(gen > 0, 'confirmed slot written');
  assert.equal(loadSlot(dir, 70).gen, gen);
  assert.equal(loadSlot(dir, 105).gen, gen);
  b.stop();
});

test('bells rotate: ringing k empties the bell four behind it', () => {
  const dir = tempAddons(2);
  const bank = new SlotBank(dir, { slots: 2 });
  for (let k = 1; k <= 12; k++) bank.raise(k);
  // 9..12 rung (the addon's look-ahead window), 5..8 emptied again.
  for (const k of [9, 10, 11, 12]) assert.ok(rung(dir, k) > 0, `bell ${k}`);
  for (const k of [13, 14, 15, 16]) assert.equal(rung(dir, k), 0, `bell ${k} (same files as 5..8)`);
  bank.prepareBells();
  assert.ok(fs.statSync(path.join(dir, 'T3Code', 'Signals', '03999.wav')).size > 174762, 'self-test control is long');
  assert.equal(fs.statSync(path.join(dir, 'T3Code', 'Signals', '04000.wav')).size, 0);
  bank.resetSignals();
  for (let k = 1; k <= 8; k++) assert.equal(rung(dir, k), 0);
});

test('activity labels and pending questions', () => {
  const proj = {
    runs: [{ id: 'r1' }],
    turnItems: [
      { runId: 'r1', type: 'command_execution', status: 'completed', input: 'ls' },
      { runId: 'r1', type: 'subagent', status: 'running' },
      { runId: 'r1', type: 'user_input_request', status: 'pending', requestId: 'q', questions: [{ id: 'a', header: 'H', question: 'Pick | one', options: [{ label: 'X', description: 'x' }] }] },
    ],
    runtimeRequests: [{ id: 'q', kind: 'user_input', status: 'pending' }],
  };
  assert.equal(activityLabel(proj), 'Working with a subagent');
  const p = pendingRequest(proj);
  assert.equal(p.kind, 'question');
  assert.equal(p.questions[0].q, 'Pick || one');
  assert.equal(p.questions[0].opts[0].v, 'X');
});

test('lua serializer escapes strings and keeps utf-8', () => {
  const s = luaValue({ a: 'x"y\\z\n\u0001', b: ['é', 1.5, true], 'not ident': 1, end: 2 });
  const file = path.join(os.tmpdir(), `t3wow-ser-${process.pid}.lua`);
  fs.writeFileSync(file, Buffer.from(`local t = ${s}; io.write(t.a, "|", t.b[1], "|", t["not ident"], "|", t["end"])`, 'latin1'));
  const out = execFileSync('lua5.1', [file]);
  fs.rmSync(file);
  assert.equal(out.toString('utf8'), 'x"y\\z\n\u0001|é|1|2');
});

test('markdown formatting', () => {
  const w = markdownToWow('# Title\n- item with `code` and **bold** | pipe\n```\nfn()\n```');
  assert.match(w, /\|cffffd100Title\|r/);
  assert.match(w, /•/);
  assert.match(w, /\|\| pipe/);
  assert.match(w, /fn\(\)/);
  assert.equal(markdownToSpeech('**Done**: see [docs](http://x)'), 'Done : see docs');
});

test('run summary, plan text and approval details', () => {
  const proj = {
    runs: [{ id: 'r1', startedAt: '2026-11-08T00:00:00Z', completedAt: '2026-11-08T00:04:12Z' }],
    turnItems: [
      { runId: 'r1', type: 'command_execution' },
      { runId: 'r1', type: 'command_execution' },
      { runId: 'r1', type: 'file_change', fileName: '/x/a.lua' },
      { runId: 'r1', type: 'file_change', fileName: '/x/a.lua' },
      { runId: 'r1', type: 'file_change', fileName: '/x/b.lua' },
      { runId: 'r1', type: 'subagent' },
      { runId: 'r1', type: 'proposed_plan', markdown: '# Plan\n- step one' },
      { runId: 'r1', nodeId: 'n1', type: 'file_change', fileName: '/x/c.lua', additions: 12, deletions: 3 },
    ],
    runtimeRequests: [{ id: 'q', kind: 'file-change', status: 'pending', nodeId: 'n1' }],
  };
  assert.equal(runSummary(proj), 'Last run: 2 commands · edited 3 files (a.lua, b.lua, c.lua) · 1 subagent · 4m 12s');
  assert.equal(proposedPlan(proj), '# Plan\n- step one');
  const p = pendingRequest(proj);
  assert.deepEqual(p.files, [{ f: 'c.lua', a: 12, d: 3 }]);
  assert.equal(p.always, undefined);
  proj.runtimeRequests[0].kind = 'command';
  proj.turnItems.push({ runId: 'r1', nodeId: 'n1', type: 'command_execution', input: 'rm -rf build' });
  assert.equal(pendingRequest(proj).detail, 'rm -rf build');
  assert.equal(pendingRequest(proj).always, true);
});

test('screenshots ride along with the next message', async () => {
  const { b, calls } = fakeBridge();
  b.capture.screenshot = async () => ({ data: Buffer.from('jpeg'), name: 's.jpg', mime: 'image/jpeg' });
  b.t3.uploadImage = async (key, data, name, mime) => ({ type: 'image', id: 'att-1', name, mimeType: mime, sizeBytes: data.length });
  b.t3.sendMessage = async (...a) => calls.push(['send', ...a]);
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', 't1', '0.1.0'], ['C', 1, 'shot', 't1']]));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(b.shots.get('t1').length, 1);
  b.onFrame(frame(2, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'o', 't1', '0.1.0'], ['C', 2, 'send', 't1', 'look at this']]));
  await new Promise((r) => setTimeout(r, 20));
  const send = calls.find((c) => c[0] === 'send');
  assert.equal(send[2], 'look at this');
  assert.equal(send[4][0].id, 'att-1');
  assert.equal(b.shots.has('t1'), false);
  b.stop();
});

test('read-aloud waits while the player is in combat', () => {
  const { b } = fakeBridge();
  const spoken = [];
  b.voice.speak = (t) => spoken.push(t);
  b.onFrame(frame(1, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'orq', '', '0.1.0']]));
  b.announce({ id: 't1', title: 'Fix it' }, 'open');
  assert.equal(spoken.length, 0);
  assert.ok(b.deferredAnnounce);
  b.onFrame(frame(2, [['H', 1, 'sess', 'ui1', 1, 1, 0, 'or', '', '0.1.0']]));
  b.stop();
});

test('missing dictation explains itself in platform terms', () => {
  const { b } = fakeBridge();
  b.voice.canOmarchyDictate = () => false;
  b.voice.canTranscribe = () => false;
  assert.match(b.voice.dictationHint('darwin'), /macOS/, 'macOS gets macOS words');
  assert.doesNotMatch(b.voice.dictationHint('darwin'), /Omarchy/, "macOS isn't told to use Omarchy");
  assert.match(b.voice.dictationHint('linux'), /Omarchy/, 'Linux keeps the Omarchy hint');
  assert.throws(() => b.dictate('start'), (err) => err.message === b.voice.dictationHint());
  const noBackend = b.buildSnapshot().bridge;
  assert.equal(noBackend.dictation, undefined);
  assert.equal(noBackend.dictationHint, b.voice.dictationHint(), 'the addon is told what to show');
  b.voice.canOmarchyDictate = () => true;
  b.voice.backendName = () => 'voxtype';
  const withBackend = b.buildSnapshot().bridge;
  assert.equal(withBackend.dictation, 'omarchy-dictation (voxtype)');
  assert.equal(withBackend.dictationHint, undefined, 'no hint when dictation works');
  b.stop();
});

test('pacing: fast while reading, patient otherwise, reserve kept for alerts', () => {
  const { b } = fakeBridge(600);
  const hello = (flags, seq = 1) => frame(seq, [['H', 1, 'sess', 'ui1', 2, 1, 0, flags, 't1', '0.1.0', '600']]);
  b.onFrame(hello('oa'));
  b.publishNow('test'); // ack the hello
  b.lastPublishAt = Date.now();
  b.dirty = { important: false, minor: false, view: true };
  assert.ok(b.nextPublishDelay() <= 1500, 'reading: new reply text within 1.5s');
  b.client.flags = 'o';
  assert.ok(b.nextPublishDelay() >= 4500, 'window open but idle: ~5s');
  b.dirty = { important: false, minor: true, view: false };
  b.client.flags = '';
  assert.ok(b.nextPublishDelay() >= 55000, 'window closed: activity churn waits ~a minute');
  b.dirty = { important: true, minor: false, view: false };
  assert.ok(b.nextPublishDelay() <= 3000, 'window closed: a thread finishing still goes within 3s');
  // Low on slots: intervals stretch; at the reserve only alerts go.
  b.client.slotNext = 560; // 41 left of 600
  b.dirty = { important: false, minor: false, view: true };
  b.client.flags = 'oa';
  assert.ok(b.nextPublishDelay() >= 3500, 'scarce: reading updates stretch');
  b.client.slotNext = 590; // 11 left
  assert.equal(b.nextPublishDelay(), null, 'reserve: no view updates');
  b.dirty = { important: true, minor: false, view: false };
  assert.ok(b.nextPublishDelay() !== null, 'reserve: alerts still go');
  b.client.seq = 99; // an unacknowledged command
  assert.ok(b.nextPublishDelay() <= 400, 'acks always go right away');
  b.stop();
});

test('usage comes from the Omarchy records the Agents panel keeps', async () => {
  const { OmarchyUsage, mergeUsage } = await import('../src/usage.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-usage-'));
  let changes = 0;
  const u = new OmarchyUsage({ dir, updater: 'definitely-not-a-command', onChange: () => changes++ });
  fs.writeFileSync(path.join(dir, 'claude.json'), JSON.stringify({ tierLabel: 'Max 20x', limits: [{ label: 'Weekly', percent: 0.18, resetsAt: '2026-11-12T00:00:00Z' }], todayPrompts: 3, todayTotalTokens: 2.5e6 }));
  u.refresh(['claudeAgent', 'codex']);
  assert.equal(changes, 1);
  const e = mergeUsage({ instanceId: 'claudeAgent', displayName: 'Claude' }, u.forInstance('claudeAgent'));
  assert.equal(e.plan, 'Max 20x');
  assert.deepEqual(e.windows.map((w) => [w.label, w.used]), [['Weekly', 18]]);
  assert.equal(e.today, 'Today: 3 prompts · 3M tokens');
  u.refresh(['claudeAgent']); // unchanged file: no re-read, no change event
  assert.equal(changes, 1);
});

test('slot manifests are identical and keep the live data out of addon-manager fingerprints', () => {
  const dir = tempAddons(3);
  const read = (i, f) => fs.readFileSync(path.join(dir, `T3Code_S00${i}`, f), 'utf8');
  assert.equal(read(1, 'T3Code_S001.toc'), read(3, 'T3Code_S003.toc'));
  assert.doesNotMatch(read(1, 'T3Code_S001.toc'), /Dependencies|Inbox\.lua/);
  // WowUp/CurseForge follow only self-closing <Script file="..."/> includes.
  const xml = read(1, 'Slot.xml');
  assert.match(xml, /<Script file="Inbox\.lua"><\/Script>/);
  assert.doesNotMatch(xml, /<(?:Include|Script)\s+file=["']((?:(?<!\.\.).)+)["']\s*\/>/is);
});

test('reopening a settled thread sends the reason T3 Code requires', async () => {
  const { T3Client } = await import('../src/t3.js');
  const c = new T3Client({ tokenProvider: async () => 'x' });
  const sent = [];
  c.request = async (tag, payload) => sent.push([tag, payload]);
  await c.unsettle('t1');
  assert.equal(sent[0][0], 'orchestration.dispatchCommand');
  assert.equal(sent[0][1].type, 'thread.unsettle');
  assert.equal(sent[0][1].reason, 'user');
});

test('schema errors from T3 Code read as a version mismatch', () => {
  assert.match(friendlyError('Missing key\n  at ["reason"]'), /didn't accept that request \(it wants "reason"\)/);
  assert.equal(friendlyError('nothing is running in that thread'), 'nothing is running in that thread');
});

test('a settled thread shows as settled even with an unreviewed plan', async () => {
  const { threadStatus } = await import('../src/t3.js');
  const t = { status: 'completed', hasActionableProposedPlan: true, settledOverride: 'settled' };
  assert.equal(threadStatus(t), 'settled');
  assert.equal(threadStatus({ ...t, settledOverride: null }), 'plan');
  assert.equal(threadStatus({ ...t, pendingRuntimeRequest: { kind: 'user_input' } }), 'input');
});
