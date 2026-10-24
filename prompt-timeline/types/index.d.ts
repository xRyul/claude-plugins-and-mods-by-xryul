// `context`: how full the context window was, in percent, when the prompt's
// first response was answered; absent until that response is in the transcript.
export type TimelineEntry = { id: string; text: string; at: number; context?: number }

// A prompt the search matched: its first match, and the line either side of it.
export type SearchHit = { id: string; before: string; match: string; after: string }

// The search last applied: its query, how many prompts matched it, and the
// newest of them; an empty query filters nothing.
export type SearchResults = { query: string; total: number; hits: SearchHit[] }

// A run of the tree's lines, and its colour: -1 for the line the conversation
// runs down to where it stands, otherwise its branch's colour by number.
export type TreeLine = { text: string; tone: number }

// What a turn did, as the tree's row ends with it: pushed, committed, the files
// it changed, another tool it used, the commands it ran, or a reply alone.
export type Outcome = {
  label: string
  kind: 'push' | 'commit' | 'files' | 'tool' | 'cmds' | 'reply' | 'none'
}

// One prompt of the session's tree, as the tree view draws it: its turn number
// on its own branch, its dot and the lines beside it (`cells`), the row of
// lines between it and the row above (`above`), and whether the conversation
// stands at it (`here`), passes through it (`path`), or left it on a branch a
// rewind abandoned (`off`). `chip` names how many turns a branch the
// conversation does not run down has, on its first.
export type TreeNode = {
  id: string
  text: string
  at: number
  depth: number
  lane: number
  above: TreeLine[]
  cells: TreeLine[]
  tone: number
  place: 'here' | 'path' | 'off'
  outcome: Outcome
  chip?: string
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-timeline': {
      entries: TimelineEntry[]
      picked: string
      tick: number
      showContext: boolean
      field: string
      found: SearchResults
      isTree: boolean
      tree: Shaped<TreeNode[]>
      opened: string
    }
  }
}
