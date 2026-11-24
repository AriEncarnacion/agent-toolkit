/**
 * dredd: re-asserts the project's CLAUDE.md rules at the moment of action, with
 * TypeSafe's Jev decision model doing the judging.
 *
 * Every rule Dredd enforces comes from `.claude/dredd-rules.json`, which
 * `/dredd-rules` drafts from the project's agent rule docs; Dredd has no
 * rules of its own. Monitor is a `tool.call` hook on Bash and every MCP
 * tool. It asks Jev one Noul per command rule; a likely break of a hard rule
 * is a violation, held in the Dredd pane for Cancel, Allow once or Not a
 * violation, an uncertain one is cited, the rest run. `/dredd-review [PR#]`
 * sends the branch's or a PR's diff in batched requests and reports
 * violations and citations. Every violation and citation goes in the
 * session's ledger, drawn in the pane with a per-rule summary and counted in
 * the band above the prompt, which carries the on/off toggle, and kept per
 * session in `$.store`.
 *
 * Monitor is off at the start of every session, `/clear` and resume included,
 * and only a person can turn it on, with the band's button. Both commands run
 * only when a person typed them at the prompt. The band warns when the rule
 * docs or the rules file changed since `/dredd-rules` last wrote the file.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, Held, Rule } from '../types'
import {
  KIND_ID,
  JEV_URL,
  MAX_ENTRIES,
  MAX_SESSIONS,
  STATE_CHARS,
  SUBJECT_CHARS,
  DRAFT_SYSTEM,
  arrayIn,
  chunkDiff,
  clip,
  counts,
  draftPrompt,
  findings,
  fixPrompt,
  flags,
  mergeEntries,
  monitorRequest,
  parseRules,
  redact,
  redactValue,
  secretFiles,
  windows,
  mergeAnswers,
  quoteLine,
  describeChanges,
  hashText,
  ruleChanges,
  ruleSummary,
  isSecretFile,
  report,
  reviewRequest,
  ruleGroups,
  rulesFor,
  subjectOf,
  toPrune,
  unanswered,
  where,
} from './dredd'
import type { Answer, Drafted, Finding, JevRequest, Kept } from './dredd'

const PANE = 'dredd'
const RULES_PATH = '.claude/dredd-rules.json'
const MONITOR_TIMEOUT_MS = 3000
const REVIEW_TIMEOUT_MS = 20_000
const DIFF_FLAGS = ['--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/']
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

const onFor = atom({ plugin: 'dredd', key: 'onFor' } as const, null)
const ledger = atom({ plugin: 'dredd', key: 'ledger' } as const, [])
const held = atom({ plugin: 'dredd', key: 'held' } as const, [])
const notice = atom({ plugin: 'dredd', key: 'notice' } as const, '')
const pinned = atom({ plugin: 'dredd', key: 'pinned' } as const, null)
const isLedgerOpen = atom({ plugin: 'dredd', key: 'isLedgerOpen' } as const, false)
const drift = atom({ plugin: 'dredd', key: 'drift' } as const, '')

/** A person's answer to a hold. */
type Answer3 = 'cancel' | 'allow' | 'misjudged'

/** The answers to holds, set by the pane's and band's buttons and read by the waiting hook. */
const decisions = new Map<string, Answer3>()

/** The labels of a hold's three answers, in button order. */
const ANSWERS: [Answer3, string][] = [
  ['cancel', 'Cancel'],
  ['allow', 'Allow once'],
  ['misjudged', 'Not a violation'],
]

/**
 * Calls whose hold has begun and not ended in a run: if the hook fails from
 * here on, the `.catch` refuses the command rather than running it.
 */
const failClosed = new Set<string>()

/** Sessions with ledger entries not yet saved to `$.store`. */
const dirty = new Set<string>()

/** The pending debounced write of the ledger to `$.store`. */
let flushTimer: { cancel: () => void } | null = null

/**
 * Whether Monitor is on: a person pressed Turn on in this session. The state
 * holds the id of the session it was turned on in, so a `/clear` or a resume,
 * which go on under a new id without a `session.start`, starts off.
 */
const isMonitorOn = async ($: EngineInterface) => (await read($, onFor)) === (await $.session.id())

/** The refusal for a Dredd command that a person did not type at the prompt. */
const typedOnly = (name: string) => ({ text: `/${name} runs only when you type it at the prompt.` })

/** An error's message, for text shown to the person. */
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Opens the Dredd pane and records whether it is shown, for the band's Ledger button. */
const openPane = async ($: EngineInterface, isFocused = false) => {
  const opened = await $.ui.open({ id: PANE, title: 'Dredd', ...(isFocused ? { focus: true } : {}) })
  if (opened.isPlaced) await update($, isLedgerOpen, () => true)
  return opened
}

