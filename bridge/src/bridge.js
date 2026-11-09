// The bridge: watches the addon's pixel strip, keeps the game's live-update slots
// fed with a snapshot of T3 Code, and runs the addon's commands against T3.
//
// Protocol (see docs/ARCHITECTURE.md):
//   game -> bridge   pixel frame: records split by RS, fields by US
//       H  proto session ui slot sig gen flags view version     (always first)
//       C  id verb args...                                      (pending commands)
//   bridge -> game   T3Code_Inbox = { gen, nextSig, ack = { ui, seq }, threads, view, ... }
//                    written into the next slots the addon will load, then signal
//                    `nextSig - 1` is raised so the addon loads exactly one slot.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RS, US } from './codec.js';
import { StripCapture } from './capture.js';
import { SlotBank } from './slots.js';
import { threadStatus, isUnread } from './t3.js';
import { Fleet } from './fleet.js';
import { tokenProvider } from './auth.js';
import { Voice } from './voice.js';
import { OmarchyUsage, mergeUsage } from './usage.js';
import { findWowProcess, processKey } from './wow.js';
import { markdownToWow, markdownToSpeech, firstLine, escapeWow } from './format.js';
import { loadOrCreateKey, deriveKeys, open as openSealed, ENCRYPTED_VERSION } from './strip-crypto.js';

export const VERSION = '0.2.0';
export const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 't3code-wow');

const sec = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : undefined);

const ACTIVE = new Set(['working', 'input', 'plan']);
const ORDER = { input: 0, plan: 1, working: 2, failed: 3, open: 4, settled: 5 };

export function activityLabel(projection) {
  if (!projection) return null;
  const runId = projection.runs?.at(-1)?.id;
  const items = (projection.turnItems || []).filter((i) => !runId || i.runId === runId);
  const live = items.filter((i) => i.status === 'running' || i.status === 'pending' || i.streaming);
  const subagents = live.filter((i) => i.type === 'subagent').length;
  if (subagents > 1) return `Working with ${subagents} subagents`;
  if (subagents === 1) return 'Working with a subagent';
  const last = live.at(-1);
  if (!last) return null;
  switch (last.type) {
    case 'command_execution': {
      const cmd = String(last.input || last.title || '').split('\n')[0];
      return cmd ? `Running ${cmd.length > 40 ? cmd.slice(0, 39) + '…' : cmd}` : 'Running a command';
    }
    case 'file_change':
      return `Editing ${path.basename(String(last.fileName || 'files'))}`;
    case 'web_search':
      return 'Searching the web';
    case 'reasoning':
      return 'Thinking';
    case 'assistant_message':
      return 'Writing a reply';
    case 'dynamic_tool':
      return last.toolName ? `Using ${last.toolName}` : 'Using a tool';
    default:
      return null;
  }
}

function lastAssistantText(projection) {
  const msgs = (projection?.messages || []).filter((m) => m.role === 'assistant' && m.text);
  return msgs.at(-1)?.text || null;
}

export function pendingRequest(projection) {
  const req = (projection?.runtimeRequests || []).find((r) => r.status === 'pending');
  if (!req) return null;
  const items = projection.turnItems || [];
  if (req.kind === 'user_input') {
    const item = items.find((i) => i.type === 'user_input_request' && i.requestId === req.id);
    return {
      id: req.id,
      kind: 'question',
      questions: (item?.questions || []).map((q) => ({
        id: q.id,
        h: escapeWow(q.header),
        q: escapeWow(q.question),
        multi: q.multiSelect || undefined,
        custom: q.allowCustomAnswer || undefined,
        opts: (q.options || []).map((o) => ({ l: escapeWow(o.label), d: escapeWow(o.description), v: o.value ?? o.label })),
      })),
    };
  }
  const item = [...items].reverse().find((i) => i.nodeId === req.nodeId && i.type !== 'reasoning');
  let detail = '';
  let files;
  if (item?.type === 'file_change') {
    const changes = Array.isArray(item.changes) && item.changes.length ? item.changes : [item];
    files = changes.slice(0, 8).map((c) => ({
      f: escapeWow(path.basename(String(c.fileName || c.path || item.fileName || 'file'))),
      a: c.additions ?? undefined,
      d: c.deletions ?? undefined,
    }));
    detail = item.fileName || '';
  } else if (item?.type === 'command_execution') {
    detail = item.input || item.title || '';
  } else if (item) {
    detail = [item.toolName || item.title, item.input && typeof item.input !== 'string' ? JSON.stringify(item.input) : item.input]
      .filter(Boolean)
      .join(': ');
  }
  const labels = {
    command: 'Run a command',
    'file-read': 'Read a file',
    'file-change': 'Change files',
    'mcp-elicitation': 'Answer a tool request',
    permission: 'Grant a permission',
    dynamic_tool_call: 'Use a tool',
    auth_refresh: 'Sign in again',
  };
  return {
    id: req.id,
    kind: 'approval',
    what: labels[req.kind] || req.kind,
    detail: escapeWow(String(detail).slice(0, 1200)),
    files,
    always: req.kind === 'command' || undefined,
  };
}

