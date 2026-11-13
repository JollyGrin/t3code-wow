// The outbound channel (game -> bridge): screen-capture the top-left corner of the
// game window and decode the addon's pixel strip.
//
// Hyprland (and other wlroots compositors) allow screencopy, so `grim` can read the
// game's pixels on Wayland. KDE Plasma's KWin doesn't, but its ScreenShot2 D-Bus
// interface does the same job. X11 sessions use ImageMagick's `import`. macOS uses its
// own `screencapture` through a helper app that holds the Screen Recording permission.

import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { decodeImage, parsePPM, parseBMP, parseQImage, encodePNG, CELLS_PER_ROW, MAX_ROWS } from './codec.js';

// A service may start before the session exports WAYLAND_DISPLAY; find the socket.
function captureEnv() {
  if (process.env.WAYLAND_DISPLAY) return process.env;
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  try {
    const sock = fs.readdirSync(runtime).find((f) => /^wayland-\d+$/.test(f));
    if (sock) return { ...process.env, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: sock };
  } catch {}
  return process.env;
}

function run(cmd, args, { maxBuffer = 32 * 1024 * 1024, timeout = 4000, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: 'buffer', maxBuffer, timeout, env: captureEnv() }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr?.toString();
        reject(err);
      } else resolve(stdout);
    });
    if (input) child.stdin.end(input);
  });
}

function which(bin) {
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hyprland IPC (no hyprctl spawn needed)

function hyprSocket() {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const base = path.join(runtime, 'hypr');
  const sig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (sig && fs.existsSync(path.join(base, sig, '.socket.sock'))) return path.join(base, sig, '.socket.sock');
  // Running as a systemd service the variable may be missing: use the newest instance.
  try {
    const dirs = fs
      .readdirSync(base)
      .map((d) => path.join(base, d, '.socket.sock'))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return dirs[0] || null;
  } catch {
    return null;
  }
}

function hyprRequest(sock, cmd) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    const chunks = [];
    c.on('connect', () => c.write(cmd));
    c.on('data', (d) => chunks.push(d));
    c.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    c.on('error', reject);
    c.setTimeout(2000, () => {
      c.destroy();
      reject(new Error('hyprland ipc timeout'));
    });
  });
}

async function hyprWindow(pid) {
  const sock = hyprSocket();
  if (!sock) return null;
  const [clients, monitors] = await Promise.all([
    hyprRequest(sock, 'j/clients').then(JSON.parse),
    hyprRequest(sock, 'j/monitors').then(JSON.parse),
  ]);
  const win =
    clients.find((c) => pid && c.pid === pid) ||
    clients.find((c) => c.title === 'World of Warcraft') ||
    clients.find((c) => /^World of Warcraft/.test(c.title || ''));
  if (!win) return { found: false };
  const mon = monitors.find((m) => m.id === win.monitor) || monitors[0];
  const visible =
    !win.hidden &&
    mon &&
    (mon.activeWorkspace?.id === win.workspace?.id || mon.specialWorkspace?.id === win.workspace?.id);
  return {
    found: true,
    visible,
    x: win.at[0],
    y: win.at[1],
    width: win.size[0],
    height: win.size[1],
    scale: mon?.scale || 1,
    focused: undefined,
  };
}

// ---------------------------------------------------------------------------
// macOS: a small helper app owns the Screen Recording permission, so Node never needs
// it. macOS gives that permission per app, and granting it to `node` would cover every
// Node program on the machine. The helper is a stay-open JXA applet built with
// `osacompile` (it ships with the system, so there's nothing to compile or install).
// It reads CoreGraphics' window list and runs `screencapture`, but only for windows of
// a World of Warcraft process signed by Blizzard.
//
// The bridge talks to it through files in a private (0700) folder in its state dir:
// it writes req-<id>.json, the helper answers with res-<id>.json and, for a capture,
// cap-<id>.<type>. The helper checks the folder every 20 ms while it's busy and every
// 250 ms otherwise, and quits after 5 idle minutes; the bridge starts it again with
// `open` when it needs it.
//
// The permission is tied to the app's code signature (ad-hoc, so its cdhash), which
// changes whenever this script does. Installs only rebuild the app when the script
// changed (MAC_HELPER_VERSION), and then macOS asks again.
//
// What this doesn't stop: the app lives in the user's ~/Applications, and an ad-hoc
// signature's cdhash doesn't cover the compiled script, so a program running as the
// same user can replace the script and keep the permission. The bridge checks the
// signature before it starts or uses the helper and refuses a modified one, and
// `t3code-wow install` restores it, but a program that starts the modified app itself
// isn't stopped by that.

