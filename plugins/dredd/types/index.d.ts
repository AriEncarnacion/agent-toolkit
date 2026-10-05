/**
 * dredd's state contract: the rule shape read from `.claude/dredd-rules.json`,
 * the ledger entries, the commands held for a decision, and the values the
 * pane and band draw from.
 */

/** One rule from CLAUDE.md, phrased as a Jev Noul question. */
export type Rule = {
  id: string
  rule: string
  question: string
  criteria?: { true: string; false: string }
  hard: boolean
  applies: 'command' | 'code' | 'both'
}

/** What a ledger entry records about an action or a line of a diff. */
export type Verdict = 'held' | 'violation' | 'citation' | 'unchecked'

/** One line of the ledger. */
export type Entry = {
  id: string
  at: number
  session: string
  source: 'monitor' | 'review'
  verdict: Verdict
  subject: string
  ruleId?: string
  p?: number
  kind?: string
  decision?: 'proceed' | 'cancel'
}

/** A command waiting on Proceed or Cancel. */
export type Held = {
  id: string
  entryIds: string[]
  ruleId: string
  rule: string
  p: number
  subject: string
}

/** The rules a session enforces, pinned from the file as it stood when the session first read it. */
export type Pinned = { session: string; text: string; rules: Rule[] }

declare module 'claude-code' {
  interface PluginState {
    dredd: {
      onFor: string | null
      ledger: Entry[]
      held: Held[]
      notice: string
      pinned: Pinned | null
    }
  }
}
