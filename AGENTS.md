# Agents guide

Read [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are reviewed, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the addon and bridge talk. This file lists what you must not break and how to check your work.

## Layout

- `addon/T3Code/`: the WoW: Forever addon (Lua 5.1, Blizzard UI templates). `Core/` holds the link to the bridge (`Transport.lua`, `Codec.lua`, `Crypto.lua`) and state; `UI/` holds the window, tracker, notices, controller support and minimap button.
- `bridge/`: the Node bridge (`t3code-wow`), with no npm dependencies. `src/bridge.js` handles commands, pacing and snapshots, `src/t3.js` and `src/fleet.js` talk to T3 Code, `src/slots.js` writes slots and bells, `src/capture.js` reads the strip, `src/wow.js` finds the game.
- `tools/`: the WoW API stub and headless addon tests.

## Platforms

Linux (Omarchy, and CachyOS with KDE Plasma, the game under Proton) and macOS (the native client) are supported. Keep platform differences inside the module that owns them: `wow.js` (install folders and the running client: Wine prefixes, including those Faugus Launcher and Lutris record, and `/proc` on Linux; Battle.net's records and `ps` on macOS), `capture.js` (`grim` on Hyprland, KWin's D-Bus API through `busctl` on KDE Plasma, `import` on X11; CoreGraphics' window list through JXA and `screencapture` on macOS, which needs the Screen Recording permission), `voice.js` (`spd-say`/`espeak-ng`, or `say`), `envs.js` (the Tailscale CLI inside `Tailscale.app` on macOS) and the service in `bin/t3code-wow.js` (a systemd user unit or a launchd agent). On macOS, use only tools that ship with the system: nothing to compile or install. On KDE Plasma, likewise use only what Plasma and systemd ship.

## Measured limits of the game client

These come from measurements on live Forever clients. They look like bugs or workarounds; they aren't.

- **No sockets or file reads in addons.** The addon talks out through the pixel strip and in through load-on-demand slot addons and "bell" sounds. Don't propose a different channel without measuring it in game.
- **The client indexes addon folders at launch.** New slot folders and new addons need a full game restart. New files inside `T3Code/` and changed TOCs do load on `/reload`.
- **Each slot loads once per UI session.** Every publish costs a slot, which is why the bridge paces updates.
- **`PlaySoundFile` always reports `willPlay = true`.** Whether a bell rang is judged by `C_Sound.IsPlaying(handle)` a moment later. Bells are over the cacheable sound size, so the client re-reads them on every play.
- **Bell positions.** There are 8 rotating bells. The addon moves its bell position only from a fresh snapshot's `nextSig`, never from "the bell I heard", and the bridge never rings ahead of its own counter. Breaking either rule makes the addon alias still-rung bells and burn every slot.
- **Taint.** Don't use Blizzard's `Menu` API (it caused "blocked action" errors), don't call the gamepad binding-group APIs, and don't register anything into the objective tracker (the T3 Code section only anchors to it). Keep insecure code out of secure call paths.
- **Controller mode.** In Forever's controller mode the triggers are action-bar modifiers, Back is the game's "focus interface" binding, and the keybinding screen can't record controller chords, so key bindings can't open the window from a controller. The shortcut reads `C_GamePad.GetDeviceMappedState()` (button indexes from `ButtonBindingToIndex` are 0-based; `state.buttons` is 1-based) and only takes gamepad input while both triggers are held. Never take controller input outside the T3 window: an addon frame that receives gamepad buttons breaks the LT + RT action bars (face buttons and D-pad) even when its handler returns `true` to pass them on, so the shortcut only reads `GetDeviceMappedState` and lets the game see Back too. The window takes the controller only while it's open, and gives it back when combat starts (`PLAYER_REGEN_DISABLED`, before lockdown) because `EnableGamePadButton` is protected.

## Security invariants

- The strip is encrypted and authenticated (`Crypto.lua` ↔ `bridge/src/strip-crypto.js`). Keys stay in file-local variables in `Transport.lua`. Never put them on `ns`, which is exported as the `T3Code` global, or in SavedVariables.
- The bridge never runs commands from an unencrypted frame, and drops frames that fail authentication.
- The bridge's T3 Code session is scoped to reading and running threads. Don't widen it without a reason stated in the PR.
- Never commit tokens, keys, hostnames or personal paths.

## Slot manifests

Every `T3Code_S###` folder has an identical TOC with no `## Dependencies`, and loads `Inbox.lua` through `Slot.xml` with `<Script file="Inbox.lua"></Script>`. Addon managers fingerprint folders against all of CurseForge. This layout keeps all slots on one fixed fingerprint that matches nothing, and keeps them out of WowUp's list. Any change to the slot TOC or `Slot.xml` text changes that fingerprint: check it against WowUp (a rescan should list only "T3 Code") before shipping.

## T3 Code Nightly API

The bridge uses T3 Code's own WebSocket RPC, which changes between nightlies. When a command fails with a schema error ("Missing key …"), check the running server's definitions instead of guessing. For example, `thread.unsettle` needs `reason: "user"`, and projects are created with the `projects.mutate` RPC, not `dispatchCommand`.

## Testing

Run what covers your change, once, and read the output:

- `cd bridge && npm test` for anything in `bridge/`, including protocol and crypto. The crypto tests run the addon's Lua under both `lua5.1` (with `tools/bitstub.lua`, unsigned like WoW) and `luajit` (signed), and must agree with Node.
- `lua5.1 tools/smoke.lua …` and `luajit tools/smoke.lua …` (see CONTRIBUTING.md) for anything in `addon/`.
- Bridge tests must pass a temporary `stateDir`; never let a test touch `~/.local/state/t3code-wow`.
- The stub's widget methods come from the client's API documentation. If a real method is missing, add it to the stub; don't call methods the client doesn't have.

When to add a test: only for logic that could regress unnoticed (parsing, the bell rules, crypto agreement, a controller edge case). Don't add tests that restate a string or config value.

## Verifying UI changes

Tests don't show what the player sees. Anything visible must be checked in game: `./install.sh` from the checkout, `/reload`, then look. (`t3code-wow sync` re-copies the installed addon, not your edits.) Use the controller too when navigation is involved. Attach screenshots or a short recording to the PR, as CONTRIBUTING.md describes. `t3code-wow probe` captures the strip corner when the link itself is in question.

## Style

- Lua: tabs. JavaScript: two spaces, ES modules, Node built-ins only.
- In Markdown, write full lines with no hard wrapping.
- Text people see is plain and specific: say what happened and what to do.
- Commits are atomic, with short messages that describe the change.