export const MAC_HELPER_NAME = 'T3Code WoW Capture';
export const MAC_HELPER_ID = 'com.t3code-wow.capture';
const WOW_BUNDLE_ID = 'com.blizzard.worldofwarcraft';
// Blizzard's Developer ID team. The helper only treats a process as the game when its
// running code satisfies this requirement, so another app can't claim the bundle id.
const WOW_REQUIREMENT = 'anchor apple generic and certificate leaf[subject.OU] = "G847MC6JZ5"';
const OUTSIDE_GAME = "that area isn't the corner of a visible World of Warcraft window";
// The strip corner the bridge grabs, in physical pixels, plus how far below the
// window's top (in points) the strip may start.
const MAC_STRIP = { width: CELLS_PER_ROW * 4 + 32, height: MAX_ROWS * 4 + 32, searchY: 40 };

// These run inside the helper, which gets their source, and in the bridge and tests.

// The backing scale of the screen a window's centre is on. Window bounds are in points
// with the origin at the top-left of the main display; screens come from NSScreen,
// whose origin is bottom-left.
export function windowScale(screens, b) {
  const primary = screens[0];
  if (!primary) return 1;
  const cx = b.X + b.Width / 2;
  const cy = b.Y + b.Height / 2;
  const on = screens.find((s) => {
    const top = primary.height - (s.y + s.height);
    return cx >= s.x && cx < s.x + s.width && cy >= top && cy < top + s.height;
  });
  return (on || primary).scale || 1;
}

// The corner the bridge grabs on a screen of this scale, in points.
export function cornerSize(scale, strip) {
  return { width: Math.ceil(strip.width / scale), height: Math.ceil(strip.height / scale) + strip.searchY };
}

// What the helper lets anyone who can write to its folder capture: the strip corner of
// a visible game window (a screen area, so it's kept to the size the bridge needs and
// inside the window) or a whole game window by id (its own pixels, so nothing
// covering it).
export function allowedCorner(info, r, strip) {
  if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === 'number' && isFinite(n))) return false;
  if (r[2] <= 0 || r[3] <= 0) return false;
  return info.windows.some((w) => {
    const b = w.bounds;
    if (w.layer !== 0 || !w.onscreen || b.Width <= 100 || b.Height <= 100) return false;
    const max = cornerSize(windowScale(info.screens, b), strip);
    return Math.abs(r[0] - b.X) <= 2 && Math.abs(r[1] - b.Y) <= 2 && r[2] <= max.width && r[3] <= max.height && r[0] + r[2] <= b.X + b.Width + 2 && r[1] + r[3] <= b.Y + b.Height + 2;
  });
}

export function allowedWindow(windows, id) {
  return windows.some((w) => w.id === id && w.layer === 0 && w.onscreen && w.bounds.Width > 100 && w.bounds.Height > 100);
}