/** Closes the Dredd pane. A close by the person is recorded by the `ui.close` hook. */
const closePane = async ($: EngineInterface) => {
  await $.ui.close({ id: PANE })
  await update($, isLedgerOpen, () => false)
}

/** Sets the band's notice, writing only when it changed. */
const say = async ($: EngineInterface, text: string) => {
  if ((await read($, notice)) !== text) await update($, notice, () => text)
}

/**
 * The rules this session enforces: the rules file as it stood when the
 * session first read it, at `session.start` when it exists by then. A later
 * change to the file, by anyone and by any means (an edit, a deletion, a
 * shell glob), takes effect in the next session, so an agent cannot weaken
 * the rules it is judged by. The note says when the file has changed since.
 */
const loadRules = async ($: EngineInterface): Promise<{ rules: Rule[]; note: string } | string> => {
  const session = await $.session.id()
  const pin = await read($, pinned)
  const path = `${await $.session.root()}/${RULES_PATH}`
  let text: string | null = null
  try {
    if (await $.fs.exists(path)) text = await $.fs.read(path)
  } catch {
    text = null
  }
  if (pin !== null && pin.session === session) {
    const note = text === pin.text ? '' : 'rules file changed; this session keeps the rules it started with'
    return { rules: pin.rules, note }
  }
  if (text === null) return 'no rules: run /dredd-rules'
  try {
    const rules = parseRules(JSON.parse(text))
    await update($, pinned, () => ({ session, text: text!, rules }))
    return { rules, note: '' }
  } catch (err) {
    return `${RULES_PATH}: ${messageOf(err)}`
  }
}

/** Extensions of the files Dredd treats as scripts. */
const SCRIPT_EXT = /\.(?:sh|bash|zsh|ksh|fish|py|rb|pl|php|js|mjs|cjs|ts|mts|cts|ps1|lua|r)$/i

/** Programs that run the file named after them, or their standard input. */
const INTERPRETER = /^(?:(?:ba|z|k|da|fi)?sh|source|\.|python[0-9.]*|node|bun|deno|ruby|perl|php|tsx|ts-node|lua|pwsh)$/

/** Words that only lead another command: `sudo cmd`, `env X=1 cmd`. */
const PREFIX = /^(?:sudo|env|exec|nohup|time|nice|command|xargs)$/

/** The largest script Dredd reads; a longer one is recorded as unchecked. */
const SCRIPT_CHARS = 512_000

