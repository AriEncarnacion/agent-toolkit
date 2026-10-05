/**
 * Engine tests of Monitor: Bash and MCP calls through dredd's `tool.call`
 * hook, the hold in the pane and in the band, the pass-throughs, the band's
 * counts and toggle, and the ledger's save to `$.store`.
 */
import { test, expect } from 'claude-code/testing'

import type { Kept } from '../hooks/dredd'
import { BAND, PANE, RULES, turnOn, world } from './world'

const LAMBDA = 'aws lambda invoke --function-name billing --payload \'{"action":"raw_command"}\' out.json'
const HOLD = { 'no-lambda-raw': { noul: 0.86 }, 'no-force-push': { noul: 0.02 }, _kind: { choice: 'deploy' } }
const CITE = { 'no-lambda-raw': { noul: 0.05 }, 'no-force-push': { noul: 0.55 }, _kind: { choice: 'write' } }
const PASS = { 'no-lambda-raw': { noul: 0.01 }, 'no-force-push': { noul: 0.02 }, _kind: { choice: 'read-only' } }

/** The refusal's reason, whether the call came back as `{ deny }` or as an errored result. */
const textOf = (result: unknown) => {
  const r = result as { deny?: string; text?: string }
  return r.deny ?? r.text ?? JSON.stringify(result)
}

test('a harmless command runs and the ledger stays empty', async ($, on) => {
  const w = world(on, { answers: PASS })
  await turnOn($)
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(w.ran).toEqual(['Bash'])
  expect(w.sent.length).toBe(1)
  expect(Object.keys(w.sent[0]!.questions).sort()).toEqual(['_kind', 'no-force-push', 'no-lambda-raw'])

  const ui = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /0 held · 0 violations · 0 citations/ })).toBeDefined()
  await ui.unmount()
})

