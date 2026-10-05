import { test, expect } from 'claude-code/testing'

import { forecast, weather } from '../hooks/register'

test('weather bands', () => {
  expect([0, 24, 25, 49, 50, 74, 75, 89, 90, 100].map(p => weather(p).word)).toEqual([
    'Clear', 'Clear', 'Cloudy', 'Cloudy', 'Showers', 'Showers', 'Storm', 'Storm', 'Compact soon', 'Compact soon',
  ])
})

test('forecast line', () => {
  const f = forecast([{ tokens: 36100, window: 200000 }, { tokens: 134400, window: 200000 }])
  expect(f.pct).toBe(67)
  expect(f.used).toBe('134.4k / 200k')
  expect(f.chart).toBe('▂▆')
  expect(f.delta).toBe('▲ +98.3k last turn')
})

test('compaction shows a drop', () => {
  const f = forecast([{ tokens: 180000, window: 200000 }, { tokens: 20000, window: 200000 }])
  expect(f.delta).toBe('▼ -160k last turn')
  expect(f.word).toBe('Clear')
})

test('the first reading is sunrise', () => {
  const f = forecast([{ tokens: 36100, window: 200000 }])
  expect(f.delta).toBe('sunrise · 36.1k at start')
  expect(f.word).toBe('Clear')
})
