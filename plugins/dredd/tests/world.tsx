/**
 * The world beneath dredd in its engine tests: a mocked clock and env, an
 * in-memory store and file system, a Jev endpoint that answers what a test
 * chooses, and a tool runner that records what ran. Every test of the hooks
 * module builds one with `world(on, options)`. Dredd starts each session off,
 * so a test of Monitor calls `turnOn($)` first.
 */
import { mock } from 'claude-code/testing'
import type { test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import type { Rule } from '../types'
import type { JevRequest } from '../hooks/dredd'

export const RULES: Rule[] = [
  {
    id: 'no-lambda-raw',
    rule: 'Agents must never execute raw_command actions on a lambda.',
    question: 'Does this run a raw_command action against an AWS Lambda?',
    hard: true,
    applies: 'both',
  },
  {
    id: 'no-force-push',
    rule: 'Avoid force pushes.',
    question: 'Does this command force-push?',
    hard: false,
    applies: 'command',
  },
  {
    id: 'service-boundary',
    rule: 'A service never calls another service’s methods directly.',
    question: 'Does the added code call a method of another service directly?',
    hard: true,
    applies: 'code',
  },
]

export const RULES_PATH = '/repo/.claude/dredd-rules.json'

export const PANE = {
  component: 'Pane',
  requestId: 'dredd',
  props: {
    title: 'Dredd',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

export const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

type Engine = Parameters<Parameters<typeof test>[1]>[0]

/** Presses the band's toggle the way a person would, turning Monitor on. */
export const turnOn = async ($: Engine) => {
  const band = await $.ui.mount({ plugin: 'dredd', surface: 'terminal', ...BAND })
  await band.press({ key: 'toggle' })
  await band.unmount()
}

/** A finished process with this output. */
export const done = (stdout = '', exitCode = 0): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr: exitCode === 0 ? '' : 'failed',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

export type WorldOptions = {
  answers?: Record<string, unknown>
  status?: number
  isSlow?: boolean
  surfaces?: ('terminal' | 'desktop')[]
  canSleep?: boolean
  ask?: () => string
  links?: Record<string, string>
  env?: Record<string, string>
  files?: Record<string, string>
  store?: Record<string, unknown>
  process?: (argv: readonly string[], stdin?: string) => ProcessRunResult
}

export const world = (on: On, options: WorldOptions = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, options.env ?? { TYPESAFE_API_KEY: 'test-key' })

  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })

  on('session.root', () => ({ value: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' }))
  let session = 's1'
  on('session.id', () => ({ value: session }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: options.surfaces ?? ['terminal'] }))
  const asked: string[] = []

  const files: Record<string, string> = { [RULES_PATH]: JSON.stringify(RULES), ...options.files }
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.stat', ($, e) => {
    const real = options.links?.[e.path] ?? e.path
    if (real === '/repo') return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' } }
    if (!(real in files)) return { deny: `no such file: ${e.path}` }
    return {
      value: {
        kind: 'file' as const,
        size: files[real]!.length,
        mtimeMs: 0,
        isLink: real !== e.path,
        ...(e.resolve ? { realPath: real } : {}),
      },
    }
  })
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path]! } : { deny: `no such file: ${e.path}` }))
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.list', ($, e) => ({ deny: `no such folder: ${e.path}` }))

  const sent: JevRequest[] = []
  const status = options.status ?? 200
  on('http.fetch', async ($, e) => {
    sent.push(JSON.parse(e.init?.body ?? '{}') as JevRequest)
    if (options.isSlow) await clock.sleep(10_000)
    return {
      value: {
        status,
        ok: status === 200,
        headers: {},
        text: JSON.stringify({ model: 'jev-1.13.0', answers: options.answers ?? {} }),
      },
    }
  })

  const argv: string[][] = []
  const stdins: string[] = []
  on('process.run', async ($, e) => {
    if (e.argv[0] === 'sleep') {
      if (options.canSleep === false) return { deny: 'sleep: command not found' }
      await clock.sleep(250)
      return { value: done() }
    }
    argv.push([...e.argv])
    if (e.init?.stdin !== undefined) stdins.push(e.init.stdin)
    return { value: options.process?.(e.argv, e.init?.stdin) ?? done() }
  })

  let opened = 0
  let onOpen = () => {}
  on('ui.open', () => {
    opened += 1
    onOpen()
    return { value: { isPlaced: true } }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  const ran: string[] = []
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      const question = e.questions[0]?.question ?? ''
      asked.push(question)
      if (options.ask === undefined) return { deny: 'no one to ask' }
      return { result: { questions: e.questions, answers: { [question]: options.ask() } } }
    }
    ran.push(e.tool)
    return { result: 'ran' }
  })

  const submitted: string[] = []
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })

  return {
    clock,
    store,
    files,
    sent,
    argv,
    stdins,
    ran,
    submitted,
    asked,
    opens: () => opened,
    setSession: (id: string) => {
      session = id
    },
    nextOpen: () => new Promise<void>(resolve => (onOpen = resolve)),
  }
}