export const MAC_HELPER_JXA = `// ${MAC_HELPER_NAME}: lets the T3 Code bridge for World of Warcraft read the game window.
// It only lists and captures windows of World of Warcraft (${WOW_BUNDLE_ID}, signed by Blizzard).
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
ObjC.bindFunction('CGRequestScreenCaptureAccess', ['bool', []]);
const fm = $.NSFileManager.defaultManager;
const IDLE_QUIT_MS = 300000;
const STRIP = ${JSON.stringify(MAC_STRIP)};
const WOW_REQUIREMENT = ${JSON.stringify(WOW_REQUIREMENT)};
${windowScale.toString()}
${cornerSize.toString()}
${allowedCorner.toString()}
${allowedWindow.toString()}
const me = $.NSProcessInfo.processInfo.processIdentifier;
const signedGame = {};
let dir = null;
let last = Date.now();

function readText(p) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
  return s.isNil() ? null : s.js;
}

function writeText(name, text) {
  $(text).writeToFileAtomicallyEncodingError(dir + '/' + name, true, $.NSUTF8StringEncoding, null);
}

function quit() {
  // Leave no pid behind for the bridge to mistake for a running helper.
  try {
    if (dir && JSON.parse(readText(dir + '/ready.json')).pid === me) fm.removeItemAtPathError(dir + '/ready.json', null);
  } catch (e) {}
  $.NSApplication.sharedApplication.terminate(null);
  return 1;
}

function exec(launchPath, args) {
  const task = $.NSTask.alloc.init;
  task.launchPath = launchPath;
  task.arguments = args;
  const err = $.NSPipe.pipe;
  task.standardError = err;
  task.standardOutput = $.NSFileHandle.fileHandleWithNullDevice;
  task.launch;
  task.waitUntilExit;
  const stderr = $.NSString.alloc.initWithDataEncoding(err.fileHandleForReading.readDataToEndOfFile, $.NSUTF8StringEncoding).js;
  return { code: task.terminationStatus, stderr: stderr.trim() };
}

function run() {
  const args = ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments);
  dir = args.length > 1 ? args[args.length - 1] : '';
  if (dir[0] !== '/' || !fm.fileExistsAtPath(dir)) return quit();
  writeText('ready.json', JSON.stringify({ pid: me }));
}

// Whether a process is World of Warcraft: its bundle id, and its running code signed
// by Blizzard (checked once per process launch). --ignore-resources skips the bundle's
// other files: since the 2026-11-10 patch the game ships an unsigned icudt78l.dat next
// to its executable, which fails a full check. The executable must still meet the
// Blizzard requirement.
function isGame(pid) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (app.isNil() || app.bundleIdentifier.isNil() || app.bundleIdentifier.js !== '${WOW_BUNDLE_ID}') return false;
  const key = pid + ':' + (app.launchDate.isNil() ? '' : app.launchDate.timeIntervalSince1970);
  if (!(key in signedGame)) signedGame[key] = exec('/usr/bin/codesign', ['--verify', '--ignore-resources', '-R=' + WOW_REQUIREMENT, String(pid)]).code === 0;
  return signedGame[key];
}

// World of Warcraft's windows and the screens, in the shape pickMacWindow() takes.
function gameWindows() {
  const arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(16, 0));
  const game = {};
  const windows = [];
  for (let i = 0; i < arr.count; i++) {
    const w = arr.objectAtIndex(i);
    const v = (k) => { const x = w.objectForKey(k); return x.isNil() ? null : x.js; };
    const pid = v('kCGWindowOwnerPID');
    if (!(pid in game)) game[pid] = isGame(pid);
    if (!game[pid]) continue;
    windows.push({ id: v('kCGWindowNumber'), pid: pid, layer: v('kCGWindowLayer'), onscreen: !!v('kCGWindowIsOnscreen'), bounds: ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds')) });
  }
  const screens = $.NSScreen.screens.js.map((s) => ({ x: s.frame.origin.x, y: s.frame.origin.y, width: s.frame.size.width, height: s.frame.size.height, scale: s.backingScaleFactor }));
  return { windows: windows, screens: screens };
}

function screencapture(args, file) {
  const out = exec('/usr/sbin/screencapture', ['-x'].concat(args, [dir + '/' + file]));
  return out.code === 0 ? { ok: true, file: file } : { ok: false, error: out.stderr || 'screencapture failed' };
}

// The strip corner (a rectangle in points) of a visible game window, as BMP.
function captureCorner(req, id) {
  if (!allowedCorner(gameWindows(), req.rect, STRIP)) return { ok: false, error: "${OUTSIDE_GAME}" };
  return screencapture(['-R', req.rect.map(Math.round).join(','), '-t', 'bmp'], 'cap-' + id + '.bmp');
}

// A whole visible game window, its own pixels only, as JPEG.
function captureWindow(req, id) {
  if (typeof req.id !== 'number' || !allowedWindow(gameWindows().windows, req.id)) return { ok: false, error: 'that is not a visible World of Warcraft window' };
  return screencapture(['-o', '-l' + req.id, '-t', 'jpg'], 'cap-' + id + '.jpg');
}

function handle(name) {
  const id = name.slice(4, -5);
  const text = readText(dir + '/' + name);
  fm.removeItemAtPathError(dir + '/' + name, null);
  let res;
  try {
    const req = JSON.parse(text);
    if (req.op === 'windows') res = { ok: true, info: gameWindows() };
    else if (req.op === 'corner') res = captureCorner(req, id);
    else if (req.op === 'window') res = captureWindow(req, id);
    else if (req.op === 'request') res = { ok: true, granted: $.CGRequestScreenCaptureAccess() };
    else res = { ok: false, error: 'unknown request' };
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  res.access = $.CGPreflightScreenCaptureAccess();
  writeText('res-' + id + '.json', JSON.stringify(res));
}

function idle() {
  if (!fm.fileExistsAtPath(dir)) return quit();
  const names = ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError(dir, null)) || [];
  const reqs = names.filter((n) => /^req-[0-9a-z]+\\.json$/.test(n)).sort();
  for (const n of reqs) handle(n);
  if (reqs.length) last = Date.now();
  if (Date.now() - last > IDLE_QUIT_MS) return quit();
  return Date.now() - last < 5000 ? 0.02 : 0.25;
}
`;

export const MAC_HELPER_VERSION = createHash('sha256').update(MAC_HELPER_JXA).digest('hex').slice(0, 16);

export function macHelperPath(home = os.homedir()) {
  return path.join(home, 'Applications', `${MAC_HELPER_NAME}.app`);
}

const helperExecutable = (app) => path.join(app, 'Contents/MacOS/applet');

// Whether the app is still exactly as it was built: `codesign --verify --strict` checks
// the sealed resources (the compiled script) too, which macOS doesn't check at launch.
export function macHelperIntact(app = macHelperPath()) {
  return spawnSync('codesign', ['--verify', '--strict', app]).status === 0;
}