// "Last run: 12 commands · edited 3 files (a.lua, b.lua, +1) · 1 subagent · 4m 12s"
export function runSummary(projection, now = Date.now()) {
  const run = projection?.runs?.at(-1);
  if (!run) return null;
  const items = (projection.turnItems || []).filter((i) => i.runId === run.id);
  const count = (type) => items.filter((i) => i.type === type).length;
  const commands = count('command_execution');
  const files = [...new Set(items.filter((i) => i.type === 'file_change').map((i) => path.basename(String(i.fileName || ''))))].filter(Boolean);
  const searches = count('web_search');
  const subagents = count('subagent');
  const tools = count('dynamic_tool');
  const parts = [];
  if (commands) parts.push(`${commands} command${commands === 1 ? '' : 's'}`);
  if (files.length) {
    const shown = files.slice(0, 3).join(', ') + (files.length > 3 ? `, +${files.length - 3}` : '');
    parts.push(`edited ${files.length} file${files.length === 1 ? '' : 's'} (${shown})`);
  }
  if (searches) parts.push(`${searches} web search${searches === 1 ? '' : 'es'}`);
  if (subagents) parts.push(`${subagents} subagent${subagents === 1 ? '' : 's'}`);
  if (tools) parts.push(`${tools} tool call${tools === 1 ? '' : 's'}`);
  const start = Date.parse(run.startedAt || run.requestedAt || '');
  const end = run.completedAt ? Date.parse(run.completedAt) : now;
  if (start && end > start) {
    const sec = Math.round((end - start) / 1000);
    parts.push(sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`);
  }
  if (!parts.length) return null;
  return `${run.completedAt ? 'Last run' : 'This run so far'}: ${parts.join(' · ')}`;
}

export function proposedPlan(projection) {
  const plan = [...(projection?.turnItems || [])].reverse().find((i) => i.type === 'proposed_plan' && i.markdown);
  return plan ? plan.markdown : null;
}

export function parseFrame(payload) {
  const records = payload.toString('utf8').split(RS).map((r) => r.split(US));
  const out = { hello: null, commands: [] };
  for (const f of records) {
    if (f[0] === 'H' && !out.hello) {
      out.hello = {
        proto: Number(f[1]),
        session: f[2] || '',
        ui: f[3] || '',
        slot: Number(f[4]) || 1,
        sig: Number(f[5]) || 1,
        gen: Number(f[6]) || 0,
        flags: f[7] || '',
        view: f[8] || '',
        version: f[9] || '',
        slots: Number(f[10]) || 0,
      };
    } else if (f[0] === 'C') {
      out.commands.push({ id: Number(f[1]), verb: f[2], args: f.slice(3) });
    }
  }
  return out;
}

// T3 Code's schema errors ("Missing key\n  at [\"reason\"]") mean this bridge and
// the T3 server disagree about a request; say that, not the raw validator text.
export function friendlyError(message) {
  const text = String(message || 'failed');
  if (/Missing key|Expected .*(Literal|Struct|Union)|is unexpected|Unexpected key/.test(text)) {
    const field = /at \[\"?([^\]"]+)/.exec(text)?.[1];
    return `T3 Code didn't accept that request${field ? ` (it wants "${field}")` : ''}. Update t3code-wow to match your T3 Code version.`;
  }
  return text.split('\n')[0].slice(0, 200);
}

export class Bridge {
  constructor({ addonsDir, config = {}, log = console.log, stateDir = STATE_DIR }) {
    this.addonsDir = addonsDir;
    this.config = config;
    this.log = (...a) => {
      const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`;
      this.logs.push(line);
      if (this.logs.length > 200) this.logs.shift();
      log(line);
    };
    this.logs = [];
    this.bank = new SlotBank(addonsDir, { slots: config.slots || 1200 });
    const installed = this.bank.installedSlotCount();
    if (installed > 0) this.bank.slots = installed;
    this.capture = new StripCapture({ log: this.log, backend: config.capture?.backend || 'auto', region: config.capture?.region || null, stateDir });
    this.tokens = tokenProvider({ log: this.log });
    // Every T3 Code machine we show: this one, plus any added with `t3code-wow env add`.
    this.t3 = new Fleet({ localTokens: this.tokens, environments: config.environments || [], log: this.log });
    this.voice = new Voice({ ttsCommand: config.tts?.command || null, rate: config.tts?.rate || 0, log: this.log });
    this.stateDir = stateDir;
    this.stateFile = path.join(stateDir, 'state.json');
    this.statusFile = path.join(stateDir, 'status.json');
    this.persist = this.loadState();
    // Keys for the encrypted strip; the addon gets them in every snapshot.
    this.stripKeys = deriveKeys(loadOrCreateKey(stateDir));
    this.rejected = { forged: 0, plainCommands: 0, loggedAt: 0 };
    this.client = null; // what we know about the addon
    this.proc = null;
    this.views = new Map(); // threadId -> { projection, fetchedAt, inflight, again }
    this.results = [];
    this.omarchyUsage = new OmarchyUsage({ log: this.log, onChange: () => this.markDirty('minor') });
    this.shots = new Map(); // thread key (or 'new') -> screenshots waiting for the next message
    this.lastPublishAt = 0;
    this.lastGen = this.persist.gen || 0;
    this.lastDigest = null;
    this.dirty = { important: false, minor: false, view: false };
    this.publishTimer = null;
    this.stopped = false;
    this.captureState = 'starting';
    this.prevStatus = new Map();
  }

  loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return { processKey: null, sigCounter: 1, raised: [], handled: {}, slotGuess: 1, gen: 0 };
    }
  }

  saveState() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.persist));
      fs.renameSync(tmp, this.stateFile);
    }, 250);
  }

  // ---------------------------------------------------------------------------

  async start() {
    this.log(`t3code-wow bridge ${VERSION}; addons: ${this.addonsDir}; slots: ${this.bank.slots}`);
    try {
      this.bank.prepareBells();
    } catch (err) {
      this.log(`couldn't prepare the update bells: ${err.message}`);
    }
    const v = this.voice.describe();
    this.log(`speech: ${v.tts || 'none'}; dictation: ${v.dictation || 'none'}; capture: ${this.capture.resolveBackend()}`);
    this.t3.on('state', (s, e) => {
      this.log(`T3: ${s}${e ? ` (${e})` : ''}`);
      this.markDirty('important');
    });
    this.t3.on('change', (ev) => this.onT3Change(ev));
    this.t3.on('config', () => this.markDirty('minor'));
    this.t3.start();
    this.checkProcess();
    this.procTimer = setInterval(() => this.checkProcess(), 4000);
    this.statusTimer = setInterval(() => this.writeStatus(), 3000);
    // Pick up new Omarchy usage records (the shell's Agents panel refreshes them).
    this.usageTimer = setInterval(() => this.omarchyUsage.refresh(this.usageInstances()), 60000);
    this.capture.prepare();
    this.captureLoop();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.procTimer);
    clearInterval(this.statusTimer);
    clearInterval(this.usageTimer);
    clearTimeout(this.publishTimer);
    this.t3.stop();
    this.voice.hush();
  }

  checkProcess() {
    const proc = findWowProcess();
    const key = processKey(proc);
    const was = this.proc;
    this.proc = proc;
    if (key && key !== this.persist.processKey) {
      // A new client process: its sound cache is empty, so every signal file is
      // reusable. Reset them and start counting again.
      this.log(`WoW client started (pid ${proc.pid}); resetting live-update signals`);
      this.bank.resetSignals();
      this.persist.processKey = key;
      this.persist.sigCounter = 1;
      this.persist.raised = [];
      this.persist.slotGuess = 1;
      this.client = null;
      this.saveState();
      this.publishNow('client start');
    } else if (!proc && was) {
      this.log('WoW client exited');
      this.client = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Capture loop

  async captureLoop() {
    while (!this.stopped) {
      let delay = 400;
      if (!this.proc) {
        this.captureState = 'no-client';
        delay = 2000;
      } else {
        const res = await this.capture.poll(this.proc.pid);
        if (res.status === 'frame') {
          this.captureState = 'ok';
          this.onFrame(res.frame);
          delay = 150;
        } else {
          this.captureState = res.status === 'empty' ? (this.client ? 'idle' : 'waiting') : res.status;
          if (res.status === 'error' && this.capture.stats.captures % 50 === 1) this.log(`capture: ${res.error}`);
          if (res.status === 'hidden' || res.status === 'no-window') delay = 1000;
          if (Date.now() - this.capture.lastSeenAt < 4000) delay = 150;
          else if (this.client?.flags.includes('o') && res.status === 'empty') delay = 200;
          else if (this.client && res.status === 'empty') delay = 700; // window closed: nothing urgent
        }
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  onFrame(frame) {
    // Encrypted frames must authenticate. A plaintext frame is only a bare hello from
    // an addon that doesn't have our keys yet; we answer it (the snapshot carries the
    // keys) but never run commands from it.
    let payload = frame.payload;
    const sealed = frame.version === ENCRYPTED_VERSION;
    if (sealed) {
      payload = openSealed(this.stripKeys, frame.seq, frame.payload);
      if (!payload) {
        this.rejected.forged++;
        this.noteRejected('ignored a strip frame that failed authentication (an old key? the addon fetches the current one)');
        return;
      }
    }
    const { hello, commands } = parseFrame(payload);
    if (!hello || hello.proto !== 1) return;
    if (!sealed && commands.length) {
      this.rejected.plainCommands += commands.length;
      this.noteRejected(`ignored ${commands.length} unencrypted command(s); the addon resends them once it has the keys`);
    }
    let c = this.client;
    if (!c || c.ui !== hello.ui || c.session !== hello.session) {
      this.log(`addon connected (ui ${hello.ui}, slot ${hello.slot}, signal ${hello.sig}, addon ${hello.version})`);
      c = this.client = { session: hello.session, ui: hello.ui, ackedSeq: -1, flags: '', view: '' };
      c.slotNext = hello.slot;
      this.persist.sigCounter = Math.max(this.persist.sigCounter, hello.sig);
      this.markDirty('important');
    } else if (hello.gen >= this.lastGen) {
      // The addon has applied our latest publish, so its pointers are authoritative.
      c.slotNext = hello.slot;
      if (hello.sig > this.persist.sigCounter) this.persist.sigCounter = hello.sig;
    }
    c.encrypted = sealed;
    if (c.flags !== hello.flags) {
      const wasQuiet = c.flags.includes('q');
      c.flags = hello.flags;
      this.markDirty('minor');
      // Out of combat / a quiet instance: read the held announcement now.
      if (wasQuiet && !c.flags.includes('q') && this.deferredAnnounce) {
        const { thread, status } = this.deferredAnnounce;
        this.deferredAnnounce = null;
        this.announce(thread, status);
      }
    }
    if (hello.slots) c.slotCount = hello.slots;
    if (c.view !== hello.view) {
      c.view = hello.view;
      if (c.view) this.refreshView(c.view, true);
      this.markDirty('view');
    }
    c.seq = frame.seq;
    c.pollSig = hello.sig;
    // Where the addon really is: it hasn't loaded past this slot yet.
    c.confirmedSlot = hello.slot;
    c.confirmedAt = Date.now();
    this.persist.confirmedSlot = hello.slot;
    c.version = hello.version;
    c.lastSeen = Date.now();
    this.persist.slotGuess = c.slotNext;

    const handled = this.persist.handled[c.session] || 0;
    const fresh = (sealed ? commands : []).filter((cmd) => cmd.id > handled).sort((a, b) => a.id - b.id);
    if (fresh.length) {
      this.persist.handled[c.session] = fresh.at(-1).id;
      this.saveState();
      for (const cmd of fresh) this.runCommand(cmd);
    }
    if (c.ackedSeq !== frame.seq) this.schedulePublish();
  }

  noteRejected(msg) {
    if (Date.now() - this.rejected.loggedAt < 30000) return;
    this.rejected.loggedAt = Date.now();
    this.log(msg);
  }

  // ---------------------------------------------------------------------------
  // Commands from the game

  async runCommand(cmd) {
    const [a0, a1, a2] = cmd.args;
    this.log(`command ${cmd.id}: ${cmd.verb} ${cmd.verb === 'send' || cmd.verb === 'new' ? a0 : cmd.args.join(' ').slice(0, 80)}`);
    let ok = true;
    let msg = null;
    try {
      switch (cmd.verb) {
        case 'send': {
          const attachments = await this.takeShots(a0, a0);
          await this.t3.sendMessage(a0, a1, a2 || 'auto', attachments);
          msg = attachments.length ? `Sent with ${attachments.length} screenshot${attachments.length === 1 ? '' : 's'}` : 'Sent';
          break;
        }
        case 'shot': {
          const key = a0 || 'new';
          const image = await this.capture.screenshot(this.proc?.pid);
          const list = this.shots.get(key) || [];
          list.push(image);
          this.shots.set(key, list.slice(-4));
          msg = `Screenshot attached (${Math.round(image.data.length / 1024)} KB)`;
          break;
        }
        case 'unshot':
          this.shots.delete(a0 || 'new');
          ok = null;
          break;
        case 'new': {
          const attachments = await this.takeShots('new', a0);
          const res = await this.t3.launchThread(a0, a1, attachments);
          msg = 'Thread started';
          if (res?.threadId) this.results.push({ id: cmd.id, ok: true, open: res.threadId });
          break;
        }
        case 'stop':
          await this.t3.interrupt(a0);
          msg = 'Stopped';
          break;
        case 'settle':
          await this.t3.settle(a0);
          break;
        case 'unsettle':
          await this.t3.unsettle(a0);
          break;
        case 'archive':
          await this.t3.archive(a0);
          break;
        case 'read':
          await this.t3.visit(a0);
          ok = null; // silent
          break;
        case 'approve':
          await this.t3.respondApproval(a0, a1, a2 || 'accept');
          break;
        case 'answer': {
          const answers = {};
          for (let i = 2; i + 1 < cmd.args.length; i += 2) {
            const qid = cmd.args[i];
            const value = cmd.args[i + 1];
            if (answers[qid] === undefined) answers[qid] = value;
            else answers[qid] = [].concat(answers[qid], value);
          }
          await this.t3.respondAnswers(a0, a1, answers);
          break;
        }
        case 'speak': {
          const text = await this.speechFor(a0, a1);
          if (!text) throw new Error('nothing to read');
          if (!this.voice.speak(text)) throw new Error('no text-to-speech engine on this system');
          ok = null;
          break;
        }
        case 'say':
          if (!this.voice.speak(a0)) throw new Error('no text-to-speech engine on this system');
          ok = null;
          break;
        case 'hush':
          this.voice.hush();
          ok = null;
          break;
        case 'dictate':
          this.dictate(a0 || 'start');
          ok = null;
          break;
        case 'ping':
          ok = null;
          break;
        default:
          throw new Error(`unknown command ${cmd.verb}`);
      }
    } catch (err) {
      ok = false;
      msg = friendlyError(err.message);
      this.log(`command ${cmd.id} failed: ${err.message}`);
    }
    if (ok !== null) this.results.push({ id: cmd.id, ok, msg: msg ? escapeWow(msg) : undefined });
    if (this.results.length > 12) this.results.splice(0, this.results.length - 12);
    this.markDirty('important');
  }

  // Dictation state travels to the addon in the snapshot (`dict`): listening,
  // transcribing, then done with the text, which the addon types into its box.
  setDictation(state, text, err) {
    this.dictation = { n: Math.max(Date.now(), (this.dictation?.n || 0) + 1), state, text: text || undefined, err: err ? escapeWow(err) : undefined };
    this.urgent = true; // the player is waiting on this: skip the usual pacing
    this.markDirty('important');
  }

  dictate(action) {
    const v = this.voice;
    const viaOmarchy = v.canOmarchyDictate();
    if (!viaOmarchy && !v.canTranscribe()) {
      throw new Error('no dictation backend; pick one in Omarchy > Setup > Defaults > Dictation');
    }
    if (action === 'start') {
      if (viaOmarchy) v.startOmarchy();
      else v.startRecording();
      this.setDictation('listening');
      return;
    }
    if (action === 'cancel') {
      if (viaOmarchy) v.cancelOmarchy();
      else v.cancelRecording();
      this.setDictation('cancelled');
      return;
    }
    if (viaOmarchy ? !v.omarchy : !v.recording) return;
    this.setDictation('transcribing');
    const started = Date.now();
    (viaOmarchy ? v.stopOmarchy() : v.stopAndTranscribe())
      .then((text) => {
        this.log(`dictation (${Date.now() - started} ms): ${text ? `"${text.slice(0, 80)}"` : '(nothing heard)'}`);
        this.setDictation(text ? 'done' : 'empty', text.replace(/\|/g, '/'));
      })
      .catch((err) => {
        this.log(`dictation failed: ${err.message}`);
        this.setDictation('error', null, err.message);
      });
  }

  // Upload the screenshots held for `key` to the machine that owns `routeKey`.
  async takeShots(key, routeKey) {
    const list = this.shots.get(key);
    if (!list?.length) return [];
    this.shots.delete(key);
    const out = [];
    for (const img of list) out.push(await this.t3.uploadImage(routeKey, img.data, img.name, img.mime));
    return out;
  }

  async speechFor(threadId, which) {
    const t = this.t3.threads.get(threadId);
    const proj = await this.projection(threadId);
    let text = lastAssistantText(proj);
    if (which === 'plan') {
      text = proposedPlan(proj);
    } else if (which && which !== 'last') {
      const msgs = (proj?.messages || []).filter((m) => m.text);
      const m = msgs[Number(which) - 1];
      if (m) text = m.text;
    }
    if (!text) return null;
    return (t?.title ? `${t.title}. ` : '') + markdownToSpeech(text);
  }

  // ---------------------------------------------------------------------------
  // Thread detail

  async projection(threadId) {
    const v = this.views.get(threadId);
    if (v?.projection && Date.now() - v.fetchedAt < 1500) return v.projection;
    await this.refreshView(threadId, true);
    return this.views.get(threadId)?.projection;
  }

  refreshView(threadId, force = false) {
    let v = this.views.get(threadId);
    if (!v) {
      v = { projection: null, fetchedAt: 0, inflight: null, again: false };
      this.views.set(threadId, v);
    }
    const minGap = threadId === this.client?.view ? 1200 : 5000;
    if (v.inflight) {
      v.again = true;
      return v.inflight;
    }
    const wait = force ? 0 : Math.max(0, minGap - (Date.now() - v.fetchedAt));
    v.inflight = new Promise((r) => setTimeout(r, wait))
      .then(() => this.t3.threadProjection(threadId))
      .then((p) => {
        const prevLabel = activityLabel(v.projection);
        const prevContent = v.contentKey;
        v.projection = p;
        v.fetchedAt = Date.now();
        // Messages, questions and plans are worth a quick update; a new activity
        // label alone ("Thinking" -> "Running ls") can wait for the slower pace.
        const msgs = p.messages || [];
        const last = msgs.at(-1);
        v.contentKey = [msgs.length, last?.text?.length, last?.updatedAt, pendingRequest(p)?.id, proposedPlan(p)?.length, (p.runs || []).filter((r) => r.status === 'queued').length].join('|');
        if (threadId === this.client?.view) this.markDirty(v.contentKey !== prevContent ? 'view' : 'minor');
        else if (activityLabel(p) !== prevLabel) this.markDirty('minor');
      })
      .catch((err) => this.log(`thread ${threadId.slice(0, 8)}: ${err.message}`))
      .finally(() => {
        v.inflight = null;
        if (v.again) {
          v.again = false;
          this.refreshView(threadId);
        }
      });
    // Forget details of threads nobody looks at.
    if (this.views.size > 24) {
      for (const [id] of this.views) {
        if (id !== this.client?.view && this.views.size > 16) this.views.delete(id);
      }
    }
    return v.inflight;
  }

  onT3Change(ev) {
    if (ev.kind === 'thread') {
      const t = ev.thread;
      const status = threadStatus(t);
      const before = ev.prev ? threadStatus(ev.prev) : this.prevStatus.get(t.id);
      this.prevStatus.set(t.id, status);
      if (t.id === this.client?.view) this.refreshView(t.id);
      else if (ACTIVE.has(status)) this.refreshView(t.id);
      if (before !== status) {
        this.markDirty('important');
        if (before === 'working' && status !== 'working') this.announce(t, status);
        else if (status === 'input' && before !== 'input') this.announce(t, status);
      } else {
        this.markDirty('minor');
      }
    } else {
      if (ev.kind === 'snapshot') {
        for (const t of this.t3.threads.values()) {
          this.prevStatus.set(t.id, threadStatus(t));
          if (ACTIVE.has(threadStatus(t))) this.refreshView(t.id);
        }
      }
      this.markDirty('important');
    }
  }

  // Read finished replies aloud when the player asked for it (flag "r").
  async announce(thread, status) {
    if (!this.client?.flags.includes('r')) return;
    if (this.client.flags.includes('q')) {
      this.deferredAnnounce = { thread, status };
      return;
    }
    try {
      if (status === 'input') {
        const proj = await this.projection(thread.id);
        const p = pendingRequest(proj);
        const q = p?.kind === 'question' ? p.questions[0]?.q : p?.what;
        this.voice.speak(`${thread.title} needs your input. ${q ? markdownToSpeech(q.replace(/\|\|/g, '|')) : ''}`);
      } else {
        const proj = await this.projection(thread.id);
        const text = lastAssistantText(proj);
        this.voice.speak(`${thread.title} ${status === 'failed' ? 'failed' : 'finished'}. ${text ? markdownToSpeech(text, { maxChars: 600 }) : ''}`);
      }
    } catch (err) {
      this.log(`announce: ${err.message}`);
    }
  }

  usageInstances() {
    return (this.t3.config?.providers || []).filter((p) => p.enabled).map((p) => p.instanceId);
  }

  // ---------------------------------------------------------------------------
  // Snapshot

  buildSnapshot() {
    const t3 = this.t3;
    const projects = [];
    const usedProjects = new Set();
    let threads = [...t3.threads.values()]
      .map((t) => ({ t, s: threadStatus(t) }))
      .filter(({ s }) => s !== 'archived');
    threads.sort((a, b) => ORDER[a.s] - ORDER[b.s] || Date.parse(b.t.updatedAt) - Date.parse(a.t.updatedAt));
    let settled = 0;
    threads = threads.filter(({ s }) => s !== 'settled' || ++settled <= 30).slice(0, 90);
    const list = threads.map(({ t, s }) => {
      usedProjects.add(t.projectId);
      const v = this.views.get(t.id);
      const proj = v?.projection;
      let label;
      if (s === 'working') label = activityLabel(proj) || (t.status === 'queued' ? 'Queued' : 'Working');
      else if (s === 'input') label = t.pendingRuntimeRequest?.kind === 'user_input' ? 'Needs your answer' : 'Needs your approval';
      else if (s === 'plan') label = 'Plan ready';
      else if (s === 'failed') label = t.lastError ? `Failed: ${String(t.lastError).slice(0, 60)}` : 'Failed';
      else if (s === 'settled') label = 'Settled';
      else label = t.status === 'interrupted' ? 'Stopped' : 'Finished';
      const last = proj ? lastAssistantText(proj) : t.latestVisibleMessage?.role === 'assistant' ? t.latestVisibleMessage.text : null;
      return {
        id: t.id,
        title: escapeWow(t.title || 'Untitled'),
        p: t.projectId,
        s,
        l: escapeWow(label),
        // A working thread's update time changes with every tool call but isn't shown
        // (the game shows elapsed time), so leave it out to avoid pointless publishes.
        u: s === 'working' ? undefined : sec(t.updatedAt),
        st: sec(t.activityRunStartedAt || t.latestRunStartedAt),
        un: s !== 'settled' && isUnread(t) ? true : undefined,
        br: t.branch ? escapeWow(t.branch) : undefined,
        m: t.modelSelection?.model,
        env: t._env && !t._env.local ? escapeWow(t._env.label) : undefined,
        last: last && ACTIVE.has(s) === false && s !== 'settled' ? escapeWow(firstLine(last, 160)) : undefined,
      };
    });
    for (const p of t3.projects.values()) {
      if (p.archivedAt) continue;
      const remote = p._env && !p._env.local ? p._env.label : null;
      const name = p.title || p.repositoryIdentity?.displayName || 'Project';
      projects.push({
        id: p.id,
        name: escapeWow(remote ? `${name} · ${remote}` : name),
        env: remote ? escapeWow(remote) : undefined,
        act: usedProjects.has(p.id) || undefined,
      });
    }
    projects.sort((a, b) => (b.act ? 1 : 0) - (a.act ? 1 : 0) || a.name.localeCompare(b.name));

    let view;
    const viewId = this.client?.view;
    if (viewId) {
      const v = this.views.get(viewId);
      const t = t3.threads.get(viewId);
      if (v?.projection) {
        const p = v.projection;
        const msgs = (p.messages || []).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text?.trim());
        let budget = 60000;
        const out = [];
        for (let i = msgs.length - 1; i >= 0 && out.length < 40; i--) {
          const m = msgs[i];
          const text = markdownToWow(m.text, { maxChars: m.role === 'assistant' ? 4000 : 1500 });
          budget -= text.length;
          if (budget < 0 && out.length > 0) break;
          out.unshift({ r: m.role === 'user' ? 'u' : 'a', t: text, at: sec(m.createdAt), live: m.streaming || undefined, n: i + 1 });
        }
        view = {
          id: viewId,
          msgs: out,
          more: msgs.length > out.length || undefined,
          pending: pendingRequest(p) || undefined,
          act: t && threadStatus(t) === 'working' ? escapeWow(activityLabel(p) || 'Working') : undefined,
          err: t?.lastError ? escapeWow(String(t.lastError).slice(0, 300)) : undefined,
          plan: t && threadStatus(t) === 'plan' && proposedPlan(p) ? markdownToWow(proposedPlan(p), { maxChars: 6000 }) : undefined,
          sum: runSummary(p) ? escapeWow(runSummary(p)) : undefined,
          queued: (p.runs || []).filter((r) => r.status === 'queued').length || undefined,
          shots: this.shots.get(viewId)?.length || undefined,
        };
      } else {
        view = { id: viewId, loading: true };
      }
    }

    const usage = [];
    this.omarchyUsage.refresh(this.usageInstances());
    const enabled = (t3.config?.providers || []).filter((p) => p.enabled && (p.usageLimits || this.omarchyUsage.forInstance(p.instanceId)));
    for (const p of enabled) {
      usage.push(mergeUsage(p, this.omarchyUsage.forInstance(p.instanceId), { escape: escapeWow, sec }));
    }

    return {
      bridge: {
        version: VERSION,
        t3: t3.state,
        t3err: t3.error ? escapeWow(t3.error) : undefined,
        server: t3.config?.environment?.serverVersion,
        host: t3.config?.environment?.label,
        tts: this.voice.describe().tts || undefined,
        dictation: this.voice.describe().dictation || undefined,
        slots: this.bank.slots,
        envs: t3.envs.length > 1 ? t3.environments().map((e) => ({ label: escapeWow(e.label), state: e.state, local: e.local, n: e.threads })) : undefined,
      },
      projects,
      threads: list,
      older: t3.olderSettled || undefined,
      view,
      usage,
      dict: this.dictation,
      newShots: this.shots.get('new')?.length || undefined,
      results: this.results.slice(-8).map(({ id, ok, msg, open }) => ({ id, ok, msg, open })),
    };
  }

  // ---------------------------------------------------------------------------
  // Publishing

  markDirty(kind) {
    this.dirty[kind] = true;
    this.schedulePublish();
  }

  remainingSlots() {
    const next = this.client?.slotNext ?? this.persist.slotGuess ?? 1;
    const total = Math.min(this.bank.slots, this.client?.slotCount || this.bank.slots);
    return total - next + 1;
  }

  // When should the next publish happen? Slots are the scarce resource (one per
  // publish, a few hundred per UI session), so pace by what the player is doing.
  // How much to stretch non-urgent intervals as the session's slots run down.
  static budgetFactor(remaining, total) {
    const frac = remaining / Math.max(1, total);
    if (frac > 0.5) return 1;
    if (frac > 0.25) return 1.5;
    if (frac > 0.1) return 2.5;
    return 5;
  }

  // When should the next publish happen? Each publish costs the game one slot, so:
  //  * things the player is waiting on (acks, dictation, command results) go now;
  //  * a thread finishing or needing the player goes within a few seconds;
  //  * new reply text goes fast only while the player is actually reading (flag "a");
  //  * activity-label churn and keep-alives are slow, slower still as slots run low;
  //  * the last RESERVE slots are kept for acks and alerts only.
  nextPublishDelay() {
    const RESERVE = 20;
    const BATCH = 300; // let a burst of changes land in one update
    const c = this.client;
    const since = Date.now() - this.lastPublishAt;
    const open = c?.flags.includes('o');
    const attending = open && c.flags.includes('a');
    const total = Math.min(this.bank.slots, c?.slotCount || this.bank.slots);
    const remaining = this.remainingSlots();
    const needAck = c && c.ackedSeq !== c.seq;
    const resultsPending = this.results.some((r) => !r.sent);
    if (remaining <= 0) return null;
    if (this.urgent) return Math.max(0, 250 - since);
    if (needAck || resultsPending) return Math.max(0, 400 - since);
    const reserve = remaining <= RESERVE;
    const f = Bridge.budgetFactor(remaining, total);
    if (this.dirty.important) return Math.max(BATCH, (reserve ? 30000 : (attending ? 1000 : 3000) * f) - since);
    if (reserve) return null;
    if (this.dirty.view && open) return Math.max(BATCH, (attending ? 1500 : 5000) * f - since);
    if (this.dirty.minor) return Math.max(BATCH, (attending ? 5000 : open ? 15000 : 60000) * f - since);
    if (c) return Math.max(0, (open ? 90000 : 600000) - since); // keep-alive
    return null;
  }

  schedulePublish() {
    const delay = this.nextPublishDelay();
    if (delay === null) return;
    const due = Date.now() + delay;
    if (this.publishTimer && this.publishDue <= due) return;
    clearTimeout(this.publishTimer);
    this.publishDue = due;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publishNow();
      // Something may still be dirty (e.g. results) or a heartbeat is due later.
      if (this.client) this.schedulePublish();
    }, delay);
  }

  publishNow(reason) {
    if (!this.proc && !reason) return false;
    const snapshot = this.buildSnapshot();
    const digest = createHash('sha1').update(JSON.stringify(snapshot)).digest('hex');
    const c = this.client;
    const needAck = c && c.ackedSeq !== c.seq;
    const heartbeatDue = c && Date.now() - this.lastPublishAt > (c.flags.includes('o') ? 85000 : 595000);
    this.dirty = { important: false, minor: false, view: false };
    this.urgent = false;
    if (digest === this.lastDigest && !needAck && !heartbeatDue && !reason) return false;

    const gen = Math.max(Date.now(), this.lastGen + 1);
    // Signals: raise the next number in sequence, never skipping any. If the addon
    // is waiting on an earlier number (we restarted, say), raise that too. We never
    // ring ahead to an addon that claims to be past our counter: the fresh snapshot
    // this publish writes carries the real next bell, and ringing ahead would alias
    // bells that are still rung.
    const counter = this.persist.sigCounter;
    const toRaise = [];
    let sig = counter;
    // An addon that reports its sound signals don't work (flag "s") isn't listening.
    if (this.proc && !c?.flags.includes('s')) {
      for (let k = counter; k <= sig; k++) toRaise.push(k);
      // Waiting on an earlier bell (we restarted, say)? Bells are reusable: ring it too.
      if (c?.pollSig && c.pollSig < counter) toRaise.push(c.pollSig);
    }
    const raise = toRaise.length > 0;
    // Slots: write the snapshot to every slot from the addon's last confirmed position
    // to a little past our prediction, so whichever one it loads next is current
    // even if our prediction drifted (e.g. while the game window was hidden).
    let predicted = c?.slotNext ?? this.persist.slotGuess ?? 1;
    const confirmed = c?.confirmedSlot ?? this.persist.confirmedSlot ?? predicted;
    // Without sound signals the addon loads slots on its own timer (3s while the
    // player uses the window, 20s open, 90s closed), so advance our guess by clock.
    if (c?.flags.includes('s') && c.confirmedAt) {
      const every = c.flags.includes('a') ? 3000 : c.flags.includes('o') ? 20000 : 90000;
      predicted = Math.max(predicted, confirmed + Math.floor((Date.now() - c.confirmedAt) / every));
      c.slotNext = predicted;
    }
    let from = Math.max(1, Math.min(confirmed, predicted));
    const to = Math.min(this.bank.slots, Math.max(confirmed, predicted) + (c?.flags.includes('s') ? 8 : 4));
    if (to - from > 80) from = to - 80;
    const content = {
      v: 1,
      gen,
      now: Math.floor(Date.now() / 1000),
      nextSig: raise ? sig + 1 : counter,
      ack: c ? { ui: c.ui, seq: c.seq } : undefined,
      key: this.stripKeys.hex,
      ...snapshot,
    };
    const targets = new Set([1, 2, 3]);
    for (let i = from; i <= to; i++) targets.add(i);
    let bytes = 0;
    try {
      bytes = this.bank.write([...targets], content);
      if (raise) {
        for (const k of toRaise) this.bank.raise(k);
        this.persist.sigCounter = Math.max(counter, sig + 1);
        if (c) c.slotNext = predicted + 1;
        this.persist.slotGuess = predicted + 1;
      }
    } catch (err) {
      this.log(`publish failed: ${err.message}`);
      return false;
    }
    for (const r of this.results) r.sent = true;
    this.lastGen = gen;
    this.persist.gen = gen;
    this.lastDigest = digest;
    this.lastPublishAt = Date.now();
    if (c) c.ackedSeq = c.seq;
    this.saveState();
    this.publishCount = (this.publishCount || 0) + 1;
    if (this.config.verbose) this.log(`published gen ${gen} (${bytes} bytes) slots ${from}-${to} signals ${toRaise.join(',') || '-'}`);
    return true;
  }

  writeStatus() {
    const status = {
      version: VERSION,
      pid: process.pid,
      at: new Date().toISOString(),
      t3: { state: this.t3.state, error: this.t3.error, threads: this.t3.threads.size, origin: this.t3.origin, environments: this.t3.environments() },
      wow: this.proc ? { pid: this.proc.pid } : null,
      capture: { state: this.captureState, backend: this.capture.resolveBackend(), ...this.capture.stats, lastError: this.capture.lastError },
      addon: this.client
        ? { ui: this.client.ui, version: this.client.version, flags: this.client.flags, view: this.client.view, slotNext: this.client.slotNext, lastSeen: this.client.lastSeen, encrypted: !!this.client.encrypted }
        : null,
      slots: { total: this.bank.slots, remaining: this.remainingSlots() },
      signals: { next: this.persist.sigCounter },
      rejected: { forged: this.rejected.forged, plainCommands: this.rejected.plainCommands },
      publishes: this.publishCount || 0,
      voice: this.voice.describe(),
      log: this.logs.slice(-30),
    };
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(this.statusFile, JSON.stringify(status, null, 1));
    } catch {}
  }
}
