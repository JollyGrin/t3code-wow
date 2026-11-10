// Text-to-speech and dictation on the desktop side.
//
// Speech: a configured command, else speech-dispatcher (`spd-say`), else espeak-ng,
// else macOS's `say`.
// Dictation: record the mic with pw-record and transcribe with `voxtype transcribe`;
// the bridge sends the text to the addon. Without those, fall back to Omarchy's
// `omarchy-dictation`, which pastes into the focused window.

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXTRA_PATHS = [
  path.join(os.homedir(), '.local/share/omarchy/bin'),
  path.join(os.homedir(), 'omarchy/bin'),
  '/usr/share/omarchy/bin',
  path.join(os.homedir(), '.local/bin'),
];

export function which(bin) {
  for (const dir of [...(process.env.PATH || '').split(':'), ...EXTRA_PATHS]) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

export class Voice {
  constructor({ ttsCommand = null, rate = 0, log = () => {} } = {}) {
    this.ttsCommand = ttsCommand; // e.g. "piper-say" or "my-tts --stdin"; text arrives on stdin
    this.rate = rate;
    this.log = log;
    this.current = null;
    this.dictating = false;
  }

  ttsEngine() {
    if (this.ttsCommand) return { kind: 'custom', cmd: this.ttsCommand };
    const spd = which('spd-say');
    if (spd) return { kind: 'spd', cmd: spd };
    const espeak = which('espeak-ng') || which('espeak');
    if (espeak) return { kind: 'espeak', cmd: espeak };
    const say = process.platform === 'darwin' && which('say');
    if (say) return { kind: 'say', cmd: say };
    return null;
  }

  describe() {
    const e = this.ttsEngine();
    const dictation = this.canOmarchyDictate()
      ? `omarchy-dictation (${this.backendName() || 'no backend set'})`
      : this.canTranscribe() ? 'voxtype' : null;
    return {
      tts: e ? (e.kind === 'custom' ? 'custom' : path.basename(e.cmd)) : null,
      dictation,
      // What to tell the player when there is nothing to dictate with; Omarchy's
      // dictation setup only exists on Linux.
      hint: dictation ? null : this.dictationHint(),
    };
  }

  dictationHint(platform = process.platform) {
    if (platform === 'darwin') return "Dictation isn't available on macOS yet.";
    return 'No dictation backend found; pick one in Omarchy > Setup > Defaults > Dictation.';
  }

  hush() {
    if (this.current) {
      try {
        this.current.kill('SIGTERM');
      } catch {}
      this.current = null;
    }
    const spd = which('spd-say');
    if (spd) spawn(spd, ['--cancel'], { stdio: 'ignore' }).on('error', () => {});
  }

  speak(text) {
    text = String(text || '').trim();
    if (!text) return false;
    const engine = this.ttsEngine();
    if (!engine) {
      this.log('speak: no text-to-speech engine found (install speech-dispatcher or espeak-ng, or set tts.command)');
      return false;
    }
    this.hush();
    let child;
    if (engine.kind === 'custom') {
      child = spawn('/bin/sh', ['-c', engine.cmd], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin.end(text);
    } else if (engine.kind === 'spd') {
      const args = ['--wait', '-e'];
      if (this.rate) args.push('-r', String(this.rate));
      child = spawn(engine.cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin.end(text);
    } else if (engine.kind === 'say') {
      // Reads the text from stdin; -r is words per minute (the system default is ~175).
      const args = ['-f', '-'];
      if (this.rate) args.push('-r', String(175 + this.rate));
      child = spawn(engine.cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin.end(text);
    } else {
      const args = ['--stdin'];
      if (this.rate) args.push('-s', String(175 + this.rate));
      child = spawn(engine.cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin.end(text);
    }
    child.on('error', (err) => this.log(`speak: ${err.message}`));
    child.on('exit', () => {
      if (this.current === child) this.current = null;
    });
    this.current = child;
    return true;
  }

  // ---- Omarchy dictation with clipboard capture ----------------------------------
  // `omarchy-dictation start|stop` drives whichever backend the user picked
  // (Voxtype, Superwhisper, Hex...), whose model stays loaded, so it's fast. Every
  // backend delivers the transcript through the clipboard and then sends a paste
  // keystroke; that keystroke doesn't reliably reach the game under Wine, so we
  // watch the clipboard and hand the text to the addon ourselves.

  canOmarchyDictate() {
    return !!(which('omarchy-dictation') && which('wl-paste'));
  }

  backendName() {
    try {
      const file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'omarchy/defaults/dictation');
      return fs.readFileSync(file, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  startOmarchy() {
    this.cancelOmarchy();
    // Each clipboard change arrives on stdout followed by a NUL.
    const watcher = spawn(which('wl-paste'), ['--type', 'text', '--watch', 'sh', '-c', 'cat; printf "\\0"'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const session = { watcher, events: [], waiters: [], stoppedAt: null, startedAt: Date.now() };
    let buf = '';
    watcher.stdout.setEncoding('utf8');
    watcher.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\0')) >= 0) {
        const text = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const ev = { text, at: Date.now() };
        session.events.push(ev);
        for (const w of session.waiters.splice(0)) w(ev);
      }
    });
    watcher.on('error', (err) => this.log(`clipboard watch: ${err.message}`));
    this.omarchy = session;
    this.dictating = true;
    spawn(which('omarchy-dictation'), ['start'], { stdio: 'ignore' }).on('error', (err) => this.log(`dictate: ${err.message}`));
    return true;
  }

  cancelOmarchy() {
    const s = this.omarchy;
    this.omarchy = null;
    this.dictating = false;
    if (!s) return;
    try {
      s.watcher.kill();
    } catch {}
  }

  // Stop the backend and resolve with the first clipboard text that appears after
  // stopping ('' if nothing was heard within the timeout).
  stopOmarchy({ timeoutMs = 15000 } = {}) {
    const s = this.omarchy;
    if (!s) return Promise.reject(new Error('not dictating'));
    this.dictating = false;
    s.stoppedAt = Date.now();
    return new Promise((resolve) => {
      let done = false;
      const finish = (text) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.omarchy === s) this.omarchy = null;
        try {
          s.watcher.kill();
        } catch {}
        resolve((text || '').trim());
      };
      const timer = setTimeout(() => finish(''), timeoutMs);
      // wl-paste also reports the clipboard as it already was when the watch starts;
      // only a change after the release is the transcript.
      const fresh = (ev) => ev.at >= s.stoppedAt && ev.text.trim();
      s.waiters.push(function wait(ev) {
        if (fresh(ev)) finish(ev.text);
        else s.waiters.push(wait);
      });
      const stopper = spawn(which('omarchy-dictation'), ['stop'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      stopper.stderr.on('data', (d) => (err += d));
      stopper.on('exit', (code) => {
        if (code && !done) {
          this.log(`omarchy-dictation stop failed: ${err.trim()}`);
          finish('');
        }
      });
    });
  }

  // ---- Direct dictation (fallback when Omarchy's dictation isn't available) -----
  // Record the default microphone ourselves and transcribe the file with Voxtype,
  // so the text comes back to the bridge instead of being pasted into whatever
  // window has focus (pasting into the game under Wine doesn't arrive).

  recorder() {
    const pw = which('pw-record');
    if (pw) return (file) => [pw, ['--rate', '16000', '--channels', '1', '--format', 's16', file]];
    const pa = which('parecord');
    if (pa) return (file) => [pa, ['--rate=16000', '--channels=1', '--format=s16le', '--file-format=wav', file]];
    const al = which('arecord');
    if (al) return (file) => [al, ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', file]];
    return null;
  }

  transcriber() {
    return which('voxtype');
  }

  canTranscribe() {
    return !!(this.recorder() && this.transcriber());
  }

  startRecording() {
    this.cancelRecording();
    const file = path.join(os.tmpdir(), `t3wow-dictation-${process.pid}-${Date.now()}.wav`);
    const [cmd, args] = this.recorder()(file);
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => this.log(`record: ${err.message}`));
    this.recording = { child, file, startedAt: Date.now(), stderr: () => stderr };
    this.dictating = true;
    return true;
  }

  cancelRecording() {
    const r = this.recording;
    this.recording = null;
    this.dictating = false;
    if (!r) return;
    try {
      r.child.kill('SIGINT');
    } catch {}
    setTimeout(() => fs.rm(r.file, { force: true }, () => {}), 2000);
  }

  // Stop recording and resolve with the transcript ('' when nothing was said).
  async stopAndTranscribe() {
    const r = this.recording;
    this.recording = null;
    this.dictating = false;
    if (!r) throw new Error('not recording');
    await new Promise((res) => {
      if (r.child.exitCode !== null) return res();
      r.child.once('exit', res);
      try {
        r.child.kill('SIGINT');
      } catch {
        res();
      }
      setTimeout(res, 3000);
    });
    try {
      const size = fs.existsSync(r.file) ? fs.statSync(r.file).size : 0;
      if (size < 3200) throw new Error(`no audio recorded${r.stderr() ? `: ${r.stderr().trim().split('\n').pop()}` : ''}`);
      const text = await new Promise((resolve, reject) => {
        execFile(this.transcriber(), ['transcribe', r.file], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) return reject(new Error(`transcription failed: ${(stderr || err.message).trim().split('\n').pop()}`));
          const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
          // `voxtype transcribe` prints progress lines first and the text last.
          const last = lines.filter((l) => !/^(Loading audio file|Audio format|Processing \d+ samples)/.test(l)).pop() || '';
          resolve(last);
        });
      });
      return text;
    } finally {
      fs.rm(r.file, { force: true }, () => {});
    }
  }
}
