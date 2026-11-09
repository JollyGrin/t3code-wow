import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickMacWindow, MacHelper, MAC_HELPER_VERSION, macHelperNeedsBuild, plistHelperVersion, parseHelperResponse } from '../src/capture.js';

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

test('the helper app is rebuilt only when missing, unversioned or from another script', () => {
  const dir = tmp();
  assert.equal(macHelperNeedsBuild(path.join(dir, 'Missing.app')), true);
  assert.equal(macHelperNeedsBuild(fakeApp(dir, MAC_HELPER_VERSION)), false);
  assert.equal(macHelperNeedsBuild(fakeApp(dir, 'something-older')), true);
  assert.equal(macHelperNeedsBuild(fakeApp(dir, null)), true);
  assert.equal(plistHelperVersion('<key>T3CodeWowHelperVersion</key>\n  <string>abc</string>'), 'abc');
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
    launch: (a, d) => {
      launches++;
      assert.deepEqual([a, d], [app, dir]);
      fs.writeFileSync(path.join(d, 'ready.json'), JSON.stringify({ pid: process.pid }));
      stop = fakeHelper(d, (req, id) => {
        if (req.op !== 'capture') return { ok: true, access: true, info: { windows: [], screens: [] } };
        fs.writeFileSync(path.join(d, `cap-${id}.bmp`), 'pixels');
        return { ok: true, access: true, file: `cap-${id}.bmp` };
      });
      return true;
    },
  });
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'res-stale.json'), '{}'); // left by an earlier helper
    const [a, b] = await Promise.all([helper.request('windows', { pid: 5 }), helper.request('capture', { rect: [0, 0, 10, 10], type: 'bmp' })]);
    assert.deepEqual(a.info, { windows: [], screens: [] });
    assert.equal(helper.take(b.file).toString(), 'pixels');
    assert.equal(launches, 1);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(dir), ['ready.json']);
  } finally {
    stop();
  }
});

test('a helper that never starts, or is not installed, is reported', async () => {
  const state = tmp();
  const dir = path.join(state, 'capture');
  await assert.rejects(new MacHelper({ dir, app: path.join(state, 'Missing.app'), launch: () => true }).request('windows'), /isn't installed/);
  const app = fakeApp(state, MAC_HELPER_VERSION);
  await assert.rejects(new MacHelper({ dir, app, launch: () => false }).request('windows'), /couldn't start/);
});
