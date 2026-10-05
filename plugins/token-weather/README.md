# token-weather

A live forecast of your context window, drawn in the band above the prompt and refreshed after every turn:

```
☂ Showers  67%  134.4k / 200k  ▂▃▄▅▆  ▲ +98.3k last turn
```

| Used | Forecast | Colour |
| --- | --- | --- |
| under 25% | ☀ Clear | yellow |
| 25–49% | ☁ Cloudy | cyan |
| 50–74% | ☂ Showers | blue |
| 75–89% | ☇ Storm | magenta |
| 90% and up | ↯ Compact soon | red |

After the forecast come the percent used, the tokens used out of the window, a chart of the last 12 turns (each bar is how full the window was after that turn), and how much the last turn added. The first reading has nothing to compare against, so it reads as sunrise: `sunrise · 36.1k at start`. After a compaction the change reads as a drop (`▼ -160k last turn`).

Built against Claude Code 2.1.289.

## Installation

```
/plugin install token-weather@agent-toolkit
/reload-plugins
```

The band appears once the first turn of a session finishes.

## Capabilities

None beyond drawing: it reads the session's context usage and keeps its own history in session state. It runs no processes, touches no files, makes no network calls and reads no environment variables.

## How it works

This is a working reference for this repo's [mod rules](../../.claude/rules/mods.md). For how mods work in general, read [Getting started with Claude Code mods](https://claude.dev/blog/getting-started-with-claude-code-mods/).

```
plugins/token-weather/
  .claude-plugin/plugin.json   — manifest; "types" points at the state contract
  hooks/hooks.json             — { "modules": ["./register.tsx"] }
  hooks/register.tsx           — the hooks module
  types/index.d.ts             — PluginState contract for the history in $.state
  tests/forecast.test.ts       — unit tests for the pure formatting functions
  tests/band.test.tsx          — engine tests: raises turn.complete, mounts the band
  tsconfig.json                — extends the types Claude Code writes on load
```

The module registers two hooks:

- **`turn.complete`** reads `$.session.usage()` and appends `{ tokens, window }` to a 12-reading history kept in `$.state`, so it survives hot reloads.
- **`ui.render` on `AbovePrompt`** reads the history and draws the line from `$.ui.resolve(e)`'s `Box` and `Text`. It returns `next(e)`, drawing nothing, when there is no history yet or a survey holds the band.

## Tests

```
claude plugin test plugins/token-weather
```

`tests/band.test.tsx` answers `session.usage` with fixed readings, raises `turn.complete` through the engine, then mounts `AbovePrompt` on the terminal and desktop surfaces and checks the drawn line. It also covers the survey and zero-window cases. `tests/forecast.test.ts` covers the weather bands, number formatting, the sunrise reading and the drop after a compaction.

To type-check on a machine where Claude Code has loaded the mod: `npx tsc -p plugins/token-weather`.
