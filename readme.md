# Agent Toolkit

A personal Claude Code [plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) marketplace for open-source and hobby projects.

## Setup

Add the marketplace from a local checkout or from GitHub:

```
/plugin marketplace add ~/repos/silverlionapps/agent-toolkit
/plugin marketplace add AriEncarnacion/agent-toolkit
```

## Installing Plugins

```
/plugin install <plugin-name>@agent-toolkit
```

Some plugins ask for a narrower scope in their README. [`dredd`](plugins/dredd/README.md) is installed with `--scope local`, once in each project that uses it.

### Available Plugins

| Plugin | Description |
| --- | --- |
| [`dredd`](plugins/dredd/README.md) | Re-asserts your CLAUDE.md rules with TypeSafe's Jev decision model — holds commands that likely break a hard rule, cites borderline ones, reviews diffs and PRs on demand, and keeps a per-session ledger in a pane |
| [`token-weather`](plugins/token-weather/README.md) | A live forecast of the context window drawn in the band above the prompt — weather icon, percent used, a 12-turn sparkline, and the last turn's change |
| [`semantic-diagrams`](plugins/semantic-diagrams/README.md) | Ownership-aware architecture, migration, and before/after diagrams in Mermaid — named owner boundaries, fixed status colours and legend, rendered to a local HTML page and published as an Artifact on demand |

## Updating Plugins

Auto-update is off by default for third-party marketplaces. To turn it on, go to `/plugin` → **Marketplaces** → select `agent-toolkit` → **Enable auto-update**. Plugins then update when Claude Code starts.

To update by hand:

```
/plugin marketplace update agent-toolkit
```

After any update, run `/reload-plugins` in an active session to pick up the changes.

## Contributing

Prerequisites:
- A checkout of this repository
- For skills, agents and commands: the `plugin-dev` plugin from the `claude-plugins-official` marketplace

### Creating a New Plugin

Use `/plugin-dev:create-plugin` in Claude Code to scaffold the plugin. It walks through component design, implementation and validation. **All new skills, agents, commands and command hooks must be created with this skill.**

### Creating a Mod

A mod is a plugin whose behaviour is a TypeScript hooks module: live panes, bands above the prompt, status lines, tool-call guards. Build it the way [Getting started with Claude Code mods](https://claude.dev/blog/getting-started-with-claude-code-mods/) describes, then follow this repo's [mod rules](.claude/rules/mods.md) (README requirements, tests, checks). Mods do not go through `/plugin-dev:create-plugin`. [`token-weather`](plugins/token-weather/README.md) is a working reference.

### Adding an Existing Plugin

To audit a plugin that already exists, say in Claude Code:

```
Please use /plugin-dev:create-plugin to audit <my_plugin_name> instead of creating a new one to ensure it's following best practices.
```

### Adding Your Plugin

1. Copy the plugin into the `plugins/` directory
2. Test it locally. `install` takes a plugin name, not a path, so register a marketplace
   pointing at your working copy first (see **Workflow** in [CLAUDE.md](CLAUDE.md#workflow)):

   ```
   /plugin marketplace add <path to a dir holding marketplace.json>
   /plugin install <plugin-name>@<that marketplace>
   /reload-plugins
   ```
3. Run the checks before merging:

   ```
   python3 scripts/check_plugins.py
   ```

### Guidelines

- Keep plugins focused on a single purpose
- Include a clear README with usage examples
