#!/usr/bin/env node
// t3code-wow: install and run the T3 Code bridge for World of Warcraft: Forever.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bridge, STATE_DIR, VERSION } from '../src/bridge.js';
import { CONFIG_DIR, mintToken, readToken, tokenClaims, findT3Cli } from '../src/auth.js';
import { findWowInstalls, addonsDir as addonsDirOf, findWowProcess } from '../src/wow.js';
import { SlotBank, ADDON, CTL_LONG } from '../src/slots.js';
import { StripCapture, SCREEN_PERMISSION_HELP, MAC_HELPER_NAME, installMacHelper, removeMacHelper, macHelperPath } from '../src/capture.js';
import { decodeImage } from '../src/codec.js';
import { identify, discoverTailscale, mintRemote, revokeRemote, saveToken, readTokenData, tokenFile } from '../src/envs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, '..');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const MAC = process.platform === 'darwin';
const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 't3code-wow');
const BIN_LINK = path.join(os.homedir(), '.local/bin/t3code-wow');
const DEFAULT_SLOTS = 1200;

const C = process.stdout.isTTY
  ? { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` }
  : { b: String, g: String, y: String, r: String, d: String };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

// The addon ships next to the bridge (repo layout) or inside it (installed layout).
function addonSource() {
  for (const p of [path.join(BRIDGE_ROOT, '..', 'addon', ADDON), path.join(BRIDGE_ROOT, 'addon', ADDON)]) {
    if (fs.existsSync(path.join(p, `${ADDON}.toc`))) return p;
  }
  throw new Error('could not find the addon sources next to the bridge');
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function resolveWowDir(args, cfg) {
  if (args.wow) {
    const dir = path.resolve(String(args.wow));
    if (fs.existsSync(path.join(dir, '_forever_'))) return path.join(dir, '_forever_');
    return dir;
  }
  if (cfg.wowDir && fs.existsSync(cfg.wowDir)) return cfg.wowDir;
  const { forever, wowOnly, prefixes } = findWowInstalls();
  if (forever.length > 1) console.log(C.y(`Found several WoW: Forever installs, using the first (pick one with --wow):\n  ${forever.join('\n  ')}`));
  if (forever.length) return forever[0];
  const where = '\nIf it\'s somewhere else, pass --wow "/path/to/World of Warcraft".';
  if (wowOnly.length) {
    throw new Error(`found World of Warcraft at ${wowOnly[0]}, but not WoW: Forever. Install Forever from Battle.net (it's a separate game version), launch it once, then run ./install.sh again.${where}`);
  }
  if (prefixes.length) {
    throw new Error(`found Battle.net (${prefixes[0]}) but no World of Warcraft. Install WoW: Forever from Battle.net, launch it once, then run ./install.sh again.${where}`);
  }
  if (MAC) throw new Error(`couldn't find World of Warcraft. Install Battle.net from blizzard.com, install WoW: Forever from it and launch it once, then run ./install.sh again.${where}`);
  throw new Error(`couldn't find Battle.net. On Omarchy, install it with omarchy-install-gaming-battlenet, install WoW: Forever from it and launch it once, then run ./install.sh again.${where}`);
}

// The bridge runs as a systemd user service on Linux and a launchd agent on macOS.
// Commands are quiet unless they fail (enabling prints "Created symlink …", which isn't news).
function quiet(cmd, args, { warn = true } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0 && warn) process.stderr.write(r.stderr || `${cmd} ${args.join(' ')} failed\n`);
  return r.status === 0;
}

// On macOS, the launch agent runs the `node` found on PATH, such as Homebrew's
// /opt/homebrew/bin/node, rather than the versioned folder that link points to.
// `brew upgrade node` deletes the old versioned folder, and the agent would then fail
// to start at the next login.
function bridgeCommand() {
  const linked = (process.env.PATH || '').split(':').map((dir) => path.join(dir, 'node')).find((p) => {
    try {
      return fs.realpathSync(p) === process.execPath;
    } catch {
      return false;
    }
  });
  return [(MAC && linked) || process.execPath, path.join(BRIDGE_ROOT, 'bin', 't3code-wow.js'), 'run'];
}

