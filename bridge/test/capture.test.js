import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickMacWindow, pickKwinWindow, allowedCorner, allowedWindow, cornerSize, windowScale, isHelperCommand, MAC_HELPER_JXA, MacHelper, MAC_HELPER_VERSION, macHelperNeedsBuild, plistHelperVersion, parseHelperResponse } from '../src/capture.js';

const screens = [
  { x: 0, y: 0, width: 1512, height: 982, scale: 2 }, // built-in Retina, the primary
  { x: 1512, y: -100, width: 2560, height: 1440, scale: 1 }, // external, NSScreen's bottom-left origin
];
const win = (pid, X, Y, Width, Height, extra = {}) => ({ pid, layer: 0, onscreen: true, bounds: { X, Y, Width, Height }, ...extra });

test('a window on the Retina screen', () => {
  const w = pickMacWindow({ windows: [win(5, 0, 0, 1512, 982)], screens }, 5);
  assert.deepEqual([w.found, w.visible, w.scale], [true, true, 2]);
});

test('a windowed client on the external screen, found by pid over a same-named window', () => {
  const info = { windows: [win(9, 10, 10, 800, 600), win(5, 1600, -300, 1280, 748)], screens };
  const w = pickMacWindow(info, 5);
  assert.deepEqual([w.x, w.y, w.scale], [1600, -300, 1]);
});

test('ignores menus and tiny windows, and reports a window on another Space as hidden', () => {
  const info = { windows: [win(5, 0, 0, 1512, 30, { layer: 25 }), win(5, 0, 0, 40, 40), win(5, 0, 0, 1512, 982, { onscreen: false })], screens };
  const w = pickMacWindow(info, 5);
  assert.deepEqual([w.found, w.visible], [true, false]);
  assert.equal(pickMacWindow({ windows: [], screens }, 5).found, false);
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 't3code-wow-test-'));