// The helper version an installed app was built from, read from its Info.plist text.
export function plistHelperVersion(text) {
  return /<key>T3CodeWowHelperVersion<\/key>\s*<string>([^<]*)<\/string>/.exec(text || '')?.[1] || null;
}

// Why the helper needs building: 'missing', 'old' (its script changed: a rebuild changes
// the signature, and macOS asks for Screen Recording again), 'modified' (changed since
// it was built: rebuilding restores the same signature, so the permission stays) or
// null when it's current.
export function macHelperNeedsBuild(app = macHelperPath(), { intact = macHelperIntact } = {}) {
  let text = null;
  try {
    if (fs.existsSync(helperExecutable(app))) text = fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8');
  } catch {}
  if (text === null) return 'missing';
  if (plistHelperVersion(text) !== MAC_HELPER_VERSION) return 'old';
  return intact(app) ? null : 'modified';
}

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout || '').trim() || `exit ${r.status}`}`);
}

// The command line of a running process, or null.
function commandOf(pid) {
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Whether a command line is the helper's executable (not just mentions its path).
export function isHelperCommand(command, app) {
  const exe = helperExecutable(app);
  return command === exe || (command || '').startsWith(`${exe} `);
}

// Quits every running copy of the helper.
function quitMacHelper(app) {
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && isHelperCommand(m[2], app)) {
      try {
        process.kill(Number(m[1]));
      } catch {}
    }
  }
}

// Builds the helper app if it's missing, out of date or modified. Returns 'built' (new),
// 'rebuilt' (changed, so macOS asks again), 'repaired' (restored as built, permission
// kept) or 'current'.
export function installMacHelper(app = macHelperPath()) {
  const why = macHelperNeedsBuild(app);
  if (!why) return 'current';
  quitMacHelper(app);
  if (why === 'old') {
    // The old grant no longer matches the new signature; clear it so Settings doesn't
    // show a switch that's on but doesn't work. tccutil needs the app to still exist.
    spawnSync('tccutil', ['reset', 'ScreenCapture', MAC_HELPER_ID]);
  }
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(app), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't3code-wow-helper-'));
  try {
    const src = path.join(tmp, 'helper.js');
    fs.writeFileSync(src, MAC_HELPER_JXA);
    sh('osacompile', ['-l', 'JavaScript', '-s', '-o', app, src]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const plist = path.join(app, 'Contents/Info.plist');
  sh('/usr/libexec/PlistBuddy', [
    '-c', `Add :CFBundleIdentifier string ${MAC_HELPER_ID}`,
    '-c', 'Add :LSUIElement bool true',
    '-c', `Add :T3CodeWowHelperVersion string ${MAC_HELPER_VERSION}`,
    plist,
  ]);
  sh('codesign', ['--force', '-s', '-', '--identifier', MAC_HELPER_ID, app]);
  return { missing: 'built', old: 'rebuilt', modified: 'repaired' }[why];
}

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

// Quits the helper, clears its Screen Recording entry, forgets it in LaunchServices and
// deletes it. Returns whether there was one.
export function removeMacHelper(app = macHelperPath()) {
  if (!fs.existsSync(app)) return false;
  quitMacHelper(app);
  spawnSync('tccutil', ['reset', 'ScreenCapture', MAC_HELPER_ID]);
  spawnSync(LSREGISTER, ['-u', app]);
  fs.rmSync(app, { recursive: true, force: true });
  return true;
}

// A helper answer: { ok, access, ... }. Anything else is reported as an error.
export function parseHelperResponse(text) {
  let res;
  try {
    res = JSON.parse(text);
  } catch {
    return { ok: false, access: true, error: 'the capture helper sent an unreadable answer' };
  }
  if (!res || typeof res !== 'object' || typeof res.ok !== 'boolean') return { ok: false, access: true, error: 'the capture helper sent an unreadable answer' };
  return { ...res, access: res.access !== false };
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The bridge's side of the file handoff.
export class MacHelper {
  constructor({ dir, app = macHelperPath(), launch = null, intact = macHelperIntact, isHelper = null } = {}) {
    this.dir = dir;
    this.app = app;
    // -n: a copy someone else started (with another folder) can't take our place.
    this.launch = launch || ((app, dir) => spawnSync('open', ['-n', '-g', '-j', '-a', app, '--args', dir]).status === 0);
    this.intact = intact;
    this.isHelper = isHelper || ((pid) => isHelperCommand(commandOf(pid), this.app));
    this.pid = null;
    this.launchedAt = 0;
    this.seq = 0;
  }

  readyPid() {
    try {
      const pid = JSON.parse(fs.readFileSync(path.join(this.dir, 'ready.json'), 'utf8')).pid;
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  async ensure() {
    if (this.pid && isAlive(this.pid)) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    if (!fs.existsSync(this.app)) throw new Error(MAC_HELPER_MISSING);
    if (!this.intact(this.app)) throw new Error(MAC_HELPER_MODIFIED);
    const running = this.readyPid();
    if (running && isAlive(running) && this.isHelper(running)) {
      this.pid = running;
      return;
    }
    // Clear what a previous helper left behind.
    for (const f of fs.readdirSync(this.dir)) if (/^(ready|req-|res-|cap-)/.test(f)) fs.rmSync(path.join(this.dir, f), { force: true });
    this.launchedAt = Date.now();
    if (!this.launch(this.app, this.dir)) throw new Error(`couldn't start ${MAC_HELPER_NAME} (${this.app})`);
    for (let i = 0; i < 100; i++) {
      const pid = this.readyPid();
      if (pid && isAlive(pid)) {
        this.pid = pid;
        return;
      }
      await sleep(50);
    }
    throw new Error(`${MAC_HELPER_NAME} didn't start (${this.app})`);
  }

  // Quits the helper so the next request starts a fresh one. macOS applies a new
  // Screen Recording grant only to a process started after it.
  restart() {
    if (Date.now() - this.launchedAt < 10000) return;
    if (this.pid && this.isHelper(this.pid)) {
      try {
        process.kill(this.pid);
      } catch {}
    }
    this.pid = null;
  }

  async request(op, args = {}, { timeout = 8000 } = {}) {
    await this.ensure();
    const id = `${Date.now().toString(36)}${(++this.seq).toString(36).padStart(4, '0')}`;
    const req = path.join(this.dir, `req-${id}.json`);
    const res = path.join(this.dir, `res-${id}.json`);
    fs.writeFileSync(`${req}.tmp`, JSON.stringify({ op, ...args }), { mode: 0o600 });
    fs.renameSync(`${req}.tmp`, req);
    const until = Date.now() + timeout;
    for (let i = 0; Date.now() < until; i++) {
      // A helper that quit (or was quit) won't answer: start a new one next time.
      if (i % 25 === 24 && !isAlive(this.pid)) break;
      let text = null;
      try {
        text = fs.readFileSync(res, 'utf8');
      } catch {}
      if (text !== null) {
        fs.rmSync(res, { force: true });
        return parseHelperResponse(text);
      }
      await sleep(10);
    }
    fs.rmSync(req, { force: true });
    this.pid = null;
    throw new Error(`${MAC_HELPER_NAME} didn't answer`);
  }

  // Reads and removes a capture file the helper wrote.
  take(file) {
    const p = path.join(this.dir, path.basename(file));
    try {
      return fs.readFileSync(p);
    } finally {
      fs.rmSync(p, { force: true });
    }
  }
}

