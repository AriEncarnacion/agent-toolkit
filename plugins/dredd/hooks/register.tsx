/**
 * dredd: re-asserts the project's CLAUDE.md rules at the moment of action, with
 * TypeSafe's Jev decision model doing the judging.
 *
 * Monitor is a `tool.call` hook on Bash and every MCP tool. It asks Jev one
 * Noul per command rule in `.claude/dredd-rules.json`; a likely break of a
 * hard rule is held in the Dredd pane for Proceed or Cancel, an uncertain one
 * is cited, the rest run. `/dredd-review [PR#]` sends the branch's or a PR's
 * diff in batched requests and reports violations and citations;
 * `/dredd-rules` drafts the rules file once with a model. Every held command,
 * violation and citation goes in the session's ledger, drawn in the pane and
 * counted in the band above the prompt, which carries the on/off toggle, and
 * kept per session in `$.store`.
 *
 * Monitor is off at the start of every session, `/clear` and resume included,
 * and only a person can turn it on, with the band's button. Both commands run only when a person typed them
 * at the prompt.
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
import type { Answer, Finding, JevRequest, Kept } from './dredd'

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

/** Proceed or Cancel, set by the pane's and band's buttons and read by the waiting hook. */
const decisions = new Map<string, 'proceed' | 'cancel'>()

