// `context`: how full the context window was, in percent, when the prompt's
// first response was answered; absent until that response is in the transcript.
export type TimelineEntry = { id: string; text: string; at: number; context?: number }

// A prompt the search matched: its first match, and the line either side of it.
export type SearchHit = { id: string; before: string; match: string; after: string }

// The search last applied: its query, how many prompts matched it, and the
// newest of them; an empty query filters nothing.
export type SearchResults = { query: string; total: number; hits: SearchHit[] }

// A run of the tree's lines before a prompt, and whether it carries the
// conversation's path on to where it stands.
export type TreeLine = { text: string; isPath: boolean }

// One prompt of the session's tree, as the tree view draws it: its turn number
// on its own branch, the lines drawn before it, and whether the conversation
// stands at it (`here`), passes through it (`path`), or left it on a branch a
// rewind abandoned (`off`).
export type TreeNode = {
  id: string
  text: string
  at: number
  depth: number
  gutter: TreeLine[]
  place: 'here' | 'path' | 'off'
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
      tree: TreeNode[]
      opened: string
    }
  }
}