test('a borderline command is cited, runs, and is saved to the store', async ($, on) => {
  const w = world(on, { answers: CITE })
  await turnOn($)
  await $.tool.call({ tool: 'Bash', command: 'git push --force-with-lease' })
  expect(w.ran).toEqual(['Bash'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'dredd', surface, ...BAND })
    expect(await band.find({ type: 'Text', text: /1 citations/ })).toBeDefined()
    await band.unmount()
    const pane = await $.ui.mount({ plugin: 'dredd', surface, ...PANE })
    expect(await pane.find({ type: 'Text', text: /citation\s+no-force-push\s+0\.55\s+git push/ })).toBeDefined()
    await pane.unmount()
  }

  await w.clock.advance(2000)
  const kept = w.store.get('ledger:s1') as Kept
  expect(kept.entries.map(e => [e.verdict, e.ruleId, e.kind])).toEqual([['citation', 'no-force-push', 'write']])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a hard-rule command is held in the pane and runs on Proceed (${surface})`, async ($, on) => {
    const w = world(on, { answers: HOLD })
    await turnOn($)
    const shown = w.nextOpen()
    const call = $.tool.call({ tool: 'Bash', command: LAMBDA })
    await shown

    const pane = await $.ui.mount({ plugin: 'dredd', surface, ...PANE })
    expect(await pane.find({ type: 'Text', text: /hard rule no-lambda-raw/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /never execute raw_command/ })).toBeDefined()
    await pane.press({ key: 'proceed' })
    await w.clock.advance(250)
    await call
    expect(w.ran).toEqual(['Bash'])
    expect(await pane.find({ type: 'Text', text: /held\s+no-lambda-raw\s+0\.86\s+proceed/ })).toBeDefined()
    await pane.unmount()
  })
}

test('Cancel refuses a held command with the rule in the reason', async ($, on) => {
  const w = world(on, { answers: HOLD })
  await turnOn($)
  const shown = w.nextOpen()
  const call = $.tool.call({ tool: 'Bash', command: LAMBDA })
  await shown
  const pane = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...PANE })
  await pane.press({ key: 'cancel' })
  await w.clock.advance(250)
  const result = await call
  expect(w.ran).toEqual([])
  expect(textOf(result)).toMatch(/no-lambda-raw: Agents must never execute raw_command actions on a lambda\. \(p=0\.86\)\. The user refused it\./)
  await pane.unmount()
})

test('the band carries the held prompt when the pane is not seated', async ($, on) => {
  const w = world(on, { answers: HOLD })
  await turnOn($)
  const shown = w.nextOpen()
  const call = $.tool.call({ tool: 'Bash', command: LAMBDA })
  await shown
  const band = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /Dredd held aws lambda invoke/ })).toBeDefined()
  await band.press({ key: 'band-proceed' })
  await w.clock.advance(250)
  await call
  expect(w.ran).toEqual(['Bash'])
  await band.unmount()
})

test('a session with no surface to draw on refuses a hold without asking', async ($, on) => {
  const w = world(on, { answers: HOLD, surfaces: [] })
  await turnOn($)
  const result = await $.tool.call({ tool: 'Bash', command: LAMBDA })
  expect(w.ran).toEqual([])
  expect(w.opens()).toBe(0)
  expect(textOf(result)).toMatch(/Nobody is at the prompt/)
})

test('an MCP call is checked with its arguments redacted', async ($, on) => {
  const w = world(on, { answers: PASS })
  await turnOn($)
  await $.tool.call({ tool: 'mcp__aws__lambda_invoke', functionName: 'billing', password: 'pw-secret-123' })
  expect(w.ran).toEqual(['mcp__aws__lambda_invoke'])
  const state = w.sent[0]!.state as { tool: string; input: string }
  expect(state.tool).toBe('mcp__aws__lambda_invoke')
  expect(state.input.includes('billing')).toBe(true)
  expect(state.input.includes('pw-secret-123')).toBe(false)
  expect(state.input.includes('tool_use_id')).toBe(false)
})

test('a Jev error leaves the command running and records it unchecked', async ($, on) => {
  const w = world(on, { answers: HOLD, status: 500 })
  await turnOn($)
  await $.tool.call({ tool: 'Bash', command: LAMBDA })
  expect(w.ran).toEqual(['Bash'])
  const band = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /1 unchecked/ })).toBeDefined()
  await band.unmount()
})

test('a Jev that does not answer in 3 seconds leaves the command running', async ($, on) => {
  const w = world(on, { answers: HOLD, isSlow: true })
  await turnOn($)
  const call = $.tool.call({ tool: 'Bash', command: LAMBDA })
  await w.clock.advance(3000)
  await call
  expect(w.ran).toEqual(['Bash'])
})

test('Dredd is off at the start of a session: nothing is sent or held, and the band says OFF', async ($, on) => {
  const w = world(on, { answers: HOLD })
  await $.tool.call({ tool: 'Bash', command: LAMBDA })
  await $.tool.call({ tool: 'Write', file_path: '/repo/.claude/dredd-rules.json', content: '[]' })
  expect(w.sent.length).toBe(0)
  expect(w.opens()).toBe(0)
  expect(w.ran).toEqual(['Bash', 'Write'])
  const band = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /Dredd OFF/ })).toBeDefined()
  expect(await band.find({ type: 'Button', key: 'toggle', text: 'Turn on' })).toBeDefined()
  await band.unmount()
})

test('after a /clear, which changes the session id without a session.start, Dredd is off', async ($, on) => {
  const w = world(on, { answers: PASS })
  await turnOn($)
  w.setSession('s2')
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(w.sent.length).toBe(0)
  const band = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /Dredd OFF/ })).toBeDefined()
  await band.unmount()
})

test('a fresh session.start turns Dredd off even when the last session turned it on', async ($, on) => {
  const w = world(on, { answers: PASS })
  await turnOn($)
  w.setSession('s2')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(w.sent.length).toBe(0)
})

test('turning Dredd off in the band stops the checks', async ($, on) => {
  const w = world(on, { answers: HOLD })
  await turnOn($)
  const band = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...BAND })
  await band.press({ key: 'toggle' })
  expect(await band.find({ type: 'Text', text: /Dredd OFF/ })).toBeDefined()
  await $.tool.call({ tool: 'Bash', command: LAMBDA })
  expect(w.sent.length).toBe(0)
  expect(w.ran).toEqual(['Bash'])
  await band.unmount()
})

test('without an API key or a rules file, commands pass and the band says why', async ($, on) => {
  const w = world(on, { env: {} })
  await turnOn($)
  await $.tool.call({ tool: 'Bash', command: LAMBDA })
  expect(w.sent.length).toBe(0)
  expect(w.ran).toEqual(['Bash'])
  const band = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /no TYPESAFE_API_KEY/ })).toBeDefined()
  await band.unmount()
})

test('without a rules file, the band asks for /dredd-rules', async ($, on) => {
  const w = world(on)
  await turnOn($)
  delete w.files['/repo/.claude/dredd-rules.json']
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(w.sent.length).toBe(0)
  const band = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /run \/dredd-rules/ })).toBeDefined()
  await band.unmount()
})

test('a resumed session keeps its stored entries, and old sessions are pruned', async ($, on) => {
  const old = Object.fromEntries(
    Array.from({ length: 50 }, (_, i) => [`ledger:old-${i}`, { startedAt: i, entries: [] }]),
  )
  const w = world(on, { answers: CITE, store: old })
  await turnOn($)
  await $.tool.call({ tool: 'Bash', command: 'git push --force-with-lease' })
  await w.clock.advance(2000)
  expect([...w.store.keys()].filter(k => k.startsWith('ledger:')).length).toBe(50)
  expect(w.store.has('ledger:old-0')).toBe(false)

  const earlier = { id: 'earlier', at: 1, session: 's1', source: 'monitor', verdict: 'citation', subject: 'x' }
  w.store.set('ledger:s1', { startedAt: 1, entries: [earlier] })
  await $.tool.call({ tool: 'Bash', command: 'git push --force-with-lease' })
  await w.clock.advance(2000)
  expect((w.store.get('ledger:s1') as Kept).entries.length).toBe(3)
})

test('a reply that answers no rule counts as unchecked, not as a pass', async ($, on) => {
  const w = world(on, { answers: { _kind: { choice: 'deploy' } } })
  await turnOn($)
  await $.tool.call({ tool: 'Bash', command: LAMBDA })
  expect(w.ran).toEqual(['Bash'])
  const band = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /2 unchecked/ })).toBeDefined()
  await band.unmount()
})

test('a session that started non-interactive but draws on the desktop still holds for an answer', async ($, on) => {
  const w = world(on, { answers: HOLD, surfaces: ['desktop'] })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await turnOn($)
  const shown = w.nextOpen()
  const call = $.tool.call({ tool: 'Bash', command: LAMBDA })
  await shown
  const pane = await $.ui.mount({ plugin: 'dredd', surface: 'desktop', ...PANE })
  await pane.press({ key: 'proceed' })
  await w.clock.advance(250)
  await call
  expect(w.ran).toEqual(['Bash'])
  await pane.unmount()
})

test('where no sleep can run, a hold asks in the engine dialog instead', async ($, on) => {
  const w = world(on, { answers: HOLD, canSleep: false, ask: () => 'Cancel' })
  await turnOn($)
  const result = await $.tool.call({ tool: 'Bash', command: LAMBDA })
  expect(w.ran).toEqual([])
  expect(w.asked.length).toBe(1)
  expect(textOf(result)).toMatch(/The user refused it\./)
})

test('where no sleep can run and no dialog can open, the hold refuses without blaming the user', async ($, on) => {
  const w = world(on, { answers: HOLD, canSleep: false })
  await turnOn($)
  const result = await $.tool.call({ tool: 'Bash', command: LAMBDA })
  expect(w.ran).toEqual([])
  expect(textOf(result)).toMatch(/could not ask anyone to approve it/)
})

test('a command longer than one request is checked in windows, tail included', async ($, on) => {
  const w = world(on, { answers: PASS })
  await turnOn($)
  const command = `cat > big.json <<'EOF'\n${'x'.repeat(30_000)}\nEOF\n${LAMBDA}`
  await $.tool.call({ tool: 'Bash', command })
  expect(w.sent.length).toBe(2)
  expect((w.sent[1]!.state as { input: string }).input.includes('raw_command')).toBe(true)
})

test('a shell command run through the Monitor tool is checked like Bash', async ($, on) => {
  const w = world(on, { answers: HOLD })
  await turnOn($)
  const shown = w.nextOpen()
  const call = $.tool.call({ tool: 'Monitor', command: LAMBDA, description: 'watch', timeout_ms: 1000 })
  await shown
  const pane = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...PANE })
  await pane.press({ key: 'cancel' })
  await w.clock.advance(250)
  expect(textOf(await call)).toMatch(/no-lambda-raw/)
  expect(w.ran).toEqual([])
  await pane.unmount()
})

for (const [label, input] of [
  ['an Edit of', { tool: 'Edit', file_path: '/repo/.claude/dredd-rules.json', old_string: 'a', new_string: 'b' }],
  ['a Write to', { tool: 'Write', file_path: '/repo/.claude/dredd-rules.json', content: '[]' }],
  ['a Bash command that deletes', { tool: 'Bash', command: 'rm .claude/dredd-rules.json' }],
] as const) {
  test(`${label} Dredd's own rules file is held for a person, with no Jev call`, async ($, on) => {
    const w = world(on, { env: {} })
    await turnOn($)
    const shown = w.nextOpen()
    const call = $.tool.call(input)
    await shown
    const pane = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: /hard rule dredd-rules-file/ })).toBeDefined()
    await pane.press({ key: 'cancel' })
    await w.clock.advance(250)
    expect(textOf(await call)).toMatch(/dredd-rules-file/)
    expect(w.ran).toEqual([])
    expect(w.sent.length).toBe(0)
    await pane.unmount()
  })
}