// The game window from the helper's window list: its bounds and the scale of the
// screen it's on.
export function pickMacWindow(info, pid) {
  const normal = info.windows.filter((w) => w.layer === 0 && w.bounds.Width > 100 && w.bounds.Height > 100);
  const mine = normal.filter((w) => w.pid === pid);
  const pool = mine.length ? mine : normal;
  const area = (w) => w.bounds.Width * w.bounds.Height;
  const win = pool.sort((a, b) => Number(b.onscreen) - Number(a.onscreen) || area(b) - area(a))[0];
  if (!win) return { found: false };
  const b = win.bounds;
  return { found: true, id: win.id, visible: win.onscreen, x: b.X, y: b.Y, width: b.Width, height: b.Height, scale: windowScale(info.screens, b) };
}

// ---------------------------------------------------------------------------
// KDE Plasma: KWin doesn't offer wlroots' screencopy, so grim can't read it. Its D-Bus
// API can: the windows runner (KRunner's window search) finds windows by caption,
// getWindowInfo gives their geometry, pid, desktops and minimized state, and
// ScreenShot2 writes raw pixels into a pipe we pass it. busctl ships with systemd and
// can pass that pipe, so there's nothing to install.

const KWIN_WINDOW_ID = /\{[0-9a-f-]{36}\}$/i;

// Runs busctl and parses its JSON reply. With `pipe`, busctl gets a pipe as fd 3 for an
// `h` argument, and the result also carries what was written to it.
function busctl(args, { pipe = false, timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('busctl', ['--user', '--json=short', 'call', ...args], {
      stdio: ['ignore', 'pipe', 'pipe', ...(pipe ? ['pipe'] : [])],
      env: captureEnv(),
    });
    const out = [];
    const err = [];
    const data = [];
    let pending = pipe ? 2 : 1;
    let code = null;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`busctl ${args[3]} timed out`));
    }, timeout);
    const done = () => {
      if (--pending) return;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(Buffer.concat(err).toString('utf8').trim() || `busctl ${args[3]} failed`));
      try {
        resolve({ reply: JSON.parse(Buffer.concat(out).toString('utf8')).data, data: Buffer.concat(data) });
      } catch (e) {
        reject(e);
      }
    };
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    if (pipe) {
      child.stdio[3].on('data', (d) => data.push(d));
      child.stdio[3].on('close', done);
    }
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (c) => {
      code = c;
      done();
    });
  });
}

