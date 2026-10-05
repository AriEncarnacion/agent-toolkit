import { test, expect } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const TURN = { answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as const

test('a turn end updates the forecast line on terminal and desktop', async ($, on) => {
  const readings = [36100, 134400]
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: readings.shift(), window: 200000 }, rateLimits: [] },
  }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  await $.turn.complete({ ...TURN, turnId: 't1' })
  await $.turn.complete({ ...TURN, turnId: 't2' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'token-weather', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /Showers/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /67%\s+134\.4k \/ 200k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▲ \+98\.3k last turn/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the band stays out of the way of a survey', async ($, on) => {
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 1000, window: 200000 }, rateLimits: [] },
  }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.turn.complete({ ...TURN, turnId: 't1' })

  const ui = await $.ui.mount({
    plugin: 'token-weather',
    surface: 'terminal',
    ...BAND,
    props: { ...BAND.props, hasSurvey: true },
  })
  expect(await ui.find({ type: 'Text', text: /Clear/ })).toBeUndefined()
})

test('a reading with no window is not recorded', async ($, on) => {
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 1000, window: 0 }, rateLimits: [] },
  }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.turn.complete({ ...TURN, turnId: 't1' })

  const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()
})