test('an edit to any other file is not held', async ($, on) => {
  const w = world(on)
  await turnOn($)
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: 'x' })
  expect(w.ran).toEqual(['Write'])
  expect(w.opens()).toBe(0)
})

for (const [label, change] of [
  ['breaks', 'not json'],
  ['is rewritten with weaker rules', JSON.stringify([{ ...RULES[1], hard: false }])],
  ['is deleted', null],
] as const) {
  test(`when the rules file ${label} mid-session, the session keeps the rules it started with`, async ($, on) => {
    const w = world(on, { answers: CITE })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await turnOn($)
    if (change === null) delete w.files['/repo/.claude/dredd-rules.json']
    else w.files['/repo/.claude/dredd-rules.json'] = change
    await $.tool.call({ tool: 'Bash', command: 'git push --force-with-lease' })
    expect(Object.keys(w.sent[0]!.questions).sort()).toEqual(['_kind', 'no-force-push', 'no-lambda-raw'])
    const band = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...BAND })
    expect(await band.find({ type: 'Text', text: /this session keeps the rules it started with/ })).toBeDefined()
    await band.unmount()
  })
}

for (const command of ["rm .claude/dredd-'rules'.json", 'rm .claude/dredd\\-rules.json', 'cat .claude/dredd-r*.json']) {
  test(`a command naming the rules file through shell quoting or a glob is held: ${command}`, async ($, on) => {
    const w = world(on, { env: {} })
    await turnOn($)
    const shown = w.nextOpen()
    const call = $.tool.call({ tool: 'Bash', command })
    await shown
    const pane = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...PANE })
    await pane.press({ key: 'cancel' })
    await w.clock.advance(250)
    expect(textOf(await call)).toMatch(/dredd-rules-file/)
    expect(w.ran).toEqual([])
    await pane.unmount()
  })
}

