# Contributing

Contributions are welcome. This is an early, experimental release, so bug reports from real use are just as valuable as code.

The supported setup is **Omarchy 4.5.0**, **T3 Code Nightly** and **World of Warcraft: Forever** under Proton. macOS with the native client and CachyOS with KDE Plasma are also supported, with less testing. Changes that make other setups work are welcome, as long as they don't break those.

## Issues

Open an issue for a bug you can reproduce, or for a specific idea. Keep it detailed but straightforward: say what happened, plainly, and leave out the essay.

For a bug, include:

- **Versions**: Omarchy (`omarchy-version`) or macOS (`sw_vers`), T3 Code Nightly (`t3 --version`), t3code-wow (`t3code-wow status`), and your controller if it's involved.
- **What you did, what you expected, what happened instead.** Steps to reproduce if you have them.
- **`t3code-wow status --log`** output, and the text from `/t3 report` in game.
- **A screenshot or short video** for anything you can see: a layout problem, a wrong state, a notice that didn't appear. It's often the fastest way to explain the problem.

One problem per issue. If you're not sure it's a bug, say so and describe what you saw.

## Pull requests

- **One problem per PR.** Small, focused changes get reviewed and merged faster.
- **Say what changes and why**, in plain terms. Link the issue if there is one.
- **Say how you verified it**: the tests you ran and what you checked in game, with what you saw. Mention anything you couldn't check. "Tests pass" alone isn't enough.
- **Show UI changes.** Anything you can see in game needs before and after screenshots, and a short recording when motion, timing, controller navigation or interaction is part of the change. Drag them into the PR description so GitHub hosts them; never commit screenshots or recordings to the repo. If nothing visible changes, one line saying why is enough.
- **Commits** should be atomic, with short messages that describe the change.
- AI-assisted contributions are fine. You're responsible for having read, run and checked the result, the same as any other change.

## Development

```bash
git clone https://github.com/ryanrhughes/t3code-wow
cd t3code-wow
./install.sh                 # installs the addon and the bridge from your checkout
```

After editing, run `./install.sh` from your checkout, then `/reload` in game. It copies your checkout over the installed copy, puts the addon into the game and restarts the bridge. (`t3code-wow sync` only re-copies the *installed* addon, so it won't pick up your edits.) New files inside the addon load on `/reload`; new addon folders (such as live-update slots) need a full game restart.

Tests:

```bash
cd bridge && npm test                                        # bridge, protocol, crypto, Lua/Node agreement
node tools/snapshot.mjs /tmp/t3snap.lua                      # a real snapshot from your running T3 Code
lua5.1 tools/smoke.lua addon/T3Code /tmp/t3snap.lua "$(cat /tmp/t3snap.view)"   # drive the addon headlessly
luajit tools/smoke.lua addon/T3Code /tmp/t3snap.lua "$(cat /tmp/t3snap.view)"   # same, with signed bit ops
```

On macOS, Homebrew doesn't package Lua 5.1: `brew install luajit` covers the LuaJIT runs, and the `lua5.1` ones need Lua 5.1 built from source.

`tools/wowstub.lua` stands in for the WoW API. Its widget methods come from the client's own API documentation, so calling a method that doesn't exist fails in tests the way it would in game.

Before changing how the addon and bridge talk, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [AGENTS.md](AGENTS.md): several things that look like workarounds are deliberate, measured limits of the game client.

## Style

- Lua: tabs. JavaScript: two spaces, ES modules, no dependencies beyond Node itself.
- Text people see (in game, in the CLI, in docs) is plain and specific: say what happened and what to do, without jargon.

## Security

If you find a security problem, such as a way to send commands to someone's agents or read what they're sending, please report it privately through [GitHub's security advisories](https://github.com/ryanrhughes/t3code-wow/security/advisories/new) rather than a public issue.
