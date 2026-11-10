// Client for the running T3 Code server: the same WebSocket RPC (Effect RPC, JSON
// frames) and HTTP API the desktop, web and mobile clients use.
//
// Auth is a scoped session token minted by `t3 auth session issue` (see auth.js).
// Every reconnect re-reads ~/.t3/userdata/server-runtime.json, because the server
// moves when the app updates or restarts.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROTOCOL = 2;

export function t3Home() {
  return process.env.T3CODE_HOME || path.join(os.homedir(), '.t3');
}

export function readRuntime() {
  const file = path.join(t3Home(), 'userdata', 'server-runtime.json');
  const runtime = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!runtime.origin) throw new Error(`no origin in ${file}`);
  return runtime;
}

const WORKING = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);

// Collapse the server's thread fields into the handful the game needs.
export function threadStatus(t) {
  if (t.archivedAt || t.deletedAt) return 'archived';
  if (t.pendingRuntimeRequest) return 'input';
  if (t.activityRunStatus || WORKING.has(t.status)) return 'working';
  // Settled wins over an unreviewed plan: settling is how you say you're done with it.
  if (t.settledOverride === 'settled') return 'settled';
  if (t.hasActionableProposedPlan) return 'plan';
  if (t.status === 'failed' || t.lastError) return 'failed';
  return 'open';
}

export function isUnread(t) {
  const done = t.latestRunCompletedAt ? Date.parse(t.latestRunCompletedAt) : 0;
  const seen = t.lastVisitedAt ? Date.parse(t.lastVisitedAt) : 0;
  return done > seen;
}

// The model for a new thread: the project's or T3's default, T3's fallback, or else
// the model of the latest thread in the project, then anywhere. T3 leaves the defaults
// empty until someone picks one, and its own composer reuses the last model instead.
// Models whose provider is switched off are skipped.
export function pickModelSelection({ project, settings = {}, threads = [], providers } = {}) {
  const enabled = (sel) => sel?.model && (!providers || providers.some((p) => p.instanceId === sel.instanceId && p.enabled));
  for (const sel of [project?.defaultModelSelection, settings.defaultModelSelection, settings.fallbackModelSelection]) {
    if (enabled(sel)) return sel;
  }
  const latest = threads
    .filter((t) => !t.deletedAt && enabled(t.modelSelection))
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  return (latest.find((t) => project && t.projectId === project.id) || latest[0])?.modelSelection || null;
}

// The models the game offers: every switched-on provider's current models, in T3's
// order. Legacy models are left out to keep the list short; a thread already on one
// still shows it.
export function modelChoices(providers = []) {
  const out = [];
  for (const p of providers || []) {
    if (!p?.enabled || !Array.isArray(p.models)) continue;
    for (const m of p.models) {
      if (!m?.slug || m.isLegacy) continue;
      out.push({ instanceId: p.instanceId, model: m.slug, name: m.name || m.slug, provider: p.displayName || p.instanceId, effort: effortLevels(m) });
    }
  }
  return out;
}

// The option that sets how hard a model reasons. Each provider names it its own way
// (Codex "reasoningEffort", Claude "effort", OpenCode "variant").
const EFFORT_IDS = new Set(['reasoningEffort', 'effort', 'variant']);

function effortDescriptor(model) {
  return model?.capabilities?.optionDescriptors?.find((d) => d?.type === 'select' && EFFORT_IDS.has(d.id) && Array.isArray(d.options));
}

// A model's reasoning levels as { id, options: [{ id, label }], default }, or
// undefined when it has none. Levels that only work typed into a prompt
// (Claude's "ultrathink") are left out.
export function effortLevels(model) {
  const d = effortDescriptor(model);
  if (!d) return undefined;
  const injected = new Set(d.promptInjectedValues || []);
  const options = d.options.filter((o) => o?.id && !injected.has(o.id)).map((o) => ({ id: o.id, label: o.label || o.id.charAt(0).toUpperCase() + o.id.slice(1) }));
  if (!options.length) return undefined;
  const def = d.options.find((o) => o.isDefault && !injected.has(o.id))?.id ?? d.currentValue;
  return { id: d.id, options, default: options.some((o) => o.id === def) ? def : options[0].id };
}

// The reasoning level a selection carries, if any.
export function effortOf(selection) {
  return selection?.options?.find((o) => EFFORT_IDS.has(o.id))?.value;
}

