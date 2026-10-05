/**
 * Engine tests of `/dredd-review` and `/dredd-rules`: a local diff and a PR's,
 * the fix turn a violation starts, the PR comment, the guards on the diff and
 * the PR number, drafting the rules file from CLAUDE.md with a model, and the
 * refusal of either command when a person did not type it.
 */
import { test, expect } from 'claude-code/testing'

import { PANE, RULES, RULES_PATH, done, world } from './world'

const DIFF = [
  'diff --git a/src/billing/charge.ts b/src/billing/charge.ts',
  '--- a/src/billing/charge.ts',
  '+++ b/src/billing/charge.ts',
  '@@ -1,2 +1,3 @@',
  " import { users } from '../users/service'",
  '+const owner = users.repository.findOwner(id)',
  ' export const charge = 1',
  '',
].join('\n')

const VIOLATION = {
  'no-lambda-raw': { noul: 0.04 },
  'no-lambda-raw_line': { choice: 'none' },
  'service-boundary': { noul: 0.91 },
  'service-boundary_line': { choice: 'L001' },
}

const NEW_FILE = [
  'diff --git a/dev/null b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,1 @@',
  '+export const x = users.repository.all()',
  '',
].join('\n')

/** git and gh as a review runs them: the branch diff, optional untracked files, and the PR diff. */
const git = (diff: string, isTruncated = false, untracked = '') => (argv: readonly string[]) => {
  if (argv[1] === 'rev-parse') return done('origin/main\n')
  if (argv[1] === 'ls-files') return done(untracked)
  if (argv.includes('--no-index')) return done(NEW_FILE, 1)
  if (argv[0] === 'git' || (argv[1] === 'pr' && argv[2] === 'diff')) {
    return { ...done(diff), isStdoutTruncated: isTruncated }
  }
  return done()
}

const FLAGS = ['--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/']

/** A command typed at the prompt, as the engine stamps it. */
const cmd = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
})

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

test('a local review reports the violation on its line and starts a fix turn', async ($, on) => {
  const w = world(on, { answers: VIOLATION, process: git(DIFF) })
  const result = await $.command.run(cmd('dredd-review'))
  expect(w.argv).toEqual([
    ['git', 'rev-parse', '--abbrev-ref', 'origin/HEAD'],
    ['git', 'diff', ...FLAGS, '--merge-base', 'origin/main'],
    ['git', 'ls-files', '--others', '--exclude-standard', '-z'],
  ])
  expect(Object.keys(w.sent[0]!.questions).sort()).toEqual(
    ['no-lambda-raw', 'no-lambda-raw_line', 'service-boundary', 'service-boundary_line'].sort(),
  )
  expect(result.text).toMatch(/1 violation\(s\), 0 citation\(s\)/)
  expect(result.text).toMatch(/src\/billing\/charge\.ts:2 — A service never calls/)
  await w.clock.settle()
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toMatch(/src\/billing\/charge\.ts:2/)

  const pane = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: /violation\s+service-boundary\s+0\.91\s+src\/billing\/charge\.ts:2/ })).toBeDefined()
  await pane.unmount()
})

test('a local review includes files the agent created but did not add', async ($, on) => {
  const w = world(on, {
    answers: { ...VIOLATION, 'service-boundary_line': { choice: 'L001' } },
    process: git(DIFF, false, 'src/new.ts\0'),
  })
  const result = await $.command.run(cmd('dredd-review'))
  expect(w.argv.at(-1)).toEqual(['git', 'diff', ...FLAGS, '--no-index', '--', '/dev/null', 'src/new.ts'])
  expect(w.sent.map(r => (r.state as { file: string }).file)).toEqual(['src/billing/charge.ts', 'src/new.ts'])
  expect(result.text).toMatch(/src\/new\.ts:1/)
})

test('a review says which files it left out because they may hold secrets', async ($, on) => {
  const env = ['diff --git a/.env b/.env', '--- a/.env', '+++ b/.env', '@@ -1 +1 @@', '+API=1', ''].join('\n')
  const w = world(on, { answers: VIOLATION, process: git(`${DIFF}${env}`) })
  const result = await $.command.run(cmd('dredd-review'))
  expect(w.sent.length).toBe(1)
  expect(result.text).toMatch(/Not sent, because they may hold secrets: \.env\./)
})

test('a diff cut off at the output cap is not reviewed', async ($, on) => {
  const w = world(on, { answers: VIOLATION, process: git(DIFF, true) })
  const result = await $.command.run(cmd('dredd-review'))
  expect(result.text).toMatch(/over 4 MiB/)
  expect(w.sent.length).toBe(0)
})

