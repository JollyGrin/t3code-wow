// Finding the WoW: Forever install and the running client.
//
// On Linux the game runs under Wine or Proton, so we look through Wine prefixes. On
// macOS it runs natively, from /Applications by default.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FLAVOR = '_forever_';
// Omarchy's Battle.net installer (omarchy-install-gaming-battlenet) uses this prefix.
export const OMARCHY_PREFIX = path.join(os.homedir(), 'Games/battlenet');

// Prefixes that game launchers record for their games: Faugus Launcher keeps them in
// games.json, Lutris in one YAML file per game. Either can put a prefix anywhere, such
// as ~/Games itself.
function launcherPrefixes(home) {
  const out = [];
  for (const file of [
    path.join(home, '.local/share/faugus-launcher/games.json'),
    path.join(home, '.var/app/io.github.Faugus.faugus-launcher/data/faugus-launcher/games.json'),
  ]) {
    try {
      for (const g of JSON.parse(fs.readFileSync(file, 'utf8'))) if (typeof g?.prefix === 'string') out.push(g.prefix);
    } catch {}
  }
  for (const dir of [path.join(home, '.local/share/lutris/games'), path.join(home, '.config/lutris/games')]) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml'));
    } catch {}
    for (const f of files) {
      try {
        const m = /^\s+prefix:\s*['"]?(.+?)['"]?\s*$/m.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (m) out.push(m[1].replace(/^~(?=\/)/, home));
      } catch {}
    }
  }
  return out;
}

// Where Faugus Launcher creates new prefixes (its "default-prefix" setting, ~/Faugus
// unless changed).
function faugusPrefixDir(home) {
  try {
    const dir = JSON.parse(fs.readFileSync(path.join(home, '.config/faugus-launcher/config.json'), 'utf8'))['default-prefix'];
    if (typeof dir === 'string' && dir) return dir;
  } catch {}
  return path.join(home, 'Faugus');
}

// Wine prefixes that might hold Battle.net, most likely first.
function candidateRoots() {
  const home = os.homedir();
  const roots = [];
  const add = (p) => p && !roots.includes(p) && roots.push(p);
  add(OMARCHY_PREFIX);
  add(process.env.WINEPREFIX);
  for (const p of launcherPrefixes(home)) add(p);
  add(path.join(home, 'Games/battle-net'));
  add(path.join(home, 'Games/blizzard'));
  add(path.join(home, '.wine'));
  add(path.join(home, '.local/share/lutris/prefixes/battlenet'));
  // Heroic, Bottles, Faugus and Steam (non-Steam game shortcut) prefixes.
  for (const base of [
    path.join(home, 'Games/Heroic/Prefixes/default'),
    path.join(home, '.var/app/com.usebottles.bottles/data/bottles/bottles'),
    path.join(home, '.local/share/bottles/bottles'),
    faugusPrefixDir(home),
    path.join(home, '.local/share/Steam/steamapps/compatdata'),
    path.join(home, '.steam/steam/steamapps/compatdata'),
  ]) {
    try {
      for (const d of fs.readdirSync(base)) {
        add(path.join(base, d));
        add(path.join(base, d, 'pfx'));
      }
    } catch {}
  }
  // umu and Proton link <prefix>/pfx back to the prefix itself: count each prefix once.
  const seen = new Set();
  return roots.filter((r) => {
    if (!fs.existsSync(path.join(r, 'drive_c'))) return false;
    const real = fs.realpathSync(r);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

// A Windows path ("C:/Games/World of Warcraft") inside a prefix, as a Linux path.
function winToLinux(root, win) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(win.trim());
  if (!m) return null;
  const drive = m[1].toLowerCase() === 'c' ? path.join(root, 'drive_c') : path.join(root, 'dosdevices', `${m[1].toLowerCase()}:`);
  return path.join(drive, ...m[2].split(/[\\/]+/).filter(Boolean));
}

// Where Battle.net says it put World of Warcraft (product.db), and where it installs
// new games by default (Battle.net.config). Covers installs outside Program Files.
function battlenetWowDirs(root) {
  const dirs = [];
  try {
    const db = fs.readFileSync(path.join(root, 'drive_c/ProgramData/Battle.net/Agent/product.db'), 'latin1');
    for (const m of db.matchAll(/[A-Za-z]:[\\/][^\x00-\x1f"]*?World of Warcraft(?=[\x00-\x1f"]|$)/g)) {
      const d = winToLinux(root, m[0]);
      if (d && !dirs.includes(d)) dirs.push(d);
    }
  } catch {}
  try {
    for (const user of fs.readdirSync(path.join(root, 'drive_c/users'))) {
      const cfg = JSON.parse(fs.readFileSync(path.join(root, 'drive_c/users', user, 'AppData/Roaming/Battle.net/Battle.net.config'), 'utf8'));
      const base = cfg?.Client?.Install?.DefaultInstallPath;
      const d = base && winToLinux(root, `${base}/World of Warcraft`);
      if (d && !dirs.includes(d)) dirs.push(d);
    }
  } catch {}
  return dirs;
}

// Sort WoW folders into Forever installs and WoW installs without Forever.
function classify(wowDirs, forever, wowOnly) {
  for (const wow of wowDirs) {
    if (!fs.existsSync(wow)) continue;
    const dir = path.join(wow, FLAVOR);
    if (['Wow.exe', 'Wow-ARM64.exe', 'World of Warcraft.app', 'Interface'].some((f) => fs.existsSync(path.join(dir, f)))) {
      if (!forever.includes(dir)) forever.push(dir);
    } else if (!wowOnly.includes(wow)) {
      wowOnly.push(wow);
    }
  }
}

function linuxInstalls() {
  const forever = [];
  const wowOnly = [];
  const roots = candidateRoots();
  for (const root of roots) {
    classify([
      ...battlenetWowDirs(root),
      path.join(root, 'drive_c/Program Files (x86)/World of Warcraft'),
      path.join(root, 'drive_c/Program Files/World of Warcraft'),
    ], forever, wowOnly);
  }
  const battlenet = roots.filter((r) => ['drive_c/ProgramData/Battle.net', 'drive_c/Program Files (x86)/Battle.net', 'drive_c/Program Files/Battle.net']
    .some((d) => fs.existsSync(path.join(r, d))));
  return { forever, wowOnly, prefixes: battlenet };
}

// macOS: Battle.net records install paths as plain paths in product.db, and its
// default install folder in Battle.net.config. `system` stands in for / in tests.
function macInstalls(system = '/') {
  const home = os.homedir();
  const sys = (p) => path.join(system, p);
  const dirs = [];
  const shared = sys('Users/Shared/Battle.net');
  try {
    const db = fs.readFileSync(path.join(shared, 'Agent/product.db'), 'latin1');
    for (const m of db.matchAll(/\/[^\x00-\x1f"]*?World of Warcraft(?=[\x00-\x1f"]|$)/g)) dirs.push(sys(Buffer.from(m[0], 'latin1').toString('utf8')));
  } catch {}
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'Library/Application Support/Battle.net/Battle.net.config'), 'utf8'));
    const base = cfg.Client.Install.DefaultInstallPath;
    if (base) dirs.push(path.join(system, base, 'World of Warcraft'));
  } catch {}
  dirs.push(sys('Applications/World of Warcraft'), path.join(home, 'Applications/World of Warcraft'));
  const forever = [];
  const wowOnly = [];
  classify(dirs, forever, wowOnly);
  const battlenet = [sys('Applications/Battle.net.app'), path.join(home, 'Applications/Battle.net.app'), shared].filter((p) => fs.existsSync(p));
  return { forever, wowOnly, prefixes: battlenet };
}