const unquote = (word: string) => word.replace(/^["'`]+|["'`]+$/g, '')

/**
 * The words of a command that could name a file (path-like or with a script
 * extension), and among them the ones the command runs: the file after an
 * interpreter, after `<`, piped into an interpreter, or executed by path.
 */
const pathsIn = (command: string) => {
  const words = new Set<string>()
  const runs = new Set<string>()
  let piped: string[] = []
  for (const segment of command.split(/(?:&&|\|\||[;&\n])/)) {
    for (const part of segment.split('|')) {
      const tokens = part.split(/\s+/).map(unquote).filter(Boolean)
      const redirected = tokens.flatMap((t, i) => (t === '<' ? [tokens[i + 1] ?? ''] : t.startsWith('<') ? [t.slice(1)] : []))
      const plain = tokens.filter(t => !t.startsWith('<') && !t.startsWith('>') && !/^\d?>/.test(t))
      let i = 0
      while (i < plain.length && (PREFIX.test(plain[i]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[i]!) || plain[i]!.startsWith('-'))) i += 1
      const program = plain[i] ?? ''
      const args = plain.slice(i + 1).filter(t => !t.startsWith('-'))
      if (INTERPRETER.test(program.split('/').pop() ?? '')) {
        if (args[0] !== undefined) runs.add(args[0])
        else piped.forEach(word => runs.add(word))
      } else if (program.includes('/')) {
        runs.add(program)
      }
      redirected.filter(Boolean).forEach(word => runs.add(word))
      for (const word of [...plain, ...redirected]) {
        if (word !== '' && !word.startsWith('-') && (word.includes('/') || SCRIPT_EXT.test(word))) words.add(word)
      }
      piped = args
    }
    piped = []
  }
  runs.forEach(word => words.add(word))
  return { words: [...words], runs }
}

/**
 * The text of the scripts a command names, so a dangerous command written
 * into a script and then run is still seen by Jev, plus the run targets it
 * would not read and that look like scripts (not binaries or system tools),
 * for the ledger. What Dredd reads is an allow-list, never
 * what the command asks for: a file whose real path (every link followed)
 * is inside the project root or an OS temp folder, that is not a file that
 * may hold secrets, that the command runs or that is a script by extension
 * or `#!` line, that is text, and that is at most 512K characters. At most
 * 5 are sent, and 20 paths looked at.
 */
const scriptsIn = async ($: EngineInterface, command: string, cwd: string) => {
  const root = (await $.fs.stat(await $.session.root(), { resolve: true })).realPath
  const tmp = await $.env.get("TMPDIR")
  const allowed = [root, '/tmp', '/private/tmp', '/var/folders', '/private/var/folders', tmp?.replace(/\/$/, '')]
    .filter((dir): dir is string => dir !== undefined && dir !== '')
    .map(dir => `${dir}/`)
  const { words, runs } = pathsIn(command)
  const parts: string[] = []
  const unread: string[] = []
  for (const path of words.slice(0, 20)) {
    const isRun = runs.has(path)
    try {
      const info = await $.fs.stat(path.startsWith('/') ? path : `${cwd}/${path.replace(/^\.\//, '')}`, { resolve: true })
      const real = info.realPath
      if (info.kind !== 'file' || real === undefined) continue
      if (!allowed.some(dir => real.startsWith(dir)) || isSecretFile(real) || info.size > SCRIPT_CHARS) {
        if (isRun && (SCRIPT_EXT.test(real) || isSecretFile(real) || info.size > SCRIPT_CHARS)) unread.push(path)
        continue
      }
      if (parts.length === 5) {
        if (isRun) unread.push(path)
        continue
      }
      const text = await $.fs.read(real)
      if (text.includes('\u0000')) continue
      if (isRun || SCRIPT_EXT.test(real) || text.startsWith('#!')) parts.push(`\n\n--- contents of ${path} ---\n${text}`)
    } catch {
      $.ui.log(`dredd: did not read ${path}`, { to: 'debug' })
    }
  }
  return { text: parts.join(''), unread }
}

/** Sends one request to Jev: the HTTP status, and the answers when it was 200. */
const jev = async (
  $: EngineInterface,
  key: string,
  body: JevRequest,
): Promise<{ status: number; answers?: Record<string, Answer> }> => {
  try {
    const res = await $.http.fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return { status: res.status }
    const parsed = JSON.parse(res.text) as { answers?: Record<string, Answer> }
    return parsed.answers ? { status: res.status, answers: parsed.answers } : { status: 0 }
  } catch {
    return { status: 0 }
  }
}

/**
 * Saves the ledger to `$.store`, one key per session with unsaved entries,
 * each merged with what an earlier run of that session kept. A session is
 * saved even after `/clear` changed the id, so its last entries are kept.
 */
const flush = async ($: EngineInterface) => {
  try {
    const all = await read($, ledger)
    for (const session of [...dirty]) {
      dirty.delete(session)
      const mine = all.filter(x => x.session === session)
      if (mine.length === 0) continue
      const key = `ledger:${session}`
      const stored = (await $.store.get(key)) as Kept | undefined
      if (stored === undefined) await prune($)
      const kept: Kept = {
        startedAt: stored?.startedAt ?? mine[0]!.at,
        root: await $.session.root(),
        entries: mergeEntries(stored?.entries ?? [], mine),
      }
      await $.store.set(key, kept)
    }
  } catch (err) {
    $.ui.log(`dredd: the ledger was not saved: ${messageOf(err)}`, { to: 'debug' })
  }
}

/** Each session's entries as saved in `$.store`, read the first time this run of the module draws it. */
const saved = new Map<string, Entry[]>()

/**
 * The current session's ledger entries: what it saved to `$.store` before,
 * merged with what is in `$.state` now, so a resumed conversation shows what
 * it recorded earlier. A brand-new session has nothing saved and starts
 * empty. Drawing may not write state, so the merge is for display only; the
 * store already holds the saved entries.
 */
const sessionLedger = async ($: EngineInterface) => {
  const session = await $.session.id()
  if (!saved.has(session)) {
    let entries: Entry[] = []
    try {
      entries = ((await $.store.get(`ledger:${session}`)) as Kept | undefined)?.entries ?? []
    } catch (err) {
      $.ui.log(`dredd: the saved ledger was not read: ${messageOf(err)}`, { to: 'debug' })
    }
    saved.set(session, entries)
  }
  return mergeEntries(saved.get(session)!, (await read($, ledger)).filter(x => x.session === session))
}

/** Every entry `$.store` kept for each project root, read once per run of the module. */
const history = new Map<string, Entry[]>()

/**
 * Every ledger entry recorded in this project: all sessions kept in
 * `$.store` with this root, merged with this run's entries in `$.state`.
 * The pane's per-rule summary is drawn from it, so a pattern across
 * sessions shows.
 */
const projectLedger = async ($: EngineInterface) => {
  const root = await $.session.root()
  if (!history.has(root)) {
    const entries: Entry[] = []
    try {
      for (const key of (await $.store.keys()).filter(k => k.startsWith('ledger:'))) {
        const kept = (await $.store.get(key)) as Kept | undefined
        if (kept?.root === root) entries.push(...kept.entries)
      }
    } catch (err) {
      $.ui.log(`dredd: the saved ledgers were not read: ${messageOf(err)}`, { to: 'debug' })
    }
    history.set(root, entries)
  }
  return mergeEntries(history.get(root)!, await read($, ledger), Number.MAX_SAFE_INTEGER)
}

/** Deletes the oldest kept sessions, leaving room for one more. */
const prune = async ($: EngineInterface) => {
  const keys = (await $.store.keys()).filter(k => k.startsWith('ledger:'))
  const sessions = await Promise.all(
    keys.map(async key => {
      const value = (await $.store.get(key)) as Kept | undefined
      return { key, startedAt: value?.startedAt ?? 0, bytes: JSON.stringify(value ?? null).length }
    }),
  )
  for (const key of toPrune(sessions, MAX_SESSIONS - 1)) await $.store.delete(key)
}

/** Appends entries to the ledger and schedules a save. */
const record = async (
  $: EngineInterface,
  fields: Omit<Entry, 'id' | 'at' | 'session'>[],
): Promise<Entry[]> => {
  if (fields.length === 0) return []
  const at = await $.clock.now()
  const session = await $.session.id()
  const entries = fields.map((f, i) => ({
    ...f,
    id: `${at}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    session,
    subject: clip(f.subject, SUBJECT_CHARS),
  }))
  await update($, ledger, list => [...list, ...entries].slice(-MAX_ENTRIES))
  dirty.add(session)
  flushTimer?.cancel()
  flushTimer = $.clock.after(2000, () => void flush($))
  return entries
}

/**
 * Writes a hold's outcome onto its ledger entries: Cancel leaves a cancelled
 * violation, Allow once an allowed one, and Not a violation turns the entries
 * into misjudged ones, which the command then runs under.
 */
const decide = async ($: EngineInterface, ids: string[], answer: Answer3) => {
  const change = (x: Entry): Entry =>
    answer === 'cancel'
      ? { ...x, decision: 'cancelled' }
      : answer === 'allow'
        ? { ...x, decision: 'allowed' }
        : { ...x, verdict: 'misjudged', decision: 'allowed' }
  await update($, ledger, list => list.map(x => (ids.includes(x.id) ? change(x) : x)))
  dirty.add(await $.session.id())
  flushTimer?.cancel()
  flushTimer = $.clock.after(2000, () => void flush($))
}

/** Runs `work` over `items` with at most `size` in flight, keeping the order. */
const pool = async <T, R>(items: T[], size: number, work: (item: T) => Promise<R>) => {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (nextIndex < items.length) {
        const i = nextIndex
        nextIndex += 1
        results[i] = await work(items[i]!)
      }
    }),
  )
  return results
}

/** The diff to review, from git or gh, or why there is none. */
const diffFor = async (
  $: EngineInterface,
  root: string,
  pr: string,
): Promise<{ text: string } | { error: string }> => {
  try {
    const run = (argv: string[]) => $.process.run(argv, { cwd: root, timeoutMs: 60_000 })
    const tooBig = { error: 'The diff is over 4 MiB. Dredd Review stopped rather than review part of it.' }
    if (pr !== '') {
      const out = await run(['gh', 'pr', 'diff', pr, '--color=never'])
      if (out.exitCode !== 0) return { error: `Getting the diff failed: ${out.stderr.trim()}` }
      return out.isStdoutTruncated ? tooBig : { text: out.stdout }
    }
    const head = await run(['git', 'rev-parse', '--abbrev-ref', 'origin/HEAD'])
    const base = head.exitCode === 0 && head.stdout.trim() !== '' ? head.stdout.trim() : 'origin/main'
    const out = await run(['git', 'diff', ...DIFF_FLAGS, '--merge-base', base])
    if (out.exitCode !== 0) return { error: `Getting the diff failed: ${out.stderr.trim()}` }
    if (out.isStdoutTruncated) return tooBig
    const parts = [out.stdout]
    const untracked = await run(['git', 'ls-files', '--others', '--exclude-standard', '-z'])
    for (const path of untracked.stdout.split('\0').filter(Boolean)) {
      const added = await run(['git', 'diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', path])
      if (added.exitCode > 1) return { error: `Getting the diff of ${path} failed: ${added.stderr.trim()}` }
      if (added.isStdoutTruncated) return tooBig
      parts.push(added.stdout)
    }
    return { text: parts.join('\n') }
  } catch (err) {
    return { error: `Getting the diff failed: ${messageOf(err)}` }
  }
}

/** CLAUDE.md, `.claude/CLAUDE.md`, CLAUDE.local.md and `.claude/rules/*.md`, each under its path, for the rules draft. */
const ruleDocs = async ($: EngineInterface, root: string) => {
  const paths = [`${root}/CLAUDE.md`, `${root}/.claude/CLAUDE.md`, `${root}/CLAUDE.local.md`]
  try {
    for (const entry of await $.fs.list(`${root}/.claude/rules`)) {
      if (entry.kind === 'file' && entry.name.endsWith('.md')) paths.push(`${root}/.claude/rules/${entry.name}`)
    }
  } catch {
    $.ui.log('dredd: no .claude/rules folder', { to: 'debug' })
  }
  const docs: string[] = []
  for (const path of paths) {
    if (await $.fs.exists(path)) docs.push(`# ${path.slice(root.length + 1)}\n\n${await $.fs.read(path)}`)
  }
  return docs.join('\n\n')
}

/**
 * Compares the rule docs and the rules file with what `/dredd-rules` saved
 * when it last wrote the file, and sets the band's warning: the docs changed
 * (the rules are out of date), or the file changed outside `/dredd-rules`.
 * Silent when this project's rules file was never drafted here. It only
 * reads local files; nothing is sent anywhere.
 */
const checkDrift = async ($: EngineInterface) => {
  try {
    const root = await $.session.root()
    const drafted = (await $.store.get(`drafted:${root}`)) as Drafted | undefined
    let note = ''
    if (drafted !== undefined) {
      const path = `${root}/${RULES_PATH}`
      const file = (await $.fs.exists(path)) ? hashText(await $.fs.read(path)) : ''
      const notes = [
        hashText(await ruleDocs($, root)) !== drafted.docs ? 'rule docs changed since /dredd-rules: run it again' : '',
        file !== drafted.rules ? 'rules file changed outside /dredd-rules' : '',
      ]
      note = notes.filter(Boolean).join(' · ')
    }
    if ((await read($, drift)) !== note) await update($, drift, () => note)
  } catch (err) {
    $.ui.log(`dredd: could not compare the rules with the rule docs: ${messageOf(err)}`, { to: 'debug' })
  }
}

/** What a hold shows and records. */
type HoldSpec = { id: string; rule: string; p: number; entryIds: string[]; subject: string }

/**
 * Holds a call in the pane until a person answers Cancel, Allow once or Not
 * a violation, then refuses it or runs it. The wait polls with `sleep`, which costs none of
 * the hook's budget. Where the pane cannot be shown (a terminal too narrow
 * to seat it unasked) or no `sleep` can run, it asks in the engine's dialog
 * instead, which no other mod's band can cover. With no surface to draw on,
 * or once the hold has begun and the hook fails, the call is refused, never
 * run.
 */
const holdFor = async <T,>(
  $: EngineInterface,
  toolUseId: string,
  signal: AbortSignal,
  hold: HoldSpec,
  run: () => Promise<T>,
): Promise<T | { deny: string }> => {
  const refuse = (why: string) => ({
    deny: `Dredd held this command under rule ${hold.id}: ${quoteLine(hold.rule)} (p=${hold.p.toFixed(2)}). ${why}`,
  })
  failClosed.add(toolUseId)
  if ((await $.session.surfaces()).length === 0) {
    await decide($, hold.entryIds, 'cancel')
    failClosed.delete(toolUseId)
    return refuse('Nobody is at the prompt to approve it, so it did not run.')
  }

  const item: Held = {
    id: toolUseId,
    entryIds: hold.entryIds,
    ruleId: hold.id,
    rule: hold.rule,
    p: hold.p,
    subject: hold.subject,
  }
  await update($, held, list => [...list, item])
  const opened = await openPane($, true)

  let decision: Answer3 = 'cancel'
  let why = 'The user refused it.'
  const askInDialog = async () => {
    await update($, held, list => list.map(x => (x.id === item.id ? { ...x, isAsking: true } : x)))
    try {
      const answer = await $.ui.ask(
        `Dredd held ${clip(hold.subject, 80)} under rule ${hold.id} (p=${hold.p.toFixed(2)}): ${quoteLine(hold.rule)} What should happen?`,
        { options: ANSWERS.map(([, label]) => label), header: 'Dredd' },
      )
      decision = ANSWERS.find(([, label]) => label === answer)?.[0] ?? 'cancel'
    } catch {
      why = 'Dredd could not ask anyone to approve it here, so it did not run.'
    }
  }
  if (!opened.isPlaced) {
    await askInDialog()
  } else {
    try {
      while (!signal.aborted) {
        const chosen = decisions.get(item.id)
        if (chosen !== undefined) {
          decision = chosen
          break
        }
        await $.process.run(['sleep', '0.25'])
      }
    } catch {
      await askInDialog()
    }
  }
  if (signal.aborted) why = 'The hold was interrupted, so it did not run.'
  decisions.delete(item.id)
  await update($, held, list => list.filter(x => x.id !== item.id))
  await decide($, hold.entryIds, decision)
  failClosed.delete(toolUseId)
  return decision === 'cancel' ? refuse(why) : run()
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dredd-review',
      description: "Review this branch's diff, or a PR's, against the Dredd rules",
      argumentHint: '[PR number]',
    })
    await $.command.register({
      name: 'dredd-rules',
      description: 'Draft .claude/dredd-rules.json from CLAUDE.md for you to review',
    })
    await update($, onFor, () => null)
    await loadRules($)
    await checkDrift($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await flush($)
    return next(e)
  })

  on('tool.call', { tool: ['Bash', 'Monitor', /^mcp__/] }, async ($, e, next) => {
    if (!(await isMonitorOn($))) return next(e)
    const command = (e.tool === 'Bash' || e.tool === 'Monitor') && typeof e.command === 'string' ? e.command : null
    const raw = command ?? JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.has(k))))
    const subject = subjectOf(
      e.tool,
      command === null ? JSON.stringify(redactValue(JSON.parse(raw))) : redact(command),
    )

    const key = await $.env.get("TYPESAFE_API_KEY")
    if (key === undefined || key === '') {
      await say($, 'no TYPESAFE_API_KEY')
      return next(e)
    }
    const loaded = await loadRules($)
    if (typeof loaded === 'string') {
      await say($, loaded)
      return next(e)
    }
    const mine = rulesFor(loaded.rules, 'command')
    if (mine.length === 0) {
      await say($, 'no command rules')
      return next(e)
    }
    await say($, loaded.note)

    const cwd = await $.session.cwd()
    const scripts = command === null ? { text: '', unread: [] } : await scriptsIn($, command, cwd)
    if (scripts.unread.length > 0) {
      await record($, [
        { source: 'monitor', verdict: 'unchecked', subject: `not read: ${scripts.unread.join(', ')} · ${subject}` },
      ])
    }
    const redacted =
      command === null ? JSON.stringify(redactValue(JSON.parse(raw))) : redact(`${command}${scripts.text}`)
    const parts = windows(redacted)
    const timeout = $.clock
      .sleep(MONITOR_TIMEOUT_MS * Math.ceil(parts.length / 8), { signal: next.signal })
      .then(
        () => null,
        () => null,
      )
    const replies = await Promise.race([
      pool(parts, 8, input => jev($, key, monitorRequest(mine, { tool: e.tool, input, cwd }))),
      timeout,
    ])
    if (replies === null || replies.some(r => r.answers === undefined)) {
      await record($, [{ source: 'monitor', verdict: 'unchecked', subject }])
      return next(e)
    }
    const answers = mergeAnswers(replies.map(r => r.answers!))

    const kind = answers[KIND_ID]?.choice
    const found = flags(mine, answers)
    const entries = await record($, [
      ...found.map(f => ({
        source: 'monitor' as const,
        verdict: f.band === 'hold' ? ('violation' as const) : ('citation' as const),
        subject,
        ruleId: f.rule.id,
        p: f.p,
        ...(kind === undefined ? {} : { kind }),
      })),
      ...unanswered(mine, answers).map(rule => ({
        source: 'monitor' as const,
        verdict: 'unchecked' as const,
        subject,
        ruleId: rule.id,
      })),
    ])
    const top = found[0]
    if (top === undefined || top.band !== 'hold') return next(e)
    const entryIds = entries.filter(x => x.verdict === 'violation').map(x => x.id)
    return holdFor($, e.tool_use_id, next.signal, { id: top.rule.id, rule: top.rule.rule, p: top.p, entryIds, subject }, () =>
      next(e),
    )
  }).catch(async ($, e, next) => {
    if (failClosed.delete(e.tool_use_id)) {
      return { deny: 'Dredd held this command and then failed before it was approved, so it did not run.' }
    }
    await record($, [{ source: 'monitor', verdict: 'unchecked', subject: `${e.tool}: Dredd failed while checking` }])
    return next(e)
  })

  on('command.run', { command: 'dredd-rules' }, async ($, e) => {
    if (e.origin.kind !== 'composer') return typedOnly('dredd-rules')
    const root = await $.session.root()
    const path = `${root}/${RULES_PATH}`
    const docs = await ruleDocs($, root)
    if (docs === '') return { text: 'Found no CLAUDE.md or .claude/rules/*.md to draft rules from.' }
    const before = (await $.fs.exists(path)) ? await $.fs.read(path) : null
    let current: Rule[] | undefined
    if (before !== null) {
      try {
        current = parseRules(JSON.parse(before))
      } catch {
        current = []
      }
    }
    const reply = await $.model.complete({
      model: 'opus',
      system: DRAFT_SYSTEM,
      prompt: draftPrompt(docs, current),
      maxTokens: 8000,
      timeoutMs: 180_000,
    })
    if (!reply.isAnswered) return { text: `The model did not answer (${reply.reason}). Nothing was written.` }
    let rules: Rule[]
    try {
      rules = parseRules(arrayIn(reply.text))
    } catch (err) {
      return { text: `The model's draft was not a valid rules file (${messageOf(err)}). Nothing was written.` }
    }
    if (rules.length === 0) {
      return { text: 'The model found no rule it could turn into a question. Nothing was written.' }
    }
    const text = `${JSON.stringify(rules, null, 2)}\n`
    const save = async (written: string) => {
      const drafted: Drafted = { docs: hashText(docs), rules: hashText(written) }
      await $.store.set(`drafted:${root}`, drafted)
      await update($, drift, () => '')
    }
    const review = 'Review it before relying on Dredd: check that each question reads literally, which rules are hard, and what each applies to.'
    if (before === null || current === undefined) {
      await $.fs.write(path, text)
      await save(text)
      return { text: `Drafted ${rules.length} rules into ${RULES_PATH}. ${review}` }
    }
    const summary = describeChanges(ruleChanges(current, rules))
    if (summary === '') {
      await save(before)
      return { text: `No rule changed: ${RULES_PATH} already matches the rule docs, and was left as it is.` }
    }
    let answer: string
    try {
      answer = await $.ui.ask(`Replace ${RULES_PATH}? The redraft ${summary}.`, {
        options: ['Replace', 'Keep the current file'],
        header: 'Dredd',
      })
    } catch {
      return { text: `The redraft ${summary}. Nobody answered, so nothing was written.` }
    }
    if (answer !== 'Replace') return { text: `Kept ${RULES_PATH}. The redraft would have ${summary}.` }
    await $.fs.write(`${path}.bak`, before)
    await $.fs.write(path, text)
    await save(text)
    return {
      text: `Replaced ${RULES_PATH}: ${summary}. The old file is ${RULES_PATH}.bak. ${review} The new rules apply from the next session.`,
    }
  })

  on('command.run', { command: 'dredd-review' }, async ($, e) => {
    if (e.origin.kind !== 'composer') return typedOnly('dredd-review')
    const pr = e.args.trim()
    if (pr !== '' && !/^\d+$/.test(pr)) return { text: `Dredd Review takes a PR number or nothing, not "${pr}".` }
    const key = await $.env.get("TYPESAFE_API_KEY")
    if (key === undefined || key === '') return { text: 'Dredd Review needs TYPESAFE_API_KEY in the environment.' }
    const loaded = await loadRules($)
    if (typeof loaded === 'string') return { text: `Dredd Review: ${loaded}.` }
    const mine = rulesFor(loaded.rules, 'code')
    if (mine.length === 0) return { text: `No rule in ${RULES_PATH} applies to code.` }

    const root = await $.session.root()
    const diff = await diffFor($, root, pr)
    if ('error' in diff) return { text: diff.error }
    const chunks = chunkDiff(redact(diff.text))
    const scope = pr === '' ? 'this branch' : `PR #${pr}`
    if (chunks.length === 0) return { text: `Dredd Review of ${scope}: no added lines to check.` }

    const jobs = chunks.flatMap(chunk => ruleGroups(mine, chunk).map(group => ({ chunk, group })))
    const replies = await pool(jobs, 8, async job => {
      const body = reviewRequest(job.group, job.chunk)
      const ask = () =>
        Promise.race([jev($, key, body), $.clock.sleep(REVIEW_TIMEOUT_MS).then(() => ({ status: 0 }) as const)])
      const first = await ask()
      if (first.status !== 429) return 'answers' in first ? first.answers : undefined
      const second = await ask()
      return 'answers' in second ? second.answers : undefined
    })
    const found: Finding[] = []
    let unchecked = 0
    replies.forEach((answers, i) => {
      const job = jobs[i]!
      if (answers === undefined || unanswered(job.group, answers).length > 0) unchecked += 1
      if (answers !== undefined) found.push(...findings(job.group, job.chunk, answers))
    })
    await record($, [
      ...found.map(f => ({
        source: 'review' as const,
        verdict: f.verdict,
        subject: where(f),
        ruleId: f.rule.id,
        p: f.p,
      })),
      ...(unchecked > 0
        ? [{ source: 'review' as const, verdict: 'unchecked' as const, subject: `${scope}: ${unchecked} part(s)` }]
        : []),
    ])

    const text = report(found, unchecked, scope, secretFiles(diff.text))
    if (pr !== '') {
      try {
        const posted = await $.process.run(['gh', 'pr', 'comment', pr, '--body-file', '-'], {
          cwd: root,
          stdin: text,
          timeoutMs: 60_000,
        })
        if (posted.exitCode !== 0) return { text: `${text}\n\nPosting to ${scope} failed: ${posted.stderr.trim()}` }
      } catch (err) {
        return { text: `${text}\n\nPosting to ${scope} failed: ${messageOf(err)}` }
      }
      return { text: `${text}\n\nPosted to ${scope}.` }
    }
    const violations = found.filter(f => f.verdict === 'violation')
    if (violations.length > 0) {
      $.clock.after(0, () => {
        $.prompt.submit({ text: fixPrompt(violations) }).catch(err => {
          $.ui.log(`dredd: the fix turn did not start: ${messageOf(err)}`, { to: 'debug' })
        })
      })
    }
    return { text }
  })

  on('ui.close', async ($, e, next) => {
    await next(e)
    if (e.id === PANE) await update($, isLedgerOpen, () => false)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const waiting = await read($, held)
    const first = waiting[0]
    if (first !== undefined) {
      return (
        <Box flexDirection="column">
          <Text color="yellow" bold>⚠ Dredd · likely violation of hard rule {first.ruleId}</Text>
          <Box>
            <Text dimColor>Command  </Text>
            <Text bold>{first.subject}</Text>
          </Box>
          <Box>
            <Text dimColor>Rule     </Text>
            <Text>{first.rule}</Text>
          </Box>
          <Box>
            <Text dimColor>p        </Text>
            <Text color="red">{first.p.toFixed(2)}</Text>
          </Box>
          {waiting.length > 1 && <Text dimColor>{waiting.length - 1} more held after this one</Text>}
          <Box>
            {ANSWERS.map(([answer, label], i) => (
              <Box key={answer}>
                <Button key={answer} label={`${i + 1}: ${label}`} hotkey={String(i + 1)} onPress={() => decisions.set(first.id, answer)} />
                <Text> </Text>
              </Box>
            ))}
            <Text dimColor> Claude is waiting on your answer</Text>
          </Box>
        </Box>
      )
    }

    const list = await sessionLedger($)
    const c = counts(list)
    const tallies = ruleSummary(await projectLedger($))
    const room = Math.max(1, e.props.scroll.bodyRows - 3 - tallies.length)
    const colors = { violation: 'red', misjudged: 'yellow', citation: 'cyan', unchecked: 'gray' } as const
    const width = Math.max(20, e.props.bodyColumns - 1)
    return (
      <Box flexDirection="column">
        <Text bold>
          ⚖ Ledger · {c.violations} violations ({c.allowed} allowed) · {c.misjudged} misjudged · {c.citations} citations ·{' '}
          {c.unchecked} unchecked
        </Text>
        {tallies.length > 0 && <Text dimColor>Rules in this project, all sessions:</Text>}
        {tallies.map(r => (
          <Text color={r.hint === '' ? undefined : 'yellow'}>
            {clip(
              `  ${r.ruleId}  ${r.violations} violations (${r.allowed} allowed) · ${r.misjudged} misjudged${r.hint === '' ? '' : `  ← ${r.hint}`}`,
              width,
            )}
          </Text>
        ))}
        {list.length === 0 && <Text dimColor>Nothing cited this session.</Text>}
        {list.slice(-room).map(x => (
          <Text color={colors[x.verdict]}>
            {clip(
              [
                new Date(x.at).toTimeString().slice(0, 5),
                x.verdict.padEnd(9),
                x.ruleId ?? '-',
                x.p === undefined ? '' : x.p.toFixed(2),
                x.decision ?? '',
                x.subject,
              ]
                .filter(part => part !== '')
                .join('  '),
              width,
            )}
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const why = await read($, notice)
    const warning = await read($, drift)
    const waiting = await read($, held)
    const session = await $.session.id()
    const isEnabled = (await read($, onFor)) === session
    const isPaneOpen = await read($, isLedgerOpen)
    const c = counts(await sessionLedger($))
    const first = waiting[0]
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {first !== undefined && (
          <Box>
            <Text color="yellow" bold>
              ⚠ Dredd held {clip(first.subject, 50)} · rule {first.ruleId} (p={first.p.toFixed(2)}){' '}
            </Text>
            {first.isAsking === true ? (
              <Text dimColor>answer in the dialog</Text>
            ) : (
              <Box>
                {ANSWERS.map(([answer, label], i) => (
                  <Box key={answer}>
                    <Button
                      key={`band-${answer}`}
                      label={label}
                      hotkey={String(i + 1)}
                      plain
                      onPress={() => decisions.set(first.id, answer)}
                    />
                    <Text>  </Text>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )}
        <Box>
          <Text color={isEnabled ? 'green' : 'gray'} bold>
            ⚖ Dredd {isEnabled ? 'ON' : 'OFF'}
          </Text>
          <Text dimColor>
            {' '}· {c.violations} violations · {c.citations} citations
            {c.unchecked > 0 ? ` · ${c.unchecked} unchecked` : ''}
            {why !== '' ? ` · ${why}` : ''}{' '}
          </Text>
          {warning !== '' && <Text color="yellow">⚠ {warning} </Text>}
          <Button
            key="toggle"
            label={isEnabled ? 'Turn off' : 'Turn on'}
            hotkey="d"
            onPress={() => update($, onFor, value => (value === session ? null : session))}
          />
          <Text> </Text>
          <Button
            key="ledger"
            label={isPaneOpen ? 'Hide ledger' : 'Ledger'}
            hotkey="l"
            onPress={() => (isPaneOpen ? closePane($) : openPane($))}
          />
        </Box>
        {below}
      </Box>
    )
  })
}