// `selection` with its reasoning level set to `effort` (a level id).
export function withEffort(selection, effort, providers) {
  if (!effort) return selection;
  const model = providers?.find((p) => p.instanceId === selection.instanceId)?.models?.find((m) => m.slug === selection.model);
  const name = model?.name || selection.model;
  const levels = effortLevels(model);
  if (!levels) throw new Error(`${name} has no reasoning levels to pick from.`);
  if (!levels.options.some((o) => o.id === effort)) throw new Error(`${name} doesn't offer ${effort} reasoning. Pick another level.`);
  const options = (selection.options || []).filter((o) => o.id !== levels.id);
  return { ...selection, options: [...options, { id: levels.id, value: effort }] };
}

// A model the player picked in the game, as a full selection. Its options (reasoning
// effort and the like) come from `candidates` (the selection T3 would have used, or
// the thread's current one) when that is the same model, else from the latest thread
// on it, so picking a model keeps what was last chosen for it in T3. With neither, T3
// applies the model's defaults.
export function chosenModelSelection({ instanceId, model }, { providers, candidates = [], threads = [] } = {}) {
  if (!instanceId || !model) throw new Error('no model picked');
  const provider = providers?.find((p) => p.instanceId === instanceId);
  if (providers && !provider?.enabled) throw new Error(`${provider?.displayName || instanceId} is switched off in T3 Code. Pick another model.`);
  if (Array.isArray(provider?.models) && !provider.models.some((m) => m.slug === model)) {
    throw new Error(`${provider.displayName || instanceId} no longer offers ${model}. Pick another model.`);
  }
  const same = (sel) => sel?.instanceId === instanceId && sel?.model === model;
  let options = candidates.find(same)?.options;
  if (!options) {
    // Latest by activity, the order the game sees threads in, so its picker shows
    // the level this carries over.
    const active = (t) => Date.parse(t.activityRunStartedAt || t.latestRunStartedAt || t.updatedAt || t.createdAt || 0);
    const latest = threads
      .filter((t) => !t.deletedAt && same(t.modelSelection))
      .sort((a, b) => active(b) - active(a))[0];
    options = latest?.modelSelection.options;
  }
  return options ? { instanceId, model, options } : { instanceId, model };
}

export class T3Client extends EventEmitter {
  constructor({ tokenProvider, log = () => {}, originProvider = null, label = 'local' }) {
    super();
    this.tokenProvider = tokenProvider;
    // Where the server is: this machine's runtime file by default, or a function
    // that finds a remote machine's address.
    this.originProvider = originProvider || (async () => readRuntime().origin);
    this.label = label;
    this.log = log;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map(); // requestId -> { resolve, reject, chunks, onChunk }
    this.threads = new Map();
    this.projects = new Map();
    this.olderSettled = 0;
    this.config = null;
    this.state = 'disconnected';
    this.error = null;
    this.backoff = 1000;
    this.stopped = false;
    this.origin = null;
  }

  setState(state, error = null) {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.emit('state', state, error);
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {}
  }

  async connect() {
    if (this.stopped) return;
    this.setState('connecting');
    try {
      this.origin = await this.originProvider();
      const runtime = { origin: this.origin };
      const token = await this.tokenProvider();
      const res = await fetch(new URL('/api/auth/websocket-ticket/rpc', runtime.origin), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        this.emit('unauthorized');
        throw new Error(`${this.label}: T3 rejected the bridge token (401)`);
      }
      if (!res.ok) throw new Error(`websocket ticket: HTTP ${res.status}`);
      const { ticket } = await res.json();
      const url = new URL('/ws', runtime.origin.replace(/^http/, 'ws'));
      url.searchParams.set('orchestrationProtocol', String(PROTOCOL));
      url.searchParams.set('wsTicket', ticket);
      await this.open(url);
    } catch (err) {
      this.setState('offline', err.message);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 15000);
    setTimeout(() => this.connect(), delay);
  }

