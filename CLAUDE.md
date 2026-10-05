# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A personal Claude Code plugin marketplace for open-source and hobby projects. It is registered as the `agent-toolkit` marketplace via `.claude-plugin/marketplace.json` and contains plugins in the `plugins/` directory.

This is not an application and has no build step. Most plugins are Claude Code plugin definitions (plugin.json, SKILL.md, README.md). Mods — plugins whose `hooks/hooks.json` names a TypeScript hooks module — also carry TypeScript and their own `tests/`, run by `claude plugin test`; their rules are in [`.claude/rules/mods.md`](.claude/rules/mods.md).

`scripts/check_plugins.py` checks marketplace sync, runs `claude plugin validate`, and runs `claude plugin test` for changed mods. There is no CI: run `python3 scripts/check_plugins.py` locally before merging. Its own tests run with `python3 -m unittest discover tests/check_plugins`.

## Architecture

```
.claude-plugin/marketplace.json   — Marketplace manifest; lists all published plugins
plugins/<name>/
  .claude-plugin/plugin.json      — Plugin manifest (name, version, description)
  agents/<agent-name>.md           — Subagent definitions (auto-discovered)
  skills/<skill-name>/SKILL.md    — Skill definitions (frontmatter + instructions)
  commands/<command-name>.md       — Slash commands (auto-discovered)
  hooks/hooks.json                 — Command hooks ({ "hooks": ... }) or, for a mod, the hooks module ({ "modules": [...] })
  hooks/register.tsx               — Mod: the hooks module
  types/index.d.ts                 — Mod: state contract, named by "types" in plugin.json
  tests/*.test.ts(x)               — Mod: tests run by `claude plugin test`
  .mcp.json                        — MCP server definitions
  scripts/                         — Helper utilities (referenced, not auto-discovered)
  README.md                        — User-facing documentation
```

The marketplace manifest (`marketplace.json`) must stay in sync with the plugins that exist in `plugins/`. Each plugin's `source` field points to its directory.

## Contributing Requirements

- **Skills, agents, commands and command hooks must be created using `/plugin-dev:create-plugin`** from the `claude-plugins-official` marketplace.
- **Porting an existing plugin or skill also requires `/plugin-dev:create-plugin`.** Run the skill but use it as an auditing template — instead of creating from scratch, use it to validate the existing plugin against best practices and correct format. Do not skip this step just because the plugin already exists.
- **Mods follow [`.claude/rules/mods.md`](.claude/rules/mods.md) instead.** `/plugin-dev:create-plugin` does not understand hooks modules. A plugin with both a hooks module and classic components is held to both, each for its own components.
- **Run `python3 scripts/check_plugins.py` locally before merging.** Every check must pass.
- When adding or updating a plugin, you **must** also:
  1. Create or update the plugin's `README.md` with installation and usage instructions
  2. Update the **Available Plugins** table in the repo's `readme.md` — add the plugin name (hotlinked to its README), and description
  3. Update `marketplace.json` if the plugin name, description, or version changed

## Comments

Comments go stale; code does not.

- **Never write inline comments.** Nothing at the end of a line of code, nothing
  between statements. This is where misinterpretations and dated claims accumulate,
  and a comment that has drifted from the code is worse than no comment: it is read
  as truth and acted on. Delete them on sight in code you touch.
- **Docstrings and file-header comments are expected.** They state what a file or
  function is *meant* to achieve. When the code stops matching that intent, one of
  the two is wrong and the gap is visible and fixable.
- **A claim about behaviour belongs in a test.** Anything worth asserting is written
  as a check that fails when it stops being true. Executing the code and observing
  what it does supersedes any prose about it.

## Versioning

New plugins start at `1.0.0` and follow [semver](https://semver.org/) from there. In this repo, merged = released — there is no separate beta/development phase.

## Workflow

Test a plugin locally during development. There is no path form of `install` — it takes a plugin
name from a marketplace — so stand up a throwaway marketplace pointing at your working copy:

```
mkdir -p /tmp/dev-mkt/.claude-plugin
ln -s <repo>/plugins/<plugin-name> /tmp/dev-mkt/<plugin-name>
# write /tmp/dev-mkt/.claude-plugin/marketplace.json with a name of its own and
#   "plugins": [{ "name": "<plugin-name>", "source": "./<plugin-name>", "version": "..." }]
claude plugin marketplace add /tmp/dev-mkt
claude plugin install <plugin-name>@<that marketplace> --scope local
/reload-plugins
```

Two things that bite:

- **`source` must start with `./`.** An absolute path is rejected with
  `source: Invalid string: must start with "./"`, which is why the plugin gets symlinked next to
  the manifest rather than referenced where it lives.
- **Give the marketplace its own name.** `agent-toolkit` is the name of the published
  marketplace, so reusing that name installs the published plugin instead of your branch — and `--scope local`
  keeps the dev copy to this project.

**A plugin executes from its marketplace entry, not from `~/.claude/plugins/cache/`.** `install`
writes a copy under `cache/` and records it as `installPath`, but `${CLAUDE_PLUGIN_ROOT}` resolves
to `known_marketplaces.json`'s `installLocation` for the marketplace plus the plugin's `source`
from that marketplace's own `marketplace.json`. For the symlinked dev setup above that composes to
your working tree, so edits are live with no reinstall — the `/reload-plugins` above registers a
newly installed plugin, it is not needed again after an edit — and the `cache/` copy going stale is
expected and means nothing. Diffing against `installPath` to check "am I testing my branch?"
compares a copy that never runs.

After a `marketplace.json` edit, `claude plugin marketplace update <name>` re-validates it.
`claude plugin marketplace list` shows what is registered; `claude plugin marketplace remove
<name>` and `claude plugin uninstall <plugin-name>@<that marketplace> --scope local` clean up when
the branch merges — **`uninstall` needs the same `--scope` the install used**, or it fails saying
the plugin is not installed in user scope. Installing a dev copy alongside the published one leaves
two entries for the same plugin name in `~/.claude/plugins/installed_plugins.json` — uninstall the
published one while testing so it is unambiguous which copy a run exercised.

Install a published plugin from this marketplace:
```
/plugin install <plugin-name>@agent-toolkit
```

The marketplace name is `agent-toolkit` (defined in `.claude-plugin/marketplace.json`).
