import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fake home with Wine prefixes, set before wow.js reads it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-home-'));
process.env.HOME = home;
delete process.env.WINEPREFIX;
const { findWowInstalls: findAny, parseMacProcesses, isForeverClient } = await import('../src/wow.js');
const findWowInstalls = () => findAny({ platform: 'linux' });

function touch(p, content = '') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function reset() {
  fs.rmSync(path.join(home, 'Games'), { recursive: true, force: true });
  fs.rmSync(path.join(home, '.local'), { recursive: true, force: true });
  fs.rmSync(path.join(home, 'Faugus'), { recursive: true, force: true });
}

const omarchy = () => path.join(home, 'Games/battlenet');

test("finds Forever in Omarchy's Battle.net prefix", () => {
  reset();
  touch(path.join(omarchy(), 'drive_c/Program Files (x86)/Battle.net/Battle.net.exe'));
  touch(path.join(omarchy(), 'drive_c/Program Files (x86)/World of Warcraft/_forever_/Wow.exe'));
  assert.deepEqual(findWowInstalls().forever, [path.join(omarchy(), 'drive_c/Program Files (x86)/World of Warcraft/_forever_')]);
});

test('finds the ARM client before its first launch', () => {
  reset();
  touch(path.join(omarchy(), 'drive_c/Program Files (x86)/World of Warcraft/_forever_/Wow-ARM64.exe'));
  assert.deepEqual(findWowInstalls().forever, [path.join(omarchy(), 'drive_c/Program Files (x86)/World of Warcraft/_forever_')]);
});

test('recognizes the running Forever client on x86 and ARM, not Retail', () => {
  assert.ok(isForeverClient('C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Wow.exe\0-launcherlogin\0'));
  assert.ok(isForeverClient('C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Wow-arm64.exe\0-launcherlogin\0-uid\0wowf\0'));
  assert.ok(!isForeverClient('C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Wow-arm64.exe\0'));
  assert.ok(!isForeverClient('C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Utils\\WowVoiceProxy.exe\0'));
});