  open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.backoff = 1000;
        this.setState('connected');
        this.subscribeAll();
        resolve();
      };
      ws.onmessage = (ev) => this.onMessage(ev.data);
      ws.onerror = (ev) => {
        if (!opened) reject(new Error(ev.message || 'websocket error'));
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        for (const p of this.pending.values()) p.reject?.(new Error('connection closed'));
        this.pending.clear();
        if (opened) {
          this.setState('offline', 'connection closed');
          this.scheduleReconnect();
        }
      };
    });
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('not connected to T3');
    this.ws.send(JSON.stringify(obj));
  }

  onMessage(data) {
    let msgs;
    try {
      msgs = [].concat(JSON.parse(data));
    } catch {
      return;
    }
    for (const m of msgs) {
      if (m._tag === 'Ping') {
        try {
          this.send({ _tag: 'Pong' });
        } catch {}
        continue;
      }
      const p = this.pending.get(m.requestId);
      if (!p) continue;
      if (m._tag === 'Chunk') {
        try {
          this.send({ _tag: 'Ack', requestId: m.requestId });
        } catch {}
        for (const v of m.values || []) {
          if (p.onChunk) p.onChunk(v);
          else p.chunks.push(v);
        }
      } else if (m._tag === 'Exit') {
        this.pending.delete(m.requestId);
        if (m.exit?._tag === 'Success') p.resolve(m.exit.value ?? p.chunks);
        else p.reject(new Error(describeFailure(m.exit)));
      } else if (m._tag === 'Defect') {
        this.pending.delete(m.requestId);
        p.reject(new Error(`T3 defect: ${JSON.stringify(m.defect).slice(0, 200)}`));
      }
    }
  }

  request(tag, payload, { onChunk, timeout = 20000 } = {}) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, chunks: [], onChunk };
      this.pending.set(id, entry);
      if (!onChunk && timeout) {
        const t = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`${tag} timed out`));
        }, timeout);
        entry.resolve = (v) => {
          clearTimeout(t);
          resolve(v);
        };
        entry.reject = (e) => {
          clearTimeout(t);
          reject(e);
        };
      }
      try {
        this.send({ _tag: 'Request', id, tag, payload, headers: [] });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  subscribeAll() {
    this.request(
      'orchestration.subscribeShell',
      { omitIdleSubagents: true, omitOlderSettled: true },
      { onChunk: (v) => this.onShell(v), timeout: 0 },
    ).catch((err) => this.log(`shell subscription ended: ${err.message}`));
    this.request('subscribeServerConfig', {}, { onChunk: (v) => this.onConfig(v), timeout: 0 }).catch((err) =>
      this.log(`config subscription ended: ${err.message}`),
    );
  }

  onShell(item) {
    if (!item || typeof item !== 'object') return;
    if (item.kind === 'snapshot') {
      const snap = item.snapshot || {};
      // Follow-up snapshot frames can carry only projects (threads: []): keep threads.
      if (Array.isArray(snap.threads) && snap.threads.length > 0) {
        this.threads.clear();
        for (const t of snap.threads) if (!t.lineage?.parentThreadId) this.threads.set(t.id, t);
      }
      if (Array.isArray(snap.projects)) for (const p of snap.projects) this.projects.set(p.id, p);
      if (typeof snap.olderSettled === 'number') this.olderSettled = snap.olderSettled;
      else if (Array.isArray(snap.olderSettled?.counts)) {
        this.olderSettled = snap.olderSettled.counts.reduce((n, c) => n + (c.count || 0), 0);
      }
      this.emit('change', { kind: 'snapshot' });
    } else if (item.kind === 'thread.updated') {
      const t = item.thread;
      if (!t || t.lineage?.parentThreadId) return;
      const prev = this.threads.get(t.id);
      this.threads.set(t.id, t);
      if (!prev || prev.updatedAt !== t.updatedAt || threadStatus(prev) !== threadStatus(t)) {
        this.emit('change', { kind: 'thread', id: t.id, prev, thread: t });
      }
    } else if (item.kind === 'thread.removed') {
      const id = item.threadId || item.id || item.thread?.id;
      if (id && this.threads.delete(id)) this.emit('change', { kind: 'removed', id });
    } else if (item.kind === 'project.updated') {
      if (item.project) this.projects.set(item.project.id, item.project);
      this.emit('change', { kind: 'project' });
    } else if (item.kind === 'project.removed') {
      const id = item.projectId || item.id || item.project?.id;
      if (id) this.projects.delete(id);
      this.emit('change', { kind: 'project' });
    }
  }

  onConfig(item) {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'snapshot' && item.config) {
      this.config = item.config;
    } else if (this.config && item.config) {
      this.config = { ...this.config, ...item.config };
    } else if (this.config && item.providers) {
      this.config.providers = item.providers;
    } else if (this.config && item.payload?.providers) {
      this.config.providers = item.payload.providers;
    }
    this.emit('config');
  }

  // ---- reads ---------------------------------------------------------------

  async http(pathname) {
    const token = await this.tokenProvider();
    const res = await fetch(new URL(pathname, this.origin || (await this.originProvider())), {
      headers: { authorization: `Bearer ${token}`, 'x-t3-orchestration-protocol': String(PROTOCOL) },
    });
    if (!res.ok) throw new Error(`${pathname}: HTTP ${res.status}`);
    return res.json();
  }

  threadProjection(threadId) {
    return this.http(`/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`).then((d) => d.projection);
  }

  // ---- writes --------------------------------------------------------------

  dispatch(command) {
    return this.request('orchestration.dispatchCommand', { commandId: randomUUID(), ...command });
  }

  sendMessage(threadId, text, mode = 'auto', attachments = []) {
    const t = this.threads.get(threadId);
    const busy = t && threadStatus(t) === 'working';
    let dispatchMode = { type: 'start_immediately' };
    if (mode === 'steer' && t?.activeRunId) dispatchMode = { type: 'steer_active', targetRunId: t.activeRunId };
    else if (busy) dispatchMode = { type: 'queue_after_active' };
    return this.dispatch({
      type: 'message.dispatch',
      threadId,
      messageId: randomUUID(),
      text,
      attachments,
      createdBy: 'user',
      creationSource: 'web',
      dispatchMode,
    });
  }

  // The model a new thread in `projectId` gets when the player doesn't pick one.
  defaultModelFor(projectId) {
    return pickModelSelection({
      project: this.projects.get(projectId),
      settings: this.config?.settings || {},
      threads: [...this.threads.values()],
      providers: this.config?.providers,
    });
  }

  // opts: { title, model ({ instanceId, model }), effort (a reasoning level id), runtimeMode ('full-access' | 'approval-required' | ...), interactionMode ('default' | 'plan') }
  launchThread(projectId, text, attachments = [], opts = {}) {
    const settings = this.config?.settings || {};
    const auto = this.defaultModelFor(projectId);
    const providers = this.config?.providers;
    let modelSelection = opts.model
      ? chosenModelSelection(opts.model, { providers, candidates: [auto], threads: [...this.threads.values()] })
      : auto;
    if (!modelSelection) throw new Error('No model to start a thread with. Pick a default model in T3 Code settings, or start one thread there first.');
    modelSelection = withEffort(modelSelection, opts.effort, providers);
    const firstLine = text.split('\n')[0].trim();
    const title = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine || 'New thread';
    return this.request('orchestration.launchThread', {
      commandId: randomUUID(),
      creationSource: 'web',
      projectId,
      title: opts.title || title,
      generateTitle: !opts.title,
      modelSelection,
      runtimeMode: opts.runtimeMode || settings.defaultRuntimeMode || 'full-access',
      interactionMode: opts.interactionMode || 'default',
      workspaceStrategy: { type: 'root' },
      initialMessage: { messageId: randomUUID(), text, attachments },
    }, { timeout: 60000 });
  }

  // Upload an image the way the T3 app does: ask for a signed upload URL, POST the
  // bytes there, then reference the attachment id in the message.
  async uploadImage(data, name, mimeType) {
    const { attachmentId, relativeUrl } = await this.request('attachments.createUploadUrl', {
      type: 'image',
      name,
      mimeType,
      sizeBytes: data.length,
    });
    const res = await fetch(new URL(relativeUrl, this.origin), {
      method: 'POST',
      headers: { 'content-type': mimeType, 'content-length': String(data.length) },
      body: data,
    });
    if (!res.ok) throw new Error(`screenshot upload failed: HTTP ${res.status}`);
    return { type: 'image', id: attachmentId, name, mimeType, sizeBytes: data.length };
  }

  interrupt(threadId) {
    const t = this.threads.get(threadId);
    if (!t?.activeRunId) throw new Error('nothing is running in that thread');
    return this.dispatch({ type: 'run.interrupt', threadId, runId: t.activeRunId, holdQueue: true });
  }

  respondApproval(threadId, requestId, decision) {
    return this.dispatch({ type: 'runtime-request.respond', threadId, requestId, decision });
  }

  respondAnswers(threadId, requestId, answers) {
    return this.dispatch({ type: 'runtime-request.respond', threadId, requestId, answers });
  }

  // Switch a thread to another model; T3 uses it from the next run on.
  setModel(threadId, instanceId, model, effort) {
    const t = this.threads.get(threadId);
    if (!t) throw new Error('that thread is gone');
    const providers = this.config?.providers;
    const modelSelection = withEffort(
      chosenModelSelection({ instanceId, model }, { providers, candidates: [t.modelSelection], threads: [...this.threads.values()] }),
      effort,
      providers,
    );
    return this.dispatch({ type: 'thread.model-selection.set', threadId, modelSelection });
  }

  settle(threadId) {
    return this.dispatch({ type: 'thread.settle', threadId });
  }

  unsettle(threadId) {
    return this.dispatch({ type: 'thread.unsettle', threadId, reason: 'user' });
  }

  archive(threadId) {
    return this.dispatch({ type: 'thread.archive', threadId });
  }

  visit(threadId) {
    return this.dispatch({ type: 'thread.visit', threadId, visitedAt: new Date().toISOString() });
  }
}

function describeFailure(exit) {
  const cause = exit?.cause;
  const first = Array.isArray(cause) ? cause[0] : cause;
  const err = first?.error || first?.defect || first;
  if (!err) return 'T3 request failed';
  return err.message || err.reason || err._tag || JSON.stringify(err).slice(0, 200);
}