for (const command of [
  'bash ./deploy.sh && echo done',
  'cat deploy.sh | sh',
  'sh < deploy.sh',
  'env bash --norc deploy.sh',
  'sudo ./deploy.sh',
]) {
  test(`a local script is sent with the command that runs it: ${command}`, async ($, on) => {
    const w = world(on, { answers: PASS, files: { '/repo/deploy.sh': `#!/bin/sh\n${LAMBDA}\n` } })
    await turnOn($)
    await $.tool.call({ tool: 'Bash', command })
    const input = (w.sent[0]!.state as { input: string }).input
    expect(input.includes('raw_command')).toBe(true)
    expect(input.split('--- contents of').length).toBe(2)
  })
}

test('a script in a temp folder, or one run by an interpreter with no extension, is read too', async ($, on) => {
  const w = world(on, {
    answers: PASS,
    files: { '/tmp/evil.sh': `${LAMBDA}\n`, '/repo/deploy': `echo start\n${LAMBDA.replace('billing', 'deployfn')}\n` },
  })
  await turnOn($)
  await $.tool.call({ tool: 'Bash', command: 'bash /tmp/evil.sh; bash deploy' })
  const input = (w.sent[0]!.state as { input: string }).input
  expect(input.includes('--- contents of /tmp/evil.sh ---')).toBe(true)
  expect(input.includes('deployfn')).toBe(true)
})

