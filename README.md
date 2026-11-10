# T3 Code for World of Warcraft

Watch and run your [T3 Code](https://t3.codes) agent threads without leaving the game. It's a native addon for World of Warcraft: Forever, built from Blizzard's own UI templates so it looks and plays like the rest of the interface, plus a small bridge that connects it to T3 Code.

> [!WARNING]
> **Early release, still experimental.** It's built for and tested on one setup: **Omarchy 4.5.0**, **T3 Code Nightly** (0.1.7-nightly) and **World of Warcraft: Forever** (1.60.x) under Proton. **macOS** with the native client and **CachyOS** with KDE Plasma are new and less tested (see [macOS](#macos) and [CachyOS and KDE Plasma](#cachyos-and-kde-plasma)). Other setups may work but aren't supported yet. T3 Code Nightly's API changes often, so a T3 update can break things until this catches up. Expect rough edges, and please [report them](https://github.com/ryanrhughes/t3code-wow/issues).

## What it does

- **T3 Code window** (`/t3`): your threads grouped into Working, Open and Settled, filtered by project or machine. Read a thread, reply, steer a working thread or queue follow-ups, stop a run, settle or reopen it, start new threads, answer the agent's questions and approve its requests.
- **Quest tracker**: what's running, what needs you and what just finished, right under your quests, with live timers.
- **Notices**: a toast, a sound and a chat line when a thread finishes or needs you. They wait until combat ends, and stay quiet in dungeons and raids if you like.
- **Full controller support**: the D-pad moves between controls, A selects, B goes back, LB/RB switch tabs, X reads aloud and holding Y dictates. Hold both triggers and press Back to open it from anywhere.
- **Voice**: dictate replies with Omarchy's dictation, and have replies read aloud by your desktop voice (on macOS, the system voice) or the game's.
- **Screenshots**: attach what's on your screen to a message so the agent can see your game.
- **Every machine**: threads from your other computers via T3 Connect, all in one list.
- **Usage**: your providers' plans and limits, the same as Omarchy's Agents panel shows.
- A minimap button and a game-menu entry, for opening it without a keyboard.

## Requirements

- **Omarchy 4.5.0** (Hyprland), **CachyOS** with KDE Plasma (see [CachyOS and KDE Plasma](#cachyos-and-kde-plasma)), or **macOS** (see [macOS](#macos)). On Omarchy the bridge reads the game window with Hyprland's screen capture, and dictation and usage come from Omarchy's own tools.
- **T3 Code Nightly**, installed and running. Its `t3` command gives the bridge a login.
- **World of Warcraft: Forever**, installed with Battle.net: Omarchy's Battle.net (Proton), Battle.net in Faugus Launcher, Lutris or Steam on CachyOS, or the native Mac app.
- **Node.js 22** or newer.
- **Game sound on.** The addon learns about new updates through silent sounds; with sound off it falls back to slower polling.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ryanrhughes/t3code-wow/main/install.sh | bash
```

It finds World of Warcraft: Forever in Omarchy's Battle.net, in the prefixes Faugus Launcher and Lutris recorded, or wherever Battle.net installed it (for anything unusual, add `bash -s -- --wow "/path/to/World of Warcraft"`). It installs the addon into the game, gives the bridge a T3 Code session limited to reading and running threads, and starts the bridge as the `t3code-wow` user service.

Then it tells you what to do in the game and waits until the game checks in. The first time, **fully quit and restart World of Warcraft**: the game only finds new addon folders when it starts. After that, updates only need a `/reload`.

To install from a clone instead, run `./install.sh` in it.

### Update

Run the same install command again:

```bash
curl -fsSL https://raw.githubusercontent.com/ryanrhughes/t3code-wow/main/install.sh | bash
```

It downloads the latest version, replaces the installed copy and restarts the bridge, keeping your settings, T3 Code session and machines. Then type `/reload` in game; the installer tells you when an update needs a full game restart instead. To install a specific release, pipe to `T3CODE_WOW_REF=v0.2.0 bash` instead of `bash`. From a clone, `git pull` and run `./install.sh` again.

### macOS

The same install command works on a Mac with the native WoW: Forever client. Install Node.js 22 first (`brew install node`). The installer finds the game in `/Applications/World of Warcraft` or wherever Battle.net put it, and runs the bridge as a launch agent (`~/Library/LaunchAgents/t3code-wow.plist`) instead of a systemd service.

- **Screen Recording permission.** The bridge reads the strip with macOS's `screencapture`, which needs Screen Recording. Node never gets that permission: the installer builds a small helper app, `~/Applications/T3Code WoW Capture.app`, which only captures the game: the strip corner and, for screenshots, the game window itself, and the bridge asks it for each capture. The first time, macOS asks to let **T3Code WoW Capture** record the screen: click Open System Settings and turn it on under Privacy & Security > Screen & System Audio Recording. The bridge picks it up within a few seconds. Upgrading Node doesn't ask again, and neither does an update, unless the helper itself changed (the installer says so). Its script is in `bridge/src/capture.js`.
- **Upgrading from 0.2.0.** That version needed Screen Recording for `node`, which lets every Node program on your Mac record the screen. Turn `node` off under Screen & System Audio Recording. macOS 26 may not list `node` even while it's allowed; then `tccutil reset ScreenCapture` clears every app's Screen Recording permission, and you turn back on the ones you use.
- **Display settings.** Run the game at the display's full resolution (its Retina resolution on a Retina display), fullscreen or windowed. A resolution the display stretches blurs the strip.
- **Speech** uses the system voice (`say`). **Dictation** isn't available on macOS yet, and the Usage tab shows what T3 Code reports.
- `~/.local/bin` isn't on a Mac's PATH by default. The installer says so; add it to your shell profile, or run `~/.local/bin/t3code-wow`.

### CachyOS and KDE Plasma

The same install command works on CachyOS (or another Arch system) running KDE Plasma 6. Install Node.js first (`sudo pacman -S nodejs`). The installer finds Battle.net in any prefix Faugus Launcher or Lutris knows about, in `~/Faugus`, or in Steam, Bottles and Heroic prefixes.

- **Screen link.** KWin doesn't support the screen capture `grim` uses, so the bridge reads the game through KWin's own D-Bus screenshot interface with `busctl`, which ships with systemd. There's nothing to install or allow. The game must be on the current virtual desktop and not minimized.
- **Screenshots** come out as JPEG when ImageMagick is installed (`sudo pacman -S imagemagick`), and as PNG otherwise.
- **Speech** needs a desktop voice: `sudo pacman -S speech-dispatcher espeak-ng`. **Dictation** uses `voxtype` with `pw-record` if you have them. The Usage tab shows what T3 Code reports.
- Other desktops on CachyOS: Hyprland works like Omarchy (install `grim`), and an X11 session uses ImageMagick's `import`. GNOME isn't supported, since it doesn't let other programs capture the screen without asking every time.

### Uninstall

```bash
t3code-wow uninstall
```

This removes the addon and its update folders, its settings in the game, the bridge service (or launch agent), the bridge's T3 Code sessions (here and on any machine you added) and its files. On macOS it also removes T3Code WoW Capture and its Screen Recording permission. If you allowed `node` for version 0.2.0, turn that off yourself (see [macOS](#macos)).

## Using it

- `/t3` opens or closes the window. You can also use the minimap button, the game menu (Esc), or hold both triggers and press Back on a controller.
- `/t3 new` starts a thread, `/t3 usage` opens the usage tab, `/t3 settings` the settings.
- `/t3 unlock` lets you drag the tracker section somewhere else; Settings → Reset tracker puts it back under your quests.
- To see threads from another machine on your tailnet, run `t3code-wow env add <host>`. It finds the machine's T3 Code over Tailscale and creates a session for the bridge over SSH.

## Commands

```bash
t3code-wow status         # what the bridge sees: T3 Code, the game, the screen link, the addon
t3code-wow status --log   # the same, with recent log lines
t3code-wow env            # other machines shown in game (add <host> / remove <name>)
t3code-wow uninstall      # remove everything (see above)
```

## When something's wrong

1. Run `t3code-wow status --log` and check each line.
2. In game, run `/t3 selftest`. It checks each step between the game and T3 Code and says which one fails.
3. `/t3 report` fills the T3 Code message box with diagnostics and attaches a screenshot of your game. Send it to an agent, or copy the text into an issue.

If the tracker says live updates are paused, do a `/reload`: the game allows a fixed number of updates per session (1,200 by default), which normally lasts many hours.

## How it works

Addons can't open network connections or read files, so the addon and the bridge talk through what the game does allow:

| Direction | How |
| --- | --- |
| Game → bridge | A small strip of coloured squares in the top-left corner for about a second after you do something. The bridge reads it with a screen capture (`grim` on Hyprland, KWin's D-Bus screenshot interface on KDE Plasma, `screencapture` on macOS). |
| Bridge → game | Load-on-demand "slot" addons. The game reads a slot's Lua from disk when it loads, so the bridge writes a fresh snapshot there first. |
| "New data" signal | Large silent sound files the bridge fills or empties. The game re-reads big sounds every time it plays them, so the addon knows when to load the next slot. |

The bridge talks to T3 Code over the same WebSocket API its apps use. Details, measurements and design decisions are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- **The strip is encrypted.** Streams and recordings show it, so every frame is encrypted and authenticated (ChaCha20 and HMAC-SHA-256) with a key only the bridge and your addon have. To anyone else it's noise, and the bridge ignores anything it can't authenticate.
- **Addon managers.** WowUp shows a single "T3 Code" entry. Leave the `T3Code_S###` folders alone: the addon needs them.
- **Nothing else.** The addon never sends anything to Blizzard. The bridge doesn't read game memory or press keys for you; it reads pixels and writes files in the addon folder.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request. Coding agents should start with [AGENTS.md](AGENTS.md).

## Credits

- [wow-ai](https://github.com/chelinho139/wow-ai) and [wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex) measured how the Forever client loads files, plays sounds and handles the gamepad. The strip-and-slot approach builds on their work.
- [Bellular](https://www.youtube.com/@BellularGaming) ([@BellularGaming](https://x.com/BellularGaming)) gave the idea of making this an in-game addon instead of a desktop overlay.

## License

[MIT](LICENSE). This is a fan project, not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft is a trademark of Blizzard Entertainment. Use it at your own discretion.