// a{sv} as busctl prints it ({ key: { type, data } }) -> { key: data }.
const plainDict = (dict) => Object.fromEntries(Object.entries(dict).map(([k, v]) => [k, v.data]));

// The game window from getWindowInfo replies: found by pid, else by caption. It's
// visible unless minimized or on another virtual desktop (no desktops means all).
export function pickKwinWindow(infos, pid, desktop) {
  const win =
    infos.find((w) => pid && w.pid === pid) ||
    infos.find((w) => w.caption === 'World of Warcraft') ||
    infos.find((w) => /^World of Warcraft/.test(w.caption || ''));
  if (!win) return { found: false };
  const visible = !win.minimized && (!win.desktops?.length || win.desktops.includes(desktop));
  return { found: true, visible, uuid: win.uuid, x: win.x, y: win.y, width: win.width, height: win.height };
}

async function kwinWindow(pid) {
  const [{ reply: matches }, { reply: current }] = await Promise.all([
    busctl(['org.kde.KWin', '/WindowsRunner', 'org.kde.krunner1', 'Match', 's', 'World of Warcraft']),
    busctl(['org.kde.KWin', '/VirtualDesktopManager', 'org.freedesktop.DBus.Properties', 'Get', 'ss', 'org.kde.KWin.VirtualDesktopManager', 'current']),
  ]);
  // Match ids are "<action>_{uuid}"; a window can appear once per action.
  const ids = [...new Set(matches[0].map((m) => KWIN_WINDOW_ID.exec(m[0])?.[0]).filter(Boolean))];
  const infos = await Promise.all(ids.map((id) => busctl(['org.kde.KWin', '/KWin', 'org.kde.KWin', 'getWindowInfo', 's', id]).then((r) => plainDict(r.reply[0]))));
  return pickKwinWindow(infos, pid, current[0].data);
}

// One ScreenShot2 call; `args` are the method's arguments before the options and pipe.
async function kwinCapture(method, signature, args, options, timeout = 4000) {
  const opts = Object.entries(options).flatMap(([k, v]) => [k, 'b', String(v)]);
  const { reply, data } = await busctl(
    ['org.kde.KWin', '/org/kde/KWin/ScreenShot2', 'org.kde.KWin.ScreenShot2', method, `${signature}a{sv}h`, ...args.map(String), String(opts.length / 3), ...opts, '3'],
    { pipe: true, timeout },
  );
  const meta = plainDict(reply[0]);
  if (meta.type !== 'raw') throw new Error(`unexpected KWin image type ${meta.type}`);
  return parseQImage(data, meta);
}

export const SCREEN_PERMISSION_HELP =
  `macOS hasn't let ${MAC_HELPER_NAME} record the screen. Open System Settings > Privacy & Security > Screen & System Audio Recording and turn on ${MAC_HELPER_NAME} (if it isn't listed, add it with + from ${macHelperPath()}). The bridge notices within a few seconds.`;

export const MAC_HELPER_MISSING = `${MAC_HELPER_NAME} isn't installed (${macHelperPath()}). Run \`t3code-wow install\` to add it.`;

export const MAC_HELPER_MODIFIED = `${MAC_HELPER_NAME} has been changed since it was installed, so the bridge won't use it. Run \`t3code-wow install\` to restore it.`;

// ---------------------------------------------------------------------------

export class StripCapture {
  constructor({ log = () => {}, backend = 'auto', region = null, stateDir = null } = {}) {
    this.log = log;
    this.backend = backend;
    this.manualRegion = region; // { x, y, width, height } in compositor (logical) coordinates
    this.hint = null;
    this.lastError = null;
    this.lastSeenAt = 0;
    this.stats = { captures: 0, decoded: 0, rejected: 0, notVisible: 0 };
    this.lastImage = null;
    this.winCache = null; // { pid, at, win }: window lookups cost a helper round trip or several D-Bus calls
    this.macAsked = false;
    this.macHelper = stateDir ? new MacHelper({ dir: path.join(stateDir, 'capture') }) : null;
    this.tmpDir = null;
  }

  resolveBackend() {
    if (this.backend !== 'auto') return this.backend;
    if (process.platform === 'darwin') return 'macos';
    if (/(^|:)KDE(:|$)/.test(process.env.XDG_CURRENT_DESKTOP || '') && which('busctl')) return 'kwin';
    if (process.env.WAYLAND_DISPLAY || hyprSocket()) {
      if (hyprSocket() && which('grim')) return 'hyprland';
      if (which('grim')) return 'grim';
    }
    if (process.env.DISPLAY && which('import')) return 'x11';
    if (which('grim')) return 'grim';
    return 'none';
  }