test('a PR review posts one comment and starts no fix turn', async ($, on) => {
  const w = world(on, { answers: VIOLATION, process: git(DIFF) })
  const result = await $.command.run(cmd('dredd-review', '42'))
  expect(w.argv).toEqual([
    ['gh', 'pr', 'diff', '42', '--color=never'],
    ['gh', 'pr', 'comment', '42', '--body-file', '-'],
  ])
  expect(w.stdins[0]).toMatch(/Dredd Review of PR #42: 1 violation/)
  expect(result.text).toMatch(/Posted to PR #42\./)
  await w.clock.settle()
  expect(w.submitted.length).toBe(0)
})

test('a PR argument that is not a number is refused before anything runs', async ($, on) => {
  const w = world(on, { answers: VIOLATION, process: git(DIFF) })
  const result = await $.command.run(cmd('dredd-review', '42; rm -rf /'))
  expect(result.text).toMatch(/takes a PR number or nothing/)
  expect(w.argv.length).toBe(0)
})

test('/dredd-rules drafts the rules file from CLAUDE.md, and never overwrites it', async ($, on) => {
  const w = world(on, { files: { '/repo/CLAUDE.md': '# Rules\n\nAgents must never execute raw_command actions on a lambda.' } })
  delete w.files[RULES_PATH]
  const prompts: string[] = []
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true as const, text: `Here it is:\n\`\`\`json\n${JSON.stringify(RULES)}\n\`\`\``, usage: USAGE } }
  })

  const first = await $.command.run(cmd('dredd-rules'))
  expect(first.text).toMatch(/Drafted 3 rules/)
  expect(prompts[0]).toMatch(/never execute raw_command/)
  expect(JSON.parse(w.files[RULES_PATH]!)).toEqual(RULES)

  const second = await $.command.run(cmd('dredd-rules'))
  expect(second.text).toMatch(/already exists/)
  expect(prompts.length).toBe(1)
})

test('/dredd-rules writes nothing when the draft is invalid or the model does not answer', async ($, on) => {
  const w = world(on, { files: { '/repo/CLAUDE.md': '# Rules' } })
  delete w.files[RULES_PATH]
  const replies = [
    { isAnswered: true as const, text: '[{"id": "Bad Id"}]', usage: USAGE },
    { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE },
  ]
  on('model.complete', () => ({ value: replies.shift()! }))

  expect((await $.command.run(cmd('dredd-rules'))).text).toMatch(/not a valid rules file \(rule 1: id must be a kebab-case slug\)/)
  expect((await $.command.run(cmd('dredd-rules'))).text).toMatch(/did not answer \(empty-reply\)/)
  expect(RULES_PATH in w.files).toBe(false)
})

test('/dredd-rules writes nothing when the model drafts no rules', async ($, on) => {
  const w = world(on, { files: { '/repo/CLAUDE.md': '# Rules' } })
  delete w.files[RULES_PATH]
  on('model.complete', () => ({ value: { isAnswered: true as const, text: '[]', usage: USAGE } }))
  expect((await $.command.run(cmd('dredd-rules'))).text).toMatch(/found no rule/)
  expect(RULES_PATH in w.files).toBe(false)
})

/** Every way a command can start other than a person typing it at the prompt. */
const NOT_TYPED = [
  'bridge', 'sdk', 'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'channel',
  'coordinator', 'observer', 'observer-activity', 'auto-continuation', 'unclassified', 'slack-ping', 'plugin',
]

for (const name of ['dredd-review', 'dredd-rules']) {
  test(`/${name} is refused unless a person typed it at the prompt`, async ($, on) => {
    const w = world(on, { answers: VIOLATION, process: git(DIFF), files: { '/repo/CLAUDE.md': '# Rules' } })
    delete w.files[RULES_PATH]
    for (const kind of NOT_TYPED) {
      const result = await $.command.run({ ...cmd(name), origin: { kind, name: 'x' } as never })
      expect(result.text).toBe(`/${name} runs only when you type it at the prompt.`)
    }
    const result = await $.command.run({ ...cmd(name), origin: { kind: 'plugin' as const, name: 'x', asUser: true } })
    expect(result.text).toBe(`/${name} runs only when you type it at the prompt.`)
    expect(w.argv).toEqual([])
    expect(w.sent.length).toBe(0)
    expect(RULES_PATH in w.files).toBe(false)
  })
}