/**
 * Calls whose hold has begun and not ended in Proceed: if the hook fails from
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
        entries: mergeEntries(stored?.entries ?? [], mine),
      }
      await $.store.set(key, kept)
    }
  } catch (err) {
    $.ui.log(`dredd: the ledger was not saved: ${messageOf(err)}`, { to: 'debug' })
  }
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

/** Writes a hold's outcome onto its ledger entries. */
const decide = async ($: EngineInterface, ids: string[], decision: 'proceed' | 'cancel') => {
  await update($, ledger, list => list.map(x => (ids.includes(x.id) ? { ...x, decision } : x)))
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

/** The rule Dredd enforces on its own rules file: no tool call changes it without a person. */
const GUARD = {
  id: 'dredd-rules-file',
  rule: "Changes to Dredd's own rules file (.claude/dredd-rules.json) need a person's approval.",
  p: 1,
}

/**
 * Whether a command or path names Dredd's rules file, read the way a shell
 * would: through quotes and backslashes, and through a glob that could
 * expand to it. A second line of defence: the rules a session enforces are
 * pinned at its start, so a change that gets past this has no effect anyway.
 */
const namesRulesFile = (text: string) => {
  const plain = text.replace(/["'`\\]/g, '')
  return /dredd[-_]?rules/i.test(plain) || /dredd[-_]?r[^\s/]{0,4}[*?[]/i.test(plain)
}

/** What a hold shows and records. */
type HoldSpec = { id: string; rule: string; p: number; entryIds: string[]; subject: string }

/**
 * Holds a call in the pane until a person presses Proceed or Cancel, then
 * runs it or refuses it. The wait polls with `sleep`, which costs none of
 * the hook's budget; where no `sleep` can run it asks in the engine's
 * dialog. With no surface to draw on, or once the hold has begun and the
 * hook fails, the call is refused, never run.
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
  void $.ui.open({ id: PANE, title: 'Dredd', focus: true })

  let decision: 'proceed' | 'cancel' = 'cancel'
  let why = 'The user refused it.'
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
    try {
      const answer = await $.ui.ask(
        `Dredd held ${clip(hold.subject, 80)} under rule ${hold.id} (p=${hold.p.toFixed(2)}): ${quoteLine(hold.rule)} Run it?`,
        { options: ['Proceed', 'Cancel'], header: 'Dredd' },
      )
      decision = answer === 'Proceed' ? 'proceed' : 'cancel'
    } catch {
      why = 'Dredd could not ask anyone to approve it here, so it did not run.'
    }
  }
  if (signal.aborted) why = 'The hold was interrupted, so it did not run.'
  decisions.delete(item.id)
  await update($, held, list => list.filter(x => x.id !== item.id))
  await decide($, hold.entryIds, decision)
  failClosed.delete(toolUseId)
  return decision === 'proceed' ? run() : refuse(why)
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

    if (namesRulesFile(raw)) {
      const [entry] = await record($, [{ source: 'monitor', verdict: 'held', subject, ruleId: GUARD.id, p: 1 }])
      return holdFor($, e.tool_use_id, next.signal, { ...GUARD, entryIds: [entry!.id], subject }, () => next(e))
    }

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
        verdict: f.band === 'hold' ? ('held' as const) : ('citation' as const),
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
    const entryIds = entries.filter(x => x.verdict === 'held').map(x => x.id)
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

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    if (!(await isMonitorOn($)) || !namesRulesFile(e.file_path)) return next(e)
    const subject = `${e.tool} ${e.file_path}`
    const [entry] = await record($, [{ source: 'monitor', verdict: 'held', subject, ruleId: GUARD.id, p: 1 }])
    return holdFor($, e.tool_use_id, next.signal, { ...GUARD, entryIds: [entry!.id], subject }, () => next(e))
  }).catch(async ($, e) => {
    failClosed.delete(e.tool_use_id)
    return { deny: 'Dredd guards its own rules file and failed while holding this edit, so it did not run.' }
  })

  on('command.run', { command: 'dredd-rules' }, async ($, e) => {
    if (e.origin.kind !== 'composer') return typedOnly('dredd-rules')
    const root = await $.session.root()
    const path = `${root}/${RULES_PATH}`
    if (await $.fs.exists(path)) {
      return { text: `${RULES_PATH} already exists. Dredd never overwrites rules you reviewed; delete it to draft again.` }
    }
    const docs = await ruleDocs($, root)
    if (docs === '') return { text: 'Found no CLAUDE.md or .claude/rules/*.md to draft rules from.' }
    const reply = await $.model.complete({
      model: 'opus',
      system: DRAFT_SYSTEM,
      prompt: draftPrompt(docs),
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
    await $.fs.write(path, `${JSON.stringify(rules, null, 2)}\n`)
    return {
      text:
        `Drafted ${rules.length} rules into ${RULES_PATH}. Review it before relying on Dredd: ` +
        'check that each question reads literally, which rules are hard, and what each applies to.',
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const waiting = await read($, held)
    const first = waiting[0]
    if (first !== undefined) {
      return (
        <Box flexDirection="column">
          <Text color="yellow" bold>⚠ Dredd · hard rule {first.ruleId}</Text>
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
            <Button key="proceed" label="1: Proceed" hotkey="1" onPress={() => decisions.set(first.id, 'proceed')} />
            <Text> </Text>
            <Button key="cancel" label="2: Cancel" hotkey="2" onPress={() => decisions.set(first.id, 'cancel')} />
            <Text dimColor>  Claude is waiting on your answer</Text>
          </Box>
        </Box>
      )
    }

    const session = await $.session.id()
    const list = (await read($, ledger)).filter(x => x.session === session)
    const c = counts(list)
    const room = Math.max(1, e.props.scroll.bodyRows - 2)
    const colors = { held: 'yellow', violation: 'red', citation: 'cyan', unchecked: 'gray' } as const
    return (
      <Box flexDirection="column">
        <Text bold>
          ⚖ Ledger · {c.held} held · {c.violations} violations · {c.citations} citations · {c.unchecked} unchecked
        </Text>
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
              Math.max(20, e.props.bodyColumns - 1),
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
    const waiting = await read($, held)
    const session = await $.session.id()
    const isEnabled = (await read($, onFor)) === session
    const c = counts((await read($, ledger)).filter(x => x.session === session))
    const first = waiting[0]
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {first !== undefined && (
          <Box>
            <Text color="yellow" bold>
              ⚠ Dredd held {clip(first.subject, 60)} · rule {first.ruleId} (p={first.p.toFixed(2)}){' '}
            </Text>
            <Button key="band-proceed" label="Proceed" onPress={() => decisions.set(first.id, 'proceed')} />
            <Text> </Text>
            <Button key="band-cancel" label="Cancel" onPress={() => decisions.set(first.id, 'cancel')} />
          </Box>
        )}
        <Box>
          <Text color={isEnabled ? 'green' : 'gray'} bold>
            ⚖ Dredd {isEnabled ? 'ON' : 'OFF'}
          </Text>
          <Text dimColor>
            {' '}· {c.held} held · {c.violations} violations · {c.citations} citations
            {c.unchecked > 0 ? ` · ${c.unchecked} unchecked` : ''}
            {why !== '' ? ` · ${why}` : ''}{' '}
          </Text>
          <Button
            key="toggle"
            label={isEnabled ? 'Turn off' : 'Turn on'}
            onPress={() => update($, onFor, value => (value === session ? null : session))}
          />
          <Text> </Text>
          <Button key="ledger" label="Ledger" onPress={() => void $.ui.open({ id: PANE, title: 'Dredd' })} />
        </Box>
        {below}
      </Box>
    )
  })
}