test('a large script is checked whole, in windows', async ($, on) => {
  const w = world(on, { answers: PASS, files: { '/repo/big.sh': `${'echo x\n'.repeat(10_000)}${LAMBDA}\n` } })
  await turnOn($)
  await $.tool.call({ tool: 'Bash', command: 'sh big.sh' })
  expect(w.sent.length > 1).toBe(true)
  expect(w.sent.some(r => (r.state as { input: string }).input.includes('raw_command'))).toBe(true)
})

test('a script Dredd will not read is recorded as unchecked; a binary is not', async ($, on) => {
  const w = world(on, {
    answers: PASS,
    files: { '/home/u/deploy.sh': LAMBDA, '/repo/bin/tool': 'ELF\u0000\u0000binary' },
  })
  await turnOn($)
  await $.tool.call({ tool: 'Bash', command: 'bash /home/u/deploy.sh && ./bin/tool' })
  expect(w.ran).toEqual(['Bash'])
  const pane = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: /unchecked .*not read: \/home\/u\/deploy\.sh ·/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /bin\/tool ·/ })).toBeUndefined()
  await pane.unmount()
})

test('Dredd reads only project scripts: never secret files, files outside the project, links out of it, or non-scripts', async ($, on) => {
  const w = world(on, {
    answers: PASS,
    files: {
      '/repo/.env': 'DATABASE=envsecret1',
      '/home/u/.aws/credentials': 'outsidesecret2',
      '/home/u/notes.sh': 'echo outsidesecret3',
      '/home/u/.ssh/id_ed25519.sh': 'linkedsecret4',
      '/repo/config/prod.yaml': 'region: yamlvalue5',
      '/repo/tool.sh': 'echo fine',
    },
    links: { '/repo/link.sh': '/home/u/.ssh/id_ed25519.sh' },
  })
  await turnOn($)
  await $.tool.call({
    tool: 'Bash',
    command: 'sh .env; python /home/u/.aws/credentials; bash /home/u/notes.sh; bash ./link.sh; cat config/prod.yaml; ./tool.sh',
  })
  const input = (w.sent[0]!.state as { input: string }).input
  for (const secret of ['envsecret1', 'outsidesecret2', 'outsidesecret3', 'linkedsecret4', 'yamlvalue5']) {
    expect(input.includes(secret)).toBe(false)
  }
  expect(input.includes('--- contents of ./tool.sh ---')).toBe(true)
})

test('entries made just before the session id changes are still saved under the old id', async ($, on) => {
  const w = world(on, { answers: CITE })
  await turnOn($)
  await $.tool.call({ tool: 'Bash', command: 'git push --force-with-lease' })
  w.setSession('s2')
  await w.clock.advance(2000)
  expect((w.store.get('ledger:s1') as Kept).entries.length).toBe(1)
  expect(w.store.has('ledger:s2')).toBe(false)
})