// A built helper app: an executable and an Info.plist carrying the helper version.
function fakeApp(dir, version) {
  const app = path.join(dir, 'Helper.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/MacOS/applet'), '');
  const key = version ? `\t<key>T3CodeWowHelperVersion</key>\n\t<string>${version}</string>\n` : '';
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleIdentifier</key>\n\t<string>com.t3code-wow.capture</string>\n${key}</dict>\n</plist>\n`);
  return app;
}

test('the helper app is rebuilt only when missing, from another script, or modified since it was built', () => {
  const dir = tmp();
  const intact = () => true;
  assert.equal(macHelperNeedsBuild(path.join(dir, 'Missing.app'), { intact }), 'missing');
  assert.equal(macHelperNeedsBuild(fakeApp(dir, MAC_HELPER_VERSION), { intact }), null);
  assert.equal(macHelperNeedsBuild(fakeApp(dir, 'something-older'), { intact }), 'old');
  assert.equal(macHelperNeedsBuild(fakeApp(dir, null), { intact }), 'old');
  assert.equal(macHelperNeedsBuild(fakeApp(dir, MAC_HELPER_VERSION), { intact: () => false }), 'modified');
  assert.equal(plistHelperVersion('<key>T3CodeWowHelperVersion</key>\n  <string>abc</string>'), 'abc');
});

test('only the helper executable itself counts as the running helper', () => {
  const app = '/Users/x/Applications/T3Code WoW Capture.app';
  assert.equal(isHelperCommand(`${app}/Contents/MacOS/applet /Users/x/.local/state/t3code-wow/capture`, app), true);
  assert.equal(isHelperCommand(`${app}/Contents/MacOS/applet`, app), true);
  assert.equal(isHelperCommand(`vim ${app}/Contents/MacOS/applet`, app), false);
  assert.equal(isHelperCommand(`${app}/Contents/MacOS/applet-other`, app), false);
  assert.equal(isHelperCommand(null, app), false);
});

test('helper answers that are not well-formed become errors', () => {
  assert.deepEqual(parseHelperResponse('{"ok":true,"file":"cap-1.bmp","access":true}'), { ok: true, file: 'cap-1.bmp', access: true });
  assert.equal(parseHelperResponse('{"ok":false,"error":"x","access":false}').access, false);
  for (const bad of ['', '{"ok":true', 'null', '{"file":"x"}']) assert.equal(parseHelperResponse(bad).ok, false);
});

// Stands in for the applet: answers each request file the way the JXA helper does.
function fakeHelper(dir, answer) {
  const timer = setInterval(() => {
    for (const n of fs.readdirSync(dir).filter((f) => /^req-[0-9a-z]+\.json$/.test(f)).sort()) {
      const id = n.slice(4, -5);
      const req = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      fs.rmSync(path.join(dir, n));
      fs.writeFileSync(path.join(dir, `res-${id}.json`), JSON.stringify(answer(req, id)));
    }
  }, 5);
  return () => clearInterval(timer);
}

test('the bridge starts the helper once, in a private folder, and trades files with it', async () => {
  const state = tmp();
  const dir = path.join(state, 'capture');
  const app = fakeApp(state, MAC_HELPER_VERSION);
  let launches = 0;
  let stop = () => {};
  const helper = new MacHelper({
    dir,
    app,
    intact: () => true,
    launch: (a, d) => {
      launches++;
      assert.deepEqual([a, d], [app, dir]);
      fs.writeFileSync(path.join(d, 'ready.json'), JSON.stringify({ pid: process.pid }));
      stop = fakeHelper(d, (req, id) => {
        if (req.op !== 'corner') return { ok: true, access: true, info: { windows: [], screens: [] } };
        fs.writeFileSync(path.join(d, `cap-${id}.bmp`), 'pixels');
        return { ok: true, access: true, file: `cap-${id}.bmp` };
      });
      return true;
    },
  });
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'res-stale.json'), '{}'); // left by an earlier helper
    fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ pid: process.pid })); // a live pid that isn't the helper
    const [a, b] = await Promise.all([helper.request('windows', { pid: 5 }), helper.request('corner', { rect: [0, 0, 10, 10] })]);
    assert.deepEqual(a.info, { windows: [], screens: [] });
    assert.equal(helper.take(b.file).toString(), 'pixels');
    assert.equal(launches, 1);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(dir), ['ready.json']);
  } finally {
    stop();
  }
});

test('a helper that never starts, is not installed, or was modified is reported', async () => {
  const state = tmp();
  const dir = path.join(state, 'capture');
  const intact = () => true;
  await assert.rejects(new MacHelper({ dir, app: path.join(state, 'Missing.app'), launch: () => true, intact }).request('windows'), /isn't installed/);
  const app = fakeApp(state, MAC_HELPER_VERSION);
  await assert.rejects(new MacHelper({ dir, app, launch: () => false, intact }).request('windows'), /couldn't start/);
  let launched = false;
  const modified = new MacHelper({ dir, app, intact: () => false, launch: () => (launched = true) });
  await assert.rejects(modified.request('windows'), /has been changed since it was installed/);
  assert.equal(launched, false);
});

test('a helper that quits mid-request is noticed without waiting out the timeout', async () => {
  const dir = path.join(tmp(), 'capture');
  fs.mkdirSync(dir);
  const helper = new MacHelper({ dir, app: '/nonexistent.app' });
  helper.ensure = async () => {};
  helper.pid = 2 ** 22 + 12345; // no such process: the helper is gone
  const t0 = Date.now();
  await assert.rejects(helper.request('windows', {}, { timeout: 5000 }), /didn't answer/);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(helper.pid, null);
});

test('the helper captures only the strip corner of a visible game window, or a visible game window by id', () => {
  const strip = { width: 672, height: 192, searchY: 40 };
  const retina = { ...win(5, 0, 0, 1512, 982), id: 42 }; // on the built-in Retina screen (scale 2)
  const external = { ...win(5, 1600, -300, 1280, 748), id: 44 }; // on the external screen (scale 1)
  const elsewhere = { ...win(5, 0, 0, 1512, 982, { onscreen: false }), id: 43 }; // on another Space
  const small = { ...win(5, 100, 100, 200, 150), id: 45 }; // smaller than the corner at scale 2
  const ok = (w, r) => allowedCorner({ windows: [w], screens }, r, strip);
  assert.deepEqual(cornerSize(2, strip), { width: 336, height: 136 });
  assert.equal(windowScale(screens, external.bounds), 1);
  assert.equal(ok(retina, [0, 0, 336, 136]), true);
  assert.equal(ok(retina, [0, 0, 672, 232]), false); // the scale-1 size on a Retina screen
  assert.equal(ok(external, [1600, -300, 672, 232]), true);
  assert.equal(ok(retina, [0, 0, 1512, 982]), false); // the whole window, including what covers it
  assert.equal(ok(retina, [500, 500, 336, 136]), false); // another place in the window
  assert.equal(ok(elsewhere, [0, 0, 336, 136]), false);
  assert.equal(ok(small, [100, 100, 336, 136]), false); // would reach past the window
  for (const bad of [null, [1, 2, 3], ['0', 0, 1, 1], [0, 0, Infinity, 1], [0, 0, -5, 10]]) assert.equal(ok(retina, bad), false);
  assert.equal(allowedWindow([retina, elsewhere], 42), true);
  assert.equal(allowedWindow([retina, elsewhere], 43), false);
  assert.equal(allowedWindow([retina], 7), false);
  assert.equal(pickMacWindow({ windows: [retina], screens }, 5).id, 42);
  // The helper runs these same rules.
  for (const f of [windowScale, cornerSize, allowedCorner, allowedWindow]) assert.ok(MAC_HELPER_JXA.includes(f.toString()));
});

const kwin = (pid, caption, extra = {}) => ({ pid, caption, uuid: `{${pid}}`, x: 10, y: 20, width: 1280, height: 720, minimized: false, desktops: ['d1'], ...extra });

test('KWin: the game by pid over a same-named window, else by caption', () => {
  const infos = [kwin(9, 'World of Warcraft'), kwin(5, 'World of Warcraft', { x: 300 })];
  assert.equal(pickKwinWindow(infos, 5, 'd1').x, 300);
  assert.equal(pickKwinWindow(infos, 77, 'd1').uuid, '{9}');
  assert.equal(pickKwinWindow([kwin(9, 'Battle.net')], 77, 'd1').found, false);
});

test('KWin: hidden when minimized or on another desktop, visible on all desktops', () => {
  assert.equal(pickKwinWindow([kwin(5, 'World of Warcraft', { minimized: true })], 5, 'd1').visible, false);
  assert.equal(pickKwinWindow([kwin(5, 'World of Warcraft')], 5, 'd2').visible, false);
  assert.equal(pickKwinWindow([kwin(5, 'World of Warcraft', { desktops: [] })], 5, 'd2').visible, true);
});
