/**
 * token-weather: a one-line forecast of the context window, drawn in the band
 * above the prompt and refreshed after every turn.
 *
 * Two hooks. `turn.complete` reads the window's fill from `$.session.usage()`
 * and appends it to a 12-reading history kept in `$.state`. `ui.render` on
 * `AbovePrompt` reads that history and draws the line. Turns with no reading
 * (the first response after a compaction) leave the history unchanged. The
 * first reading has nothing to compare against, so it reads as sunrise: the
 * context the session started with.
 */
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Reading } from '../types'

const history = atom({ plugin: 'token-weather', key: 'history' } as const, [])

const BARS = '▁▂▃▄▅▆▇█'

/** The weather band for a percent of the window used. */
export const weather = (pct: number) =>
  pct < 25 ? { icon: '☀', word: 'Clear', color: 'yellow' }
  : pct < 50 ? { icon: '☁', word: 'Cloudy', color: 'cyan' }
  : pct < 75 ? { icon: '☂', word: 'Showers', color: 'blue' }
  : pct < 90 ? { icon: '☇', word: 'Storm', color: 'magenta' }
  : { icon: '↯', word: 'Compact soon', color: 'red' }

/** A token count in thousands to one decimal: 134400 → "134.4k". */
export const k = (n: number) =>
  n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : `${n}`

/** One bar per reading, scaled to that reading's window rather than to the other bars. */
export const spark = (hist: Reading[]) =>
  hist.map(r => BARS[Math.min(7, Math.floor((r.tokens / r.window) * 8))]).join('')

/** The change since the previous reading, or sunrise when there is none. */
export const change = (hist: Reading[]) => {
  const now = hist[hist.length - 1]!
  const prev = hist[hist.length - 2]
  if (prev === undefined) return `sunrise · ${k(now.tokens)} at start`
  const d = now.tokens - prev.tokens
  return `${d >= 0 ? '▲ +' : '▼ -'}${k(Math.abs(d))} last turn`
}

/** Every field the line shows, from a non-empty history. */
export const forecast = (hist: Reading[]) => {
  const now = hist[hist.length - 1]!
  const pct = Math.round((now.tokens / now.window) * 100)
  return {
    ...weather(pct),
    pct,
    used: `${k(now.tokens)} / ${k(now.window)}`,
    chart: spark(hist),
    delta: change(hist),
  }
}

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const { context } = await $.session.usage()
    if (context.tokens !== undefined && context.window > 0) {
      const r = { tokens: context.tokens, window: context.window }
      await update($, history, hist => [...hist, r].slice(-12))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const hist = await read($, history)
    if (e.props.hasSurvey || hist.length === 0) return next(e)

    const f = forecast(hist)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color={f.color} bold>{f.icon} {f.word}</Text>
        <Text>  {f.pct}%  {f.used}  </Text>
        <Text color={f.color}>{f.chart}</Text>
        <Text dimColor>  {f.delta}</Text>
      </Box>
    )
  })
}