  // Size of the region to grab, in physical pixels: the largest strip plus slack for
  // window borders and offset search.
  static stripPixels(cell = 4) {
    return { width: CELLS_PER_ROW * cell + 32, height: MAX_ROWS * cell + 32 };
  }

  // The game window, looked up at most every 2 seconds.
  async cachedWindow(pid, lookup) {
    const c = this.winCache;
    if (c && c.pid === pid && Date.now() - c.at < 2000) return c.win;
    const win = await lookup(pid);
    this.winCache = { pid, at: Date.now(), win };
    return win;
  }

  macWindow(pid) {
    return this.cachedWindow(pid, async () => pickMacWindow((await this.macRequest('windows', { pid })).info, pid));
  }

  kwinWindow(pid) {
    return this.cachedWindow(pid, kwinWindow);
  }

  helper() {
    if (!this.macHelper) throw new Error('macOS capture needs the bridge state folder');
    return this.macHelper;
  }

  // One request to the capture helper. A missing permission becomes SCREEN_PERMISSION_HELP,
  // and restarts the helper so it picks up a grant made since it started.
  async macRequest(op, args) {
    const helper = this.helper();
    const res = await helper.request(op, args);
    if (!res.ok && (!res.access || /could not create image/i.test(res.error || ''))) {
      this.requestScreenAccess();
      helper.restart();
      throw new Error(SCREEN_PERMISSION_HELP);
    }
    if (!res.ok) throw new Error(res.error || `${MAC_HELPER_NAME} failed`);
    return res;
  }

  // Ask macOS once for Screen Recording permission. The system shows its prompt (or
  // lists the helper, switched off, in Settings) for the helper app.
  requestScreenAccess() {
    if (this.macAsked) return;
    this.macAsked = true;
    this.helper().request('request', {}, { timeout: 60000 }).catch(() => {});
  }

  // On macOS, ask for Screen Recording up front (at bridge start) so the prompt shows
  // before the game does. macOS only prompts when the permission is missing. Elsewhere
  // there's nothing to ask.
  prepare() {
    if (this.resolveBackend() === 'macos') this.requestScreenAccess();
  }