test("finds a custom install folder from Battle.net's records, including another drive", () => {
  reset();
  touch(path.join(omarchy(), 'drive_c/ProgramData/Battle.net/Agent/product.db'),
    'junk\x00\x12(C:/Games/World of Warcraft\x00wowf\x00\x12"D:\\Blizzard\\World of Warcraft"');
  touch(path.join(omarchy(), 'drive_c/Games/World of Warcraft/_forever_/Wow.exe'));
  // D: is a dosdevices link to somewhere else on disk.
  const elsewhere = path.join(home, 'Games/disk-d');
  touch(path.join(elsewhere, 'Blizzard/World of Warcraft/_retail_/Wow.exe'));
  fs.mkdirSync(path.join(omarchy(), 'dosdevices'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(omarchy(), 'dosdevices/d:'));
  const r = findWowInstalls();
  assert.deepEqual(r.forever, [path.join(omarchy(), 'drive_c/Games/World of Warcraft/_forever_')]);
  assert.deepEqual(r.wowOnly, [path.join(omarchy(), 'dosdevices/d:/Blizzard/World of Warcraft')]);
});

test('tells WoW without Forever apart from no WoW at all, and ignores other games\' prefixes', () => {
  reset();
  touch(path.join(omarchy(), 'drive_c/Program Files (x86)/Battle.net/Battle.net.exe'));
  touch(path.join(omarchy(), 'drive_c/Program Files (x86)/World of Warcraft/_retail_/Wow.exe'));
  let r = findWowInstalls();
  assert.equal(r.forever.length, 0);
  assert.deepEqual(r.wowOnly, [path.join(omarchy(), 'drive_c/Program Files (x86)/World of Warcraft')]);

  reset();
  touch(path.join(omarchy(), 'drive_c/Program Files (x86)/Battle.net/Battle.net.exe'));
  touch(path.join(home, '.local/share/Steam/steamapps/compatdata/1091500/pfx/drive_c/windows/win.ini'));
  r = findWowInstalls();
  assert.deepEqual([r.forever.length, r.wowOnly.length], [0, 0]);
  assert.deepEqual(r.prefixes, [omarchy()], 'only prefixes that really hold Battle.net');
});

test("finds prefixes Faugus Launcher and Lutris recorded, and counts a prefix's pfx link once", () => {
  reset();
  // A prefix Faugus recorded anywhere, here ~/Games itself.
  const games = path.join(home, 'Games');
  touch(path.join(games, 'drive_c/Program Files (x86)/World of Warcraft/_forever_/Wow.exe'));
  touch(path.join(home, '.local/share/faugus-launcher/games.json'), JSON.stringify([{ gameid: 'battlenet', prefix: games }]));
  let r = findWowInstalls();
  assert.deepEqual(r.forever, [path.join(games, 'drive_c/Program Files (x86)/World of Warcraft/_forever_')]);

  // Faugus's default folder, where umu links each prefix's pfx back to itself.
  reset();
  const faugus = path.join(home, 'Faugus/battlenet');
  touch(path.join(faugus, 'drive_c/Program Files (x86)/World of Warcraft/_forever_/Wow.exe'));
  touch(path.join(faugus, 'drive_c/Program Files (x86)/Battle.net/Battle.net.exe'));
  fs.symlinkSync('.', path.join(faugus, 'pfx'));
  r = findWowInstalls();
  assert.deepEqual(r.forever, [path.join(faugus, 'drive_c/Program Files (x86)/World of Warcraft/_forever_')]);
  assert.deepEqual(r.prefixes, [faugus]);

  reset();
  const lutris = path.join(home, 'Games/bnet-lutris');
  touch(path.join(lutris, 'drive_c/Program Files (x86)/World of Warcraft/_forever_/Wow.exe'));
  touch(path.join(home, '.local/share/lutris/games/battlenet-1.yml'), 'game:\n  exe: drive_c/Battle.net.exe\n  prefix: ~/Games/bnet-lutris\nwine:\n  version: ge\n');
  r = findWowInstalls();
  assert.deepEqual(r.forever, [path.join(lutris, 'drive_c/Program Files (x86)/World of Warcraft/_forever_')]);
});

test("finds Forever on macOS from Battle.net's records and /Applications", () => {
  reset();
  const sys = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-sys-'));
  const mac = (opts) => findAny({ platform: 'darwin', system: sys, ...opts });
  touch(path.join(sys, 'Applications/Battle.net.app/Contents/Info.plist'));
  assert.deepEqual(mac().forever, []);
  assert.deepEqual(mac().prefixes, [path.join(sys, 'Applications/Battle.net.app')]);

  touch(path.join(sys, 'Applications/World of Warcraft/_retail_/World of Warcraft.app/Contents/Info.plist'));
  assert.deepEqual(mac().wowOnly, [path.join(sys, 'Applications/World of Warcraft')]);

  // An install on another volume, recorded by Battle.net.
  touch(path.join(sys, 'Users/Shared/Battle.net/Agent/product.db'), 'junk\x00\x12"/Volumes/Jeux Vidéo/World of Warcraft\x00wowf');
  touch(path.join(sys, 'Volumes/Jeux Vidéo/World of Warcraft/_forever_/World of Warcraft.app/Contents/Info.plist'));
  assert.deepEqual(mac().forever, [path.join(sys, 'Volumes/Jeux Vidéo/World of Warcraft/_forever_')]);
  fs.rmSync(sys, { recursive: true, force: true });
});

test('picks the Forever client out of macOS ps output', () => {
  const ps = [
    '    1 Thu Oct 29 16:12:27 2026     /sbin/launchd',
    '  700 Mon Nov  9 09:00:00 2026     /Applications/World of Warcraft/_retail_/World of Warcraft.app/Contents/MacOS/World of Warcraft',
    ' 4242 Mon Nov  9 09:27:45 2026     /Applications/World of Warcraft/_forever_/World of Warcraft.app/Contents/MacOS/World of Warcraft',
  ].join('\n');
  const p = parseMacProcesses(ps);
  assert.equal(p.pid, 4242);
  assert.equal(p.startTicks, Date.UTC(2026, 10, 9, 9, 27, 45));
  assert.equal(parseMacProcesses(ps.split('\n').slice(0, 2).join('\n')), null);
});