const systemd = {
  name: 't3code-wow.service',
  file: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd/user', 't3code-wow.service'),
  kind: 'user service',
  install() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, [
      '[Unit]',
      'Description=T3 Code bridge for World of Warcraft',
      'After=graphical-session.target',
      '',
      '[Service]',
      `ExecStart=${bridgeCommand().join(' ')}`,
      'Restart=always',
      'RestartSec=3',
      `Environment=PATH=${process.env.PATH}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'));
    quiet('systemctl', ['--user', 'daemon-reload']);
    quiet('systemctl', ['--user', 'enable', this.name]);
    return quiet('systemctl', ['--user', 'restart', this.name]);
  },
  restart() {
    quiet('systemctl', ['--user', 'restart', this.name]);
  },
  remove() {
    quiet('systemctl', ['--user', 'disable', '--now', this.name], { warn: false });
    fs.rmSync(this.file, { force: true });
    quiet('systemctl', ['--user', 'daemon-reload'], { warn: false });
  },
};

const launchd = {
  name: 't3code-wow',
  file: path.join(os.homedir(), 'Library/LaunchAgents/t3code-wow.plist'),
  kind: 'launch agent',
  target: () => `gui/${process.getuid()}`,
  install() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const str = (v) => `<string>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>`;
    fs.writeFileSync(this.file, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      `  <key>Label</key>${str(this.name)}`,
      `  <key>ProgramArguments</key><array>${bridgeCommand().map(str).join('')}</array>`,
      `  <key>EnvironmentVariables</key><dict><key>PATH</key>${str(process.env.PATH)}</dict>`,
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><true/>',
      '  <key>ThrottleInterval</key><integer>3</integer>',
      '  <key>ProcessType</key><string>Interactive</string>',
      `  <key>StandardOutPath</key>${str(path.join(STATE_DIR, 'bridge.log'))}`,
      `  <key>StandardErrorPath</key>${str(path.join(STATE_DIR, 'bridge.log'))}`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n'));
    // Reload so a changed plist (a new node path, say) takes effect.
    quiet('launchctl', ['bootout', `${this.target()}/${this.name}`], { warn: false });
    if (quiet('launchctl', ['bootstrap', this.target(), this.file], { warn: false })) return true;
    // bootout can still be finishing ("Bootstrap failed: 5"); only the retry's error is worth showing.
    spawnSync('sleep', ['1']);
    return quiet('launchctl', ['bootstrap', this.target(), this.file]);
  },
  restart() {
    quiet('launchctl', ['kickstart', '-k', `${this.target()}/${this.name}`]);
  },
  remove() {
    quiet('launchctl', ['bootout', `${this.target()}/${this.name}`], { warn: false });
    fs.rmSync(this.file, { force: true });
  },
};

const service = MAC ? launchd : systemd;

// Copy just the addon code (leaving Signals/ and generated media alone).
function syncAddon(addonsDir) {
  const src = addonSource();
  const dst = path.join(addonsDir, ADDON);
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'Signals') continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
  return dst;
}

async function cmdInstall(args) {
  const cfg = readConfig();
  const wowDir = resolveWowDir(args, cfg);
  const addonsDir = addonsDirOf(wowDir);
  console.log(`${C.b('World of Warcraft:')} ${wowDir}`);
  fs.mkdirSync(addonsDir, { recursive: true });

  // The game only discovers new addon folders and sound files when it starts.
  const freshAddon = !fs.existsSync(path.join(addonsDir, ADDON, `${ADDON}.toc`));
  const dst = syncAddon(addonsDir);
  console.log(`${C.g('✓')} Addon installed to ${dst}`);

  const slots = Number(args.slots || cfg.slots || DEFAULT_SLOTS);
  const bank = new SlotBank(addonsDir, { slots });
  const had = bank.installedSlotCount();
  const bellsMissing = !fs.existsSync(bank.sigFile(CTL_LONG));
  const { made, pruned } = bank.install();
  if (had > slots) bank.removeSlots(slots);
  console.log(`${C.g('✓')} ${slots} live-update slots ready ${C.d(`(${made} files written${pruned ? `, ${pruned} unused signal files removed` : ''})`)}`);

  const { signals: _legacySignals, ...rest } = cfg;
  const next = { ...rest, wowDir, addonsDir, slots };
  writeConfig(next);

  if (!findT3Cli()) {
    console.log(C.r('✗ The `t3` command was not found. Open T3 Code once (it installs `t3`), then run `t3code-wow install` again.'));
    process.exitCode = 1;
    return;
  }
  const token = readToken();
  const claims = token && tokenClaims(token);
  if (!claims || (claims.exp && claims.exp < Date.now() + 86400000)) {
    process.stdout.write('… Creating a T3 Code session for the bridge (this takes a few seconds)\r');
    await mintToken();
  }
  console.log(`${C.g('✓')} T3 Code session ready ${C.d('(scoped to reading and running threads; revoke with `t3 auth session list`)')}`);

  let helper = null;
  if (MAC) {
    // Built only when its script changed: a rebuild makes macOS ask again.
    try {
      helper = installMacHelper();
    } catch (err) {
      console.log(C.r(`✗ Couldn't build ${MAC_HELPER_NAME}: ${err.message}`));
      process.exitCode = 1;
      return;
    }
    if (helper === 'built') console.log(`${C.g('✓')} ${MAC_HELPER_NAME} installed ${C.d(`(${macHelperPath()}; it holds the Screen Recording permission, so node doesn't need it)`)}`);
    else if (helper === 'rebuilt') console.log(`${C.g('✓')} ${MAC_HELPER_NAME} updated ${C.d('(it changed, so macOS asks for Screen Recording permission again)')}`);
    else console.log(`${C.g('✓')} ${MAC_HELPER_NAME} is up to date ${C.d('(its Screen Recording permission is kept)')}`);
  }

  if (!args['no-service']) {
    if (!service.install()) {
      console.log(C.r(`✗ The bridge's ${service.kind} didn't start (the error is above). Fix that, then run \`t3code-wow install\` again.`));
      process.exitCode = 1;
      return;
    }
    console.log(`${C.g('✓')} Bridge running as the ${service.name} ${service.kind}`);
    if (helper && helper !== 'current') console.log(`${C.y('!')} The bridge reads the game's pixels, so macOS asks to let ${C.b(MAC_HELPER_NAME)} record the screen: turn it on in System Settings.`);
    if (helper === 'built') console.log(`${C.y('!')} If you turned on \`node\` under Screen & System Audio Recording for an earlier version, turn it off: the bridge doesn't need it any more.`);
  }

  console.log('');
  await firstLaunch({
    restart: freshAddon || had < slots || bellsMissing,
    running: !!findWowProcess(),
    waiting: !args['no-service'] && process.stdin.isTTY && process.stdout.isTTY,
    since: Date.now(),
  });
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
}

// After installing: say exactly what to do in the game, then wait (Enter skips) until
// the addon checks in, so you know it works before you go looking for it.
async function firstLaunch({ restart, running, waiting, since }) {
  let step;
  if (restart) step = running ? 'Quit World of Warcraft completely and start it again, then log in to a character.' : 'Start World of Warcraft: Forever and log in to a character.';
  else step = running ? 'Type /reload in game.' : 'Start World of Warcraft: Forever and log in to a character.';
  console.log(`${C.b('Next:')} ${step}`);
  if (restart && running) console.log(C.d('  The game only finds new addon files when it starts, so a /reload isn\'t enough this time.'));

  let connected = null;
  if (waiting) {
    let skipped = false;
    process.stdin.resume();
    process.stdin.once('data', () => {
      skipped = true;
    });
    let shown = '';
    const until = Date.now() + 20 * 60 * 1000;
    while (!skipped && Date.now() < until) {
      const st = readStatus();
      if (st?.addon && st.addon.lastSeen >= since) {
        connected = st;
        break;
      }
      const blocked = st?.capture?.state === 'error' && st.capture.lastError === SCREEN_PERMISSION_HELP;
      const msg = blocked
        ? 'Waiting for Screen Recording permission (see above)… (Enter to skip)'
        : st?.wow ? 'World of Warcraft is running. Waiting for you to log in… (Enter to skip)' : 'Waiting for World of Warcraft to start… (Enter to skip)';
      if (msg !== shown) {
        if (blocked) process.stdout.write(`\r\x1b[2K${C.y(SCREEN_PERMISSION_HELP)}\n`);
        process.stdout.write(`\r\x1b[2K${C.d(msg)}`);
        shown = msg;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    process.stdin.pause();
    process.stdout.write('\r\x1b[2K');
    if (connected) {
      // The first hello can arrive before the addon has its link keys; give it a moment.
      for (let i = 0; i < 8 && !readStatus()?.addon?.encrypted; i++) await new Promise((r) => setTimeout(r, 1000));
      const enc = readStatus()?.addon?.encrypted;
      console.log(`${C.g('✓')} Connected: the game and the bridge are talking${enc ? ' over an encrypted link' : ''}.`);
    } else if (!skipped) {
      console.log(C.y('The game hasn\'t checked in yet. Once you\'re in, `t3code-wow status` shows whether it connected.'));
    }
  }
  console.log(`
${C.b('In game')}
  /t3                       open or close T3 Code (or click the T3 button on the minimap)
  both triggers + Back      open it from a controller
  /t3 selftest              check the link step by step if something seems off

${C.b('From here')}
  t3code-wow env add <host>   show threads from another machine (T3 Connect)
  t3code-wow status           what the bridge sees
  rerun the install command   update
  t3code-wow uninstall        remove everything`);
}

function cmdSync(args) {
  const cfg = readConfig();
  const addonsDir = cfg.addonsDir || addonsDirOf(resolveWowDir(args, cfg));
  // The game only discovers new addon folders and sound files when it starts.
  const freshAddon = !fs.existsSync(path.join(addonsDir, ADDON, `${ADDON}.toc`));
  const dst = syncAddon(addonsDir);
  console.log(`${C.g('✓')} Addon code copied to ${dst}. Type /reload in game.`);
}

async function cmdRun(args) {
  const cfg = readConfig();
  const addonsDir = cfg.addonsDir || addonsDirOf(resolveWowDir(args, cfg));
  const bridge = new Bridge({ addonsDir, config: { ...cfg, verbose: args.verbose || cfg.verbose } });
  const stop = () => {
    bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await bridge.start();
}

function ago(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

function cmdStatus(args) {
  let st;
  try {
    st = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'status.json'), 'utf8'));
  } catch {
    console.log(C.r('The bridge has not run yet.'), 'Start it with `t3code-wow install` or `t3code-wow run`.');
    process.exitCode = 1;
    return;
  }
  if (args.json) return console.log(JSON.stringify(st, null, 2));
  const age = Date.now() - Date.parse(st.at);
  const alive = age < 10000;
  const ok = (b) => (b ? C.g('●') : C.r('●'));
  console.log(`${ok(alive)} Bridge ${st.version} ${alive ? `running (pid ${st.pid})` : `not running (last seen ${ago(age)})`}`);
  console.log(`${ok(st.t3.state === 'connected')} T3 Code: ${st.t3.state}${st.t3.error ? ` — ${st.t3.error}` : ''} ${C.d(`(${st.t3.threads} threads, ${st.t3.origin || '?'})`)}`);
  console.log(`${ok(!!st.wow)} WoW: ${st.wow ? `running (pid ${st.wow.pid})` : 'not running'}`);
  console.log(`${ok(st.capture.state === 'ok' || st.capture.state === 'idle')} Screen link: ${st.capture.state} via ${st.capture.backend} ${C.d(`(${st.capture.decoded} frames read, ${st.capture.rejected} rejected)`)}${st.capture.lastError ? `\n    ${C.y(st.capture.lastError)}` : ''}`);
  if (st.addon) {
    console.log(`${ok(true)} Addon ${st.addon.version}: last heard ${ago(Date.now() - st.addon.lastSeen)}; window ${st.addon.flags.includes('o') ? 'open' : 'closed'}`);
    console.log(`${ok(st.addon.encrypted)} Link ${st.addon.encrypted ? 'encrypted' : 'not encrypted yet (waiting for the addon to load its keys)'}${st.rejected?.forged ? C.d(` · ${st.rejected.forged} unauthenticated frames ignored`) : ''}`);
  } else {
    console.log(`${ok(false)} Addon: not heard from yet ${C.d('(log in, then /t3)')}`);
  }
  console.log(`  Live updates left this session: ${st.slots.remaining}/${st.slots.total} ${C.d(`· ${st.publishes} updates sent · update bell #${st.signals.next}`)}`);
  console.log(`  Speech: ${st.voice.tts || C.y('none')} · Dictation: ${st.voice.dictation || C.y('none')}`);
  if (args.log || args.v) {
    console.log('');
    for (const l of st.log) console.log(C.d(l));
  }
}

async function cmdProbe() {
  const proc = findWowProcess();
  const cap = new StripCapture({ stateDir: STATE_DIR });
  console.log(`backend: ${cap.resolveBackend()}; WoW pid: ${proc?.pid ?? 'not running'}`);
  const res = await cap.grab(proc?.pid);
  if (res.status !== 'ok') return console.log(`capture: ${res.status}`);
  const out = path.join(os.tmpdir(), 't3code-wow-probe.ppm');
  const img = res.image;
  fs.writeFileSync(out, Buffer.concat([Buffer.from(`P6\n${img.width} ${img.height}\n255\n`), Buffer.from(img.data)]));
  let png = out;
  try {
    execFileSync('magick', [out, out.replace(/\.ppm$/, '.png')]);
    png = out.replace(/\.ppm$/, '.png');
  } catch {}
  const dec = decodeImage(img, null, { searchY: res.searchY });
  console.log(`captured ${img.width}x${img.height} -> ${png}`);
  if (!dec) console.log('no strip visible (open the T3 window in game, or send something)');
  else if (dec.error) console.log(`strip found but unreadable: ${dec.error} (cell ${dec.geo.cell}px at ${dec.geo.ox},${dec.geo.oy})`);
  else console.log(`strip decoded: seq ${dec.seq}, ${dec.payload.length} bytes, cell ${dec.geo.cell}px at ${dec.geo.ox},${dec.geo.oy}`);
}

async function ask(question) {
  if (!process.stdin.isTTY) return false;
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// Remove everything install put on this computer, and revoke the bridge's sessions.
async function cmdUninstall(args) {
  const cfg = readConfig();
  if (!args.yes) {
    console.log('This removes T3 Code for World of Warcraft: the addon and its update folders, its settings in the game,');
    console.log('the bridge service, the bridge\'s T3 Code sessions (on every machine it was added to) and its files.');
    if (!(await ask('Remove it? [y/N] '))) {
      console.log(process.stdin.isTTY ? 'Nothing removed.' : 'Nothing removed. Run `t3code-wow uninstall --yes` to remove without asking.');
      return;
    }
  }
  const done = (msg) => console.log(`${C.g('✓')} ${msg}`);
  const warn = (msg) => console.log(`${C.y('!')} ${msg}`);

  if (fs.existsSync(service.file)) {
    service.remove();
    done('Stopped and removed the bridge service');
  }
  if (MAC && removeMacHelper()) done(`Removed ${MAC_HELPER_NAME} and its Screen Recording permission`);

  let wowDir = cfg.wowDir;
  if (!wowDir) {
    try {
      wowDir = findWowInstalls().forever[0];
    } catch {}
  }
  const addonsDir = cfg.addonsDir || (wowDir && addonsDirOf(wowDir));
  if (addonsDir && fs.existsSync(addonsDir)) {
    const n = new SlotBank(addonsDir).removeSlots(0);
    fs.rmSync(path.join(addonsDir, ADDON), { recursive: true, force: true });
    done(`Removed the addon and ${n} update folders from the game`);
  }
  if (wowDir) {
    // The addon's saved settings (account-wide SavedVariables).
    let removed = 0;
    const accounts = path.join(wowDir, 'WTF', 'Account');
    try {
      for (const acct of fs.readdirSync(accounts)) {
        for (const f of [`${ADDON}.lua`, `${ADDON}.lua.bak`]) {
          const p = path.join(accounts, acct, 'SavedVariables', f);
          if (fs.existsSync(p)) {
            fs.rmSync(p);
            removed++;
          }
        }
      }
    } catch {}
    if (removed) done('Removed its saved settings from the game');
  }

  // Revoke the sessions the bridge was given, here and on other machines.
  const claims = tokenClaims(readToken() || '');
  const t3 = findT3Cli();
  if (claims?.sid && t3) {
    const r = spawnSync(t3, ['auth', 'session', 'revoke', claims.sid], { encoding: 'utf8', timeout: 60000 });
    if (r.status === 0) done('Revoked the bridge\'s T3 Code session');
    else warn(`Couldn't revoke the bridge's T3 Code session; remove it with \`t3 auth session list\` (${claims.sid}).`);
  }
  for (const e of cfg.environments || []) {
    const tok = readTokenData(e.id);
    if (!tok?.sessionId || !e.ssh) continue;
    try {
      await revokeRemote(e.ssh, tok.sessionId);
      done(`Revoked the bridge's session on ${e.label}`);
    } catch (err) {
      warn(`Couldn't revoke the bridge's session on ${e.label} (${err.message.split('\n')[0]}); remove it there with \`t3 auth session list\`.`);
    }
  }

  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  done('Removed the bridge\'s settings and state');

  try {
    if (fs.lstatSync(BIN_LINK).isSymbolicLink() && fs.readlinkSync(BIN_LINK).startsWith(DATA_DIR)) fs.rmSync(BIN_LINK);
  } catch {}
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  done('Removed the t3code-wow command and its files');

  if (findWowProcess()) console.log(`\nWorld of Warcraft is running: ${C.b('/reload')} or restart it to finish unloading T3 Code.`);
}

async function cmdEnv(args) {
  const sub = args._[1];
  const cfg = readConfig();
  cfg.environments = cfg.environments || [];
  if (sub === 'list' || !sub) {
    console.log(`${C.b('this computer')} ${C.d('(always shown)')}`);
    for (const e of cfg.environments) {
      const tok = readTokenData(e.id);
      let state = C.r('unreachable');
      for (const url of e.urls) {
        try {
          const id = await identify(url, 4000);
          if (id.environmentId === e.id) {
            state = C.g(`online at ${url}`);
            break;
          }
        } catch {}
      }
      console.log(`${C.b(e.label)} ${state} ${C.d(`· ssh ${e.ssh || '-'} · token ${tok?.expiresAt ? `until ${tok.expiresAt.slice(0, 10)}` : 'missing'}`)}`);
    }
    if (!cfg.environments.length) console.log(C.d('No other machines yet. Add one with: t3code-wow env add <tailscale or ssh host> [--url https://...]'));
    return;
  }
  if (sub === 'add') {
    const host = args._[2];
    if (!host) throw new Error('usage: t3code-wow env add <host> [--url https://...] [--ssh <ssh host>]');
    const ssh = args.ssh ? String(args.ssh) : host;
    const urls = [];
    for (const u of [].concat(args.url || [])) urls.push(String(u).replace(/\/?$/, '/'));
    if (!urls.length) urls.push(...(await discoverTailscale(host)));
    if (!urls.length && /^https?:/.test(host)) urls.push(host);
    if (!urls.length) throw new Error(`couldn't find ${host} on Tailscale; pass --url with its T3 Code address (Settings > Connections on that machine)`);
    let ident;
    let good = [];
    for (const url of urls) {
      try {
        const id = await identify(url);
        if (ident && id.environmentId !== ident.environmentId) continue;
        ident = ident || id;
        good.push(url);
      } catch (err) {
        console.log(C.y(`  ${url}: ${err.message}`));
      }
    }
    if (!ident) throw new Error(`no T3 Code server answered at ${urls.join(', ')}`);
    if (ident.orchestrationProtocolVersion !== 2) throw new Error(`${ident.label} runs an incompatible T3 Code (protocol ${ident.orchestrationProtocolVersion}); update it`);
    const local = JSON.parse(await (await fetch(new URL('/.well-known/t3/environment', JSON.parse(fs.readFileSync(path.join(process.env.T3CODE_HOME || path.join(os.homedir(), '.t3'), 'userdata', 'server-runtime.json'), 'utf8')).origin))).text());
    if (ident.environmentId === local.environmentId) throw new Error(`${host} is this computer`);
    console.log(`${C.g('✓')} Found ${C.b(ident.label)} (${ident.platform?.machine || 'machine'}, T3 Code ${ident.serverVersion}) at ${good.join(', ')}`);
    process.stdout.write(`… Creating a T3 Code session on ${ident.label} over SSH (${ssh})\r`);
    const tok = await mintRemote(ssh, `WoW bridge (${local.label || os.hostname()})`);
    saveToken(ident.environmentId, tok);
    console.log(`${C.g('✓')} Session created on ${ident.label} ${C.d(`(revoke with t3code-wow env remove ${ident.label})`)}`);
    const existing = cfg.environments.find((e) => e.id === ident.environmentId);
    const used = new Set(cfg.environments.map((e) => e.code));
    let code = existing?.code;
    for (let n = 1; !code; n++) if (!used.has(`e${n}`)) code = `e${n}`;
    const entry = { code, id: ident.environmentId, label: ident.label || host, ssh, urls: good };
    cfg.environments = cfg.environments.filter((e) => e.id !== ident.environmentId).concat(entry);
    writeConfig(cfg);
    if (fs.existsSync(service.file)) service.restart();
    console.log(`${C.g('✓')} ${ident.label}'s threads will show in game within a few seconds.`);
    return;
  }
  if (sub === 'remove') {
    const name = args._[2];
    const e = cfg.environments.find((x) => x.label === name || x.id === name || x.ssh === name);
    if (!e) throw new Error(`no machine called ${name}; see t3code-wow env list`);
    const tok = readTokenData(e.id);
    if (tok?.sessionId && e.ssh) {
      try {
        await revokeRemote(e.ssh, tok.sessionId);
        console.log(`${C.g('✓')} Revoked the bridge's session on ${e.label}`);
      } catch (err) {
        console.log(C.y(`Couldn't revoke the session on ${e.label} (${err.message}); remove it there under Settings > Connections.`));
      }
    }
    fs.rmSync(tokenFile(e.id), { force: true });
    cfg.environments = cfg.environments.filter((x) => x !== e);
    writeConfig(cfg);
    if (fs.existsSync(service.file)) service.restart();
    console.log(`${C.g('✓')} Removed ${e.label}`);
    return;
  }
  throw new Error('usage: t3code-wow env [list|add <host>|remove <name>]');
}

function help() {
  console.log(`${C.b('t3code-wow')} ${VERSION} — T3 Code inside World of Warcraft: Forever

  t3code-wow install [--wow DIR] [--slots N] [--no-service]
                     Install the addon, its live-update slots and the bridge service
  t3code-wow status [--log] [--json]
                     Show what the bridge sees
  t3code-wow sync        Re-copy the installed addon into the game (to update, rerun the install command)
  t3code-wow run [--verbose]
                     Run the bridge in the foreground (the service runs this)
  t3code-wow env [list]  Other T3 Code machines shown in game (T3 Connect / Tailscale)
  t3code-wow env add <host> [--url https://...] [--ssh <ssh host>]
                     Show another machine's threads too (finds it on Tailscale,
                     creates its session over SSH)
  t3code-wow env remove <name>
                     Stop showing a machine and revoke the bridge's session there
  t3code-wow probe       Capture the corner of the game window and try to read the strip
  t3code-wow uninstall [--yes]
                     Remove the addon, its settings, the service, the bridge's
                     T3 Code sessions and its files`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const commands = { env: cmdEnv, install: cmdInstall, run: cmdRun, status: cmdStatus, sync: cmdSync, probe: cmdProbe, uninstall: cmdUninstall };
if (!cmd || args.help || !commands[cmd]) {
  help();
  if (cmd && !commands[cmd]) process.exitCode = 1;
} else {
  Promise.resolve(commands[cmd](args)).catch((err) => {
    console.error(C.r(`✗ ${err.message}`));
    process.exitCode = 1;
  });
}