  tmpFile(name) {
    if (!this.tmpDir || !fs.existsSync(this.tmpDir)) this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't3code-wow-'));
    return path.join(this.tmpDir, name);
  }

  // The helper runs `screencapture` and writes a file; read it back and remove it.
  // 'corner' takes a rect in points, 'window' a window id.
  async macCapture(op, args) {
    let res;
    try {
      res = await this.macRequest(op, args);
    } catch (err) {
      // The window may have moved or resized since it was looked up: look again next time.
      this.winCache = null;
      throw err;
    }
    return this.helper().take(res.file);
  }

  async grab(wowPid, retried = false) {
    const backend = this.resolveBackend();
    this.stats.captures++;
    if (backend === 'none') throw new Error('no capture backend: install grim (Wayland/wlroots) or ImageMagick (X11); on KDE Plasma the bridge uses busctl from systemd');
    const px = StripCapture.stripPixels(4);
    if (backend === 'macos') {
      // The helper only captures the corner of the game window, so a manual region
      // can't be used here.
      if (this.manualRegion && !this.macRegionNoted) {
        this.macRegionNoted = true;
        this.log('capture.region is ignored on macOS: the bridge finds the game window itself');
      }
      const win = await this.macWindow(wowPid);
      if (!win.found) return { status: 'no-window' };
      if (!win.visible) {
        this.stats.notVisible++;
        return { status: 'hidden' };
      }
      // The strip can start below the window's top: under the title bar of a windowed
      // game, or in fullscreen on a MacBook display, where the game moves its UI below
      // the notch. Search 40 points down rather than guessing either height.
      const size = cornerSize(win.scale, MAC_STRIP);
      let buf;
      try {
        buf = await this.macCapture('corner', { rect: [win.x, win.y, size.width, size.height] });
      } catch (err) {
        // The window moved or resized since it was looked up: look again, once.
        if (err.message === OUTSIDE_GAME && !retried) return this.grab(wowPid, true);
        throw err;
      }
      const image = parseBMP(buf);
      // screencapture works in physical pixels: scale the slack to match the image.
      return { status: 'ok', image, searchY: Math.ceil(MAC_STRIP.searchY * (image.width / size.width)) };
    }
    if (backend === 'kwin') {
      let region = this.manualRegion;
      let searchY = 0;
      if (!region) {
        const win = await this.kwinWindow(wowPid);
        if (!win.found) return { status: 'no-window' };
        if (!win.visible) {
          this.stats.notVisible++;
          return { status: 'hidden' };
        }
        region = { x: win.x, y: win.y };
        // KWin reports the frame, so a windowed game's UI starts below the title bar.
        searchY = 40;
      }
      // The region is in logical pixels; at a scale above 1 this grabs more than the
      // strip needs, which is harmless. Native resolution keeps the cells unresampled.
      const w = px.width;
      const h = px.height + searchY;
      const image = await kwinCapture('CaptureArea', 'iiuu', [Math.round(region.x), Math.round(region.y), w, h], { 'native-resolution': true });
      return { status: 'ok', image, searchY: Math.ceil(searchY * (image.width / w)) };
    }
    if (backend === 'hyprland' || backend === 'grim') {
      let region = this.manualRegion;
      let scale = 1;
      if (!region && backend === 'hyprland') {
        const win = await hyprWindow(wowPid);
        if (!win?.found) return { status: 'no-window' };
        if (!win.visible) {
          this.stats.notVisible++;
          return { status: 'hidden' };
        }
        scale = win.scale;
        region = { x: win.x, y: win.y };
      }
      region = region || { x: 0, y: 0 };
      const w = Math.ceil(px.width / scale);
      const h = Math.ceil(px.height / scale);
      const buf = await run('grim', ['-g', `${region.x},${region.y} ${w}x${h}`, '-t', 'ppm', '-']);
      return { status: 'ok', image: parsePPM(buf) };
    }
    if (backend === 'x11') {
      const r = this.manualRegion || { x: 0, y: 0 };
      const buf = await run('import', [
        '-silent', '-window', 'root',
        '-crop', `${px.width}x${px.height}+${r.x}+${r.y}`,
        '-depth', '8', 'ppm:-',
      ]);
      return { status: 'ok', image: parsePPM(buf) };
    }
    throw new Error(`unknown capture backend ${backend}`);
  }

  // A screenshot of the game window for attaching to a message: JPEG at the
  // compositor's logical resolution (keeps it well under T3's 10 MB image limit).
  async screenshot(wowPid) {
    const backend = this.resolveBackend();
    const name = `wow-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jpg`;
    if (backend === 'kwin') {
      // KWin renders the window itself, so this works even while it's covered.
      const win = await this.kwinWindow(wowPid);
      if (!win.found) throw new Error("couldn't find the game window");
      const image = await kwinCapture('CaptureWindow', 's', [win.uuid], { 'include-decoration': false, 'include-shadow': false }, 8000);
      if (which('magick')) {
        const data = await run('magick', ['-size', `${image.width}x${image.height}`, '-depth', '8', 'rgb:-', '-quality', '85', 'jpeg:-'], { timeout: 8000, input: image.data });
        return { data, name, mime: 'image/jpeg' };
      }
      return { data: encodePNG(image), name: name.replace(/\.jpg$/, '.png'), mime: 'image/png' };
    }
    if (backend === 'macos') {
      const win = await this.macWindow(wowPid);
      if (!win.found) throw new Error("the game window wasn't found");
      // The helper only captures a game window that's on screen (on this Space).
      if (!win.visible) throw new Error("the game window isn't on screen");
      let data = await this.macCapture('window', { id: win.id });
      // Retina captures come back at twice the size; keep them at the logical size.
      if (win.scale > 1) {
        const file = this.tmpFile(name);
        fs.writeFileSync(file, data);
        try {
          await run('sips', ['-Z', String(Math.round(Math.max(win.width, win.height))), file], { timeout: 8000 });
          data = fs.readFileSync(file);
        } catch {}
        fs.rmSync(file, { force: true });
      }
      return { data, name, mime: 'image/jpeg' };
    }
    if (backend === 'hyprland' || backend === 'grim') {
      const args = ['-t', 'jpeg', '-q', '85', '-s', '1'];
      if (backend === 'hyprland') {
        const win = await hyprWindow(wowPid);
        if (win?.found) args.push('-g', `${win.x},${win.y} ${win.width}x${win.height}`);
      }
      const data = await run('grim', [...args, '-'], { timeout: 8000 });
      return { data, name, mime: 'image/jpeg' };
    }
    if (backend === 'x11') {
      const data = await run('import', ['-silent', '-window', 'root', '-quality', '85', 'jpeg:-'], { timeout: 8000 });
      return { data, name, mime: 'image/jpeg' };
    }
    throw new Error('no screenshot backend (install grim)');
  }

  // One capture + decode. Returns { status, frame? }.
  async poll(wowPid) {
    let res;
    try {
      res = await this.grab(wowPid);
    } catch (err) {
      this.lastError = err.message;
      return { status: 'error', error: err.message };
    }
    if (res.status !== 'ok') return res;
    this.lastImage = res.image;
    const out = decodeImage(res.image, this.hint, { searchY: res.searchY });
    if (!out) return { status: 'empty' };
    this.hint = out.geo;
    if (out.error) {
      this.stats.rejected++;
      return { status: 'rejected', error: out.error };
    }
    this.stats.decoded++;
    this.lastSeenAt = Date.now();
    return { status: 'frame', frame: out };
  }
}