// { forever: [...WoW: Forever folders], wowOnly: [...WoW installs without Forever], prefixes: [...where Battle.net is] }
export function findWowInstalls({ platform = process.platform, system } = {}) {
  const { forever, wowOnly, prefixes } = platform === 'darwin' ? macInstalls(system) : linuxInstalls();
  return { forever, wowOnly: wowOnly.filter((w) => !forever.some((f) => f.startsWith(w + path.sep))), prefixes };
}

export function findWowDirs() {
  return findWowInstalls().forever;
}

export function addonsDir(wowDir) {
  return path.join(wowDir, 'Interface', 'AddOns');
}

// A Forever client's command line under Wine: Wow.exe, or Wow-ARM64.exe on ARM
// (Battle.net installs it as Wow-ARM64.exe and launches it as Wow-arm64.exe).
export function isForeverClient(cmdline) {
  return /_forever_[\\/]+Wow(-arm64)?\.exe/i.test(cmdline);
}

// The running Forever client: { pid, startTicks } or null. startTicks (from
// /proc/<pid>/stat, or the start time on macOS) distinguishes a restarted client
// that happens to reuse a pid.
export function findWowProcess() {
  if (process.platform === 'darwin') return findMacProcess();
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    let cmd;
    try {
      cmd = fs.readFileSync(`/proc/${e}/cmdline`, 'latin1');
    } catch {
      continue;
    }
    if (!isForeverClient(cmd)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${e}/stat`, 'latin1');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { pid: Number(e), startTicks: Number(fields[19]) };
    } catch {
      return { pid: Number(e), startTicks: 0 };
    }
  }
  return null;
}

// `ps -axww -o pid=,lstart=,comm=` lines: "  123 Mon Nov  9 09:27:45 2026     /path/to/exe".
// The start time is in UTC (findMacProcess runs ps with TZ=UTC), so a change of time
// zone while the game runs doesn't look like a new client.
export function parseMacProcesses(text) {
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    if (!m || !/\/_forever_\/[^/]+\.app\/Contents\/MacOS\//.test(m[3])) continue;
    return { pid: Number(m[1]), startTicks: Date.parse(`${m[2]} GMT`) };
  }
  return null;
}

function findMacProcess() {
  const r = spawnSync('ps', ['-axww', '-o', 'pid=,lstart=,comm='], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  return r.status === 0 ? parseMacProcesses(r.stdout) : null;
}

export function processKey(p) {
  return p ? `${p.pid}:${p.startTicks}` : null;
}
