// Several T3 Code machines behind the single-client interface the bridge uses.
//
// Thread and project ids are made unique across machines: the local machine keeps
// raw ids (so existing views and saved state stay valid), other machines' ids get
// a short prefix ("e1~<id>"). Every thread/project object handed out is a shallow
// copy with `id`/`projectId` rewritten and `_env` pointing at its machine.

import { EventEmitter } from 'node:events';
import { T3Client, modelChoices } from './t3.js';
import { remoteTokenProvider, remoteOriginProvider } from './envs.js';

const SEP = '~';

export class Fleet extends EventEmitter {
  constructor({ localTokens, environments = [], log = () => {} }) {
    super();
    this.log = log;
    this.envs = [];
    this.threads = new Map();
    this.projects = new Map();
    const local = { code: '', id: 'local', label: 'local', local: true };
    local.client = new T3Client({ tokenProvider: localTokens, log, label: 'local' });
    local.tokens = localTokens;
    this.envs.push(local);
    for (const e of environments) {
      if (e.disabled) continue;
      const env = { code: e.code, id: e.id, label: e.label, local: false, config: e };
      env.tokens = remoteTokenProvider(e, { log, label: 'WoW bridge' });
      env.client = new T3Client({ tokenProvider: env.tokens, originProvider: remoteOriginProvider(e), log, label: e.label });
      this.envs.push(env);
    }
    for (const env of this.envs) this.wire(env);
  }

  get local() {
    return this.envs[0];
  }

  key(env, id) {
    return env.code ? `${env.code}${SEP}${id}` : id;
  }

  split(key) {
    const k = String(key || '');
    const i = k.indexOf(SEP);
    if (i > 0) {
      const env = this.envs.find((e) => e.code === k.slice(0, i));
      if (env) return { env, id: k.slice(i + 1) };
    }
    return { env: this.local, id: k };
  }

  wrapThread(env, t) {
    return { ...t, id: this.key(env, t.id), projectId: this.key(env, t.projectId), _env: env };
  }

  wrapProject(env, p) {
    return { ...p, id: this.key(env, p.id), _env: env };
  }

  rebuild(env) {
    for (const [k, t] of this.threads) if (t._env === env) this.threads.delete(k);
    for (const [k, p] of this.projects) if (p._env === env) this.projects.delete(k);
    for (const t of env.client.threads.values()) {
      const w = this.wrapThread(env, t);
      this.threads.set(w.id, w);
    }
    for (const p of env.client.projects.values()) {
      const w = this.wrapProject(env, p);
      this.projects.set(w.id, w);
    }
  }

  wire(env) {
    const c = env.client;
    c.on('state', (s, e) => {
      if (!env.local) this.log(`${env.label}: ${s}${e ? ` (${e})` : ''}`);
      this.emit('state', this.state, this.error, env);
    });
    c.on('unauthorized', () => env.tokens.invalidate?.());
    c.on('config', () => this.emit('config', env));
    c.on('change', (ev) => {
      if (ev.kind === 'thread') {
        const thread = this.wrapThread(env, ev.thread);
        this.threads.set(thread.id, thread);
        this.emit('change', { kind: 'thread', id: thread.id, thread, prev: ev.prev ? this.wrapThread(env, ev.prev) : undefined, env });
      } else if (ev.kind === 'removed') {
        this.threads.delete(this.key(env, ev.id));
        this.emit('change', { kind: 'removed', id: this.key(env, ev.id), env });
      } else {
        this.rebuild(env);
        this.emit('change', { kind: ev.kind, env });
      }
    });
    // A machine that drops off takes its threads with it.
    c.on('state', (s) => {
      if (s === 'offline' && !env.local) {
        for (const [k, t] of this.threads) if (t._env === env) this.threads.delete(k);
        for (const [k, p] of this.projects) if (p._env === env) this.projects.delete(k);
        this.emit('change', { kind: 'snapshot', env });
      }
    });
  }

  start() {
    for (const env of this.envs) env.client.start();
  }

  stop() {
    for (const env of this.envs) env.client.stop();
  }

  // The local machine decides "connected" for the link indicator; others report
  // separately in `environments()`.
  get state() {
    return this.local.client.state;
  }

  get error() {
    return this.local.client.error;
  }

  get origin() {
    return this.local.client.origin;
  }

  get config() {
    return this.local.client.config;
  }

  get olderSettled() {
    return this.envs.reduce((n, e) => n + (e.client.olderSettled || 0), 0);
  }

  environments() {
    return this.envs.map((e) => ({
      code: e.code,
      label: e.local ? e.client.config?.environment?.label || 'this computer' : e.label,
      local: e.local || undefined,
      state: e.client.state,
      error: e.client.error || undefined,
      threads: e.client.threads.size,
    }));
  }

  // ---- reads and writes, routed by id ------------------------------------------

  threadProjection(key) {
    const { env, id } = this.split(key);
    return env.client.threadProjection(id);
  }

  sendMessage(key, text, mode, attachments) {
    const { env, id } = this.split(key);
    return env.client.sendMessage(id, text, mode, attachments);
  }

  uploadImage(key, data, name, mime) {
    const { env } = this.split(key);
    return env.client.uploadImage(data, name, mime);
  }

  async launchThread(projectKey, text, attachments, opts) {
    const { env, id } = this.split(projectKey);
    const res = await env.client.launchThread(id, text, attachments, opts);
    if (res?.threadId) res.threadId = this.key(env, res.threadId);
    return res;
  }

  interrupt(key) {
    const { env, id } = this.split(key);
    return env.client.interrupt(id);
  }

  respondApproval(key, requestId, decision) {
    const { env, id } = this.split(key);
    return env.client.respondApproval(id, requestId, decision);
  }

  respondAnswers(key, requestId, answers) {
    const { env, id } = this.split(key);
    return env.client.respondAnswers(id, requestId, answers);
  }

  settle(key) {
    const { env, id } = this.split(key);
    return env.client.settle(id);
  }

  unsettle(key) {
    const { env, id } = this.split(key);
    return env.client.unsettle(id);
  }

  archive(key) {
    const { env, id } = this.split(key);
    return env.client.archive(id);
  }

  visit(key) {
    const { env, id } = this.split(key);
    return env.client.visit(id);
  }

  setModel(key, instanceId, model, effort) {
    const { env, id } = this.split(key);
    return env.client.setModel(id, instanceId, model, effort);
  }

  defaultModelFor(projectKey) {
    const { env, id } = this.split(projectKey);
    return env.client.defaultModelFor(id);
  }

  // Each machine's models, keyed by its id prefix ('' for this one).
  modelGroups() {
    return this.envs.map((env) => ({ code: env.code, choices: modelChoices(env.client.config?.providers) }));
  }
}
