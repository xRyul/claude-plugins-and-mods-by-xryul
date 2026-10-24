import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer, UiPressArgument } from 'claude-code'

import type { Outcome, SearchHit, SearchResults, TimelineEntry, TreeLine, TreeNode } from '../types'

const PANE = 'prompt-timeline'
const TITLE = 'Timeline'
// Room for the header's controls.
const COLUMNS = 32
const MAX_ENTRIES = 1000
// The most of a prompt any pane draws: wider than a docked pane gets.
const PREVIEW = 200
// The most of a prompt the search reads: a long paste is searched this far.
const FULL = 32_000
// The most prompt text the scan hands back in all, under the 4 MiB of output
// `$.process.run` keeps: in a long session each prompt's share is smaller.
const BUDGET = 3_000_000
// Who typed it: the composer, or the Remote Control bridge. Peers, task
// notifications and plugins are not the person's own prompts.
const PERSON_KINDS = ['composer', 'bridge']
// Reads the transcript for what came before the mod loaded: one record per
// prompt the person typed (`P line uuid timestamp text`, the text as its JSON
// string, closing quote and all when it ends within the share) and per
// response (`R line tokens`, the input tokens its usage counts). Responses
// print as they come, prompts at the end, so both still ascend by line. Keys
// are matched as JSON writes them, so no text inside a message (where quotes
// are escaped) matches; a prompt's pasted images stay in the file, never
// copied out.
const SCAN = `
function field(key,   start, rest) {
  if (!(start = index($0, key))) return ""
  rest = substr($0, start + length(key))
  return substr(rest, 1, index(rest, "\\"") - 1)
}
function count(key) {
  if (!match($0, "\\"" key "\\":[0-9]+")) return 0
  return substr($0, RSTART + length(key) + 3, RLENGTH - length(key) - 3) + 0
}
index($0, "\\"origin\\":{\\"kind\\":\\"human\\"}") || index($0, "\\"origin\\":{\\"kind\\":\\"bridge\\"}") {
  if (!index($0, "\\"type\\":\\"user\\"") || index($0, "\\"isMeta\\":true") || index($0, "\\"isSidechain\\":true")) next
  key = "\\"message\\":{\\"role\\":\\"user\\",\\"content\\":\\""
  if (!(start = index($0, key))) start = index($0, key = "\\"type\\":\\"text\\",\\"text\\":\\"")
  text = start ? substr($0, start + length(key), ${FULL}) : ""
  if (match(text, /^([^"\\\\]|\\\\.)*/) && RLENGTH < length(text)) text = substr(text, 1, RLENGTH + 1)
  n++
  line[n] = NR; id[n] = field("\\"uuid\\":\\""); at[n] = field("\\"timestamp\\":\\""); body[n] = text
  next
}
index($0, "\\"type\\":\\"assistant\\"") {
  total = count("input_tokens") + count("cache_creation_input_tokens") + count("cache_read_input_tokens")
  if (total > 0) print "R\\t" NR "\\t" total
}
END {
  first = n > ${MAX_ENTRIES} ? n - ${MAX_ENTRIES} + 1 : 1
  share = n ? int(${BUDGET} / (n - first + 1)) : 0
  for (i = first; i <= n; i++) {
    print "P\\t" line[i] "\\t" id[i] "\\t" at[i] "\\t" (length(body[i]) > share ? substr(body[i], 1, share) : body[i])
  }
}`
// The age column's width: its longest label, "just now".
const AGE_COLUMNS = 8
// The context column's width: "100%".
const CONTEXT_COLUMNS = 4
// The header's controls: the switch between the list and the tree, `  list
// tree `, `  ○ find`, and `  ● ctx`, which only the list shows; and its title,
// `◆ Timeline`.
const SWITCH_COLUMNS = 14
const FIND_COLUMNS = 8
const CONTEXT_TOGGLE_COLUMNS = 7
const TITLE_COLUMNS = 10

// How much of a prompt, and of the turn's last reply, the tree scan copies out
// of the transcript, as JSON strings: more than a row or a card draws.
const PROMPT_CHARS = 400
const REPLY_CHARS = 800
// Reads the transcript's whole tree, the branches a rewind left included: a
// record naming the prompt the conversation stands at (`H owner`), then one
// per prompt the person typed (`T uuid parent timestamp end cmds files tool git
// text reply`). Each row belongs to the nearest prompt above it, so `parent` is
// the prompt whose turn this one was asked after, `end` the last row of the
// prompt's own turn, and `reply` the opening of that turn's last text. `cmds`
// counts the turn's shell commands, `files` the files it changed, `tool` names
// another tool it used, and `git` is 2 where a command pushed, 1 where one
// committed. The conversation stands where the newest row is, or at the leaf a
// `last-prompt` record after it names (a rewind writes one). A compacted row's
// parent is the row it summed up; a subagent's rows are left out.
const TREE_SCAN = `
function field(key,   start, rest) {
  if (!(start = index($0, key))) return ""
  rest = substr($0, start + length(key))
  return substr(rest, 1, index(rest, "\\"") - 1)
}
function after(text, key,   start, rest) {
  if (!(start = index(text, key))) return ""
  rest = substr(text, start + length(key))
  return substr(rest, 1, index(rest, "\\"") - 1)
}
function opening(key, size,   start, text) {
  if (!(start = index($0, key))) return ""
  text = substr($0, start + length(key), size)
  if (match(text, /^([^"\\\\]|\\\\.)*/) && RLENGTH < length(text)) text = substr(text, 1, RLENGTH + 1)
  return text
}
function owner(id,   steps, i, found, path) {
  while (id != "" && !(id in own) && steps < 100000) {
    path[++steps] = id
    id = (id in up) ? up[id] : ""
  }
  found = (id in own) ? own[id] : ""
  for (i = 1; i <= steps; i++) own[path[i]] = found
  return found
}
index($0, "{\\"parentUuid\\":") == 1 {
  if (match($0, /^\\{"parentUuid":("[^"]*"|null),"isSidechain":true/)) next
  id = field("\\"uuid\\":\\"")
  if (id == "") next
  up[id] = substr($0, 15, 4) == "null" ? field("\\"logicalParentUuid\\":\\"") : field("\\"parentUuid\\":\\"")
  rows[++count] = id
  last = id; lastLine = NR
  if (index($0, "\\"type\\":\\"assistant\\",\\"uuid\\":\\"")) {
    text = opening("\\"type\\":\\"text\\",\\"text\\":\\"", ${REPLY_CHARS})
    if (text != "") said[id] = text
    if (start = index($0, "\\"type\\":\\"tool_use\\"")) {
      call = substr($0, start)
      used[id] = after(call, "\\"name\\":\\"")
      if (used[id] ~ /^(Edit|Write|NotebookEdit)$/) {
        touched[id] = after(call, "\\"file_path\\":\\"")
        if (touched[id] == "") touched[id] = after(call, "\\"notebook_path\\":\\"")
      }
      if (used[id] ~ /^(Bash|PowerShell)$/) {
        if (index(call, "git push") || index(call, "gt submit")) git[id] = 2
        else if (index(call, "git commit")) git[id] = 1
      }
    }
    next
  }
  if (!index($0, "\\"origin\\":{\\"kind\\":\\"human\\"}") && !index($0, "\\"origin\\":{\\"kind\\":\\"bridge\\"}")) next
  if (index($0, "\\"isMeta\\":true")) next
  key = "\\"message\\":{\\"role\\":\\"user\\",\\"content\\":\\""
  if (!index($0, key)) key = "\\"type\\":\\"text\\",\\"text\\":\\""
  text = opening(key, ${PROMPT_CHARS})
  bare = text
  sub(/^([ \\t]|\\\\[ntr])+/, "", bare)
  if (bare == "" || bare ~ /^</) next
  own[id] = id
  n++
  prompt[n] = id; at[n] = field("\\"timestamp\\":\\""); body[n] = text
  next
}
index($0, "{\\"type\\":\\"last-prompt\\"") == 1 {
  leaf = field("\\"leafUuid\\":\\""); leafLine = NR
}
END {
  for (i = 1; i <= count; i++) {
    found = owner(rows[i])
    if (found == "") continue
    end[found] = rows[i]
    if (rows[i] in said) reply[found] = said[rows[i]]
    if (!(rows[i] in used)) continue
    name = used[rows[i]]
    if (git[rows[i]] > made[found]) made[found] = git[rows[i]]
    if (name ~ /^(Bash|PowerShell)$/) cmds[found]++
    else if (rows[i] in touched) {
      if (!((found, touched[rows[i]]) in seen)) files[found]++
      seen[found, touched[rows[i]]] = 1
    }
    else if (name !~ /^(Read|Grep|Glob|LS|TodoWrite|ToolSearch|Skill)$/) tool[found] = name
  }
  print "H\\t" owner((leafLine > lastLine && (leaf in up)) ? leaf : last)
  for (i = (n > ${MAX_ENTRIES}) ? n - ${MAX_ENTRIES} + 1 : 1; i <= n; i++) {
    id = prompt[i]
    print "T\\t" id "\\t" owner(up[id]) "\\t" at[i] "\\t" end[id] "\\t" (cmds[id] + 0) "\\t" (files[id] + 0) "\\t" tool[id] "\\t" (made[id] + 0) "\\t" body[i] "\\t" reply[id]
  }
}`
// The most of a turn's last reply its card shows.
const REPLY = 320
// What a card's switch button's key opens with, before the prompt's id, and
// what the button says.
const SWITCH = 'switch:'
const CONTINUE = ' ↪ continue here '
// What a card's copy button's key opens with, before the prompt's id: it
// copies the `/resume-at` command that opens the session at that turn.
const COPY = 'copy:'
// Copies every message of a transcript, every branch, to `dst` under another
// session's id: `from` and `to` are the two `"sessionId":"…"` pairs. Rows that
// are not messages (titles, costs, checkpoints) stay with the original.
const COPY_SCAN = `index($0, "\\"uuid\\":\\"") { gsub(from, to); print > dst }`
const RESUME_AT_USAGE =
  'Usage: /resume-at [--copy] <session-id>:<message-id>, or /resume-at <message-id> for this session.'
// Each prompt's dot on its line: where the conversation stands, a prompt it
// passes through, and one on a branch a rewind left.
const DOTS = { here: '◉', path: '●', off: '○' } as const
// The line the conversation runs down is the accent; every other branch takes
// the next of these, so a branch keeps its colour however deep it sits. Theme
// keys, so the lines follow the person's theme.
const PATH = -1
const TONES = ['merged', 'planMode', 'bashBorder', 'ide', 'success', 'warning']
// The width of what a tree row ends with: what the turn did, then when it was
// asked ("◂ here" on the row the conversation stands at).
const OUTCOME_COLUMNS = 11
const AT_COLUMNS = 6
// How many lines of its last reply an opened card shows.
const REPLY_LINES = 4
// Behind the row the conversation stands at, and an opened card: the theme's
// own shade behind the person's messages.
const HIGHLIGHT = 'userMessageBackground'
// The tree's last row copies the command that opens the session where it
// stands.
const COPY_HERE = 'copy-here'

// What the search field's key opens with: the one element the focus ring may
// rest on.
const SEARCH = 'search:'
// How long typing pauses before the timeline filters: a key costs no search
// and no redraw.
const SETTLE = 150
// The most matches drawn, newest first: a query that matches nearly every
// prompt still draws a short list.
const MAX_HITS = 100
// How much of a prompt a hit keeps before its match.
const LEAD = 40

const ACCENT = 'claude'
const MATCH = 'warning'

const NOTHING_FOUND: SearchResults = { query: '', total: 0, hits: [] }

const entries = atom({ plugin: 'prompt-timeline', key: 'entries' } as const, [])
const picked = atom({ plugin: 'prompt-timeline', key: 'picked' } as const, '')
const showContext = atom({ plugin: 'prompt-timeline', key: 'showContext' } as const, true)
// Bumped every minute so the "5m ago" labels redraw.
const tick = atom({ plugin: 'prompt-timeline', key: 'tick' } as const, 0)
// The open search field's key, empty while search is closed. The surface keeps
// what was typed in a field by its key after the field closes: a new key each
// time it opens is a new, empty field.
const field = atom({ plugin: 'prompt-timeline', key: 'field' } as const, '')
const found = atom({ plugin: 'prompt-timeline', key: 'found' } as const, NOTHING_FOUND)
const isTree = atom({ plugin: 'prompt-timeline', key: 'isTree' } as const, false)
// Shaped: a tree an earlier version laid out reads as empty until it is read
// again, never as rows of the old shape.
const tree = atom({ plugin: 'prompt-timeline', key: 'tree' } as const, [], { shape: 'tree-2' })
// The prompt on an abandoned branch whose card is open, or ''.
const opened = atom({ plugin: 'prompt-timeline', key: 'opened' } as const, '')

// Prompts sent on main that no response has answered yet. A reload loses it;
// the scan at load fills in what it missed.
let waiting: string[] = []
// Each prompt's whole text on one line, by id, for the search. Kept out of
// `$.state`, which would copy it on every write. A reload loses it and the
// scan at load reads it again; until then the search reads the previews.
const corpus = new Map<string, string>()
// The search waiting for typing to pause, and a count of searches asked, so
// one that finishes after a newer one was asked writes nothing.
let settling: Timer | undefined
let searches = 0
// Each prompt of the tree as the scan read it, by id: the turn's last row and
// last reply stay here, out of `$.state`, for the cards and the switch. A
// reload loses it and the scan at load reads it again.
type Turn = { id: string; parent: string; at: number; end: string; text: string; reply: string; outcome: Outcome }
let turns = new Map<string, Turn>()
// The transcript's size when the tree was last read: a scan that would read
// the same bytes is skipped. And a count of scans asked, so one that finishes
// after a newer one was asked writes nothing.
let grownAt = -1
let grows = 0
// How many times the session was resumed: a switch reads it to tell whether
// its `/resume` took.
let resumes = 0

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  if (content.some(block => block?.type === 'tool_result')) return ''

  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
}

// A slash command's record, a bash-mode line and the engine's own wrappers
// all open with a tag: none of them is a prompt the person wrote.
function isTyped(text: string): boolean {
  const trimmed = text.trim()

  return trimmed !== '' && !trimmed.startsWith('<')
}

// Adds the entries not yet listed, and the context of those listed without one.
function merge(list: TimelineEntry[], more: TimelineEntry[]): TimelineEntry[] {
  const byId = new Map(list.map(entry => [entry.id, entry]))
  for (const entry of more) {
    const known = byId.get(entry.id)
    if (known === undefined) byId.set(entry.id, entry)
    else if (known.context === undefined && entry.context !== undefined) {
      byId.set(entry.id, { ...known, context: entry.context })
    }
  }

  return [...byId.values()].sort((a, b) => a.at - b.at).slice(-MAX_ENTRIES)
}

// A new prompt is the newest: one scan for a repeat, no sort.
function append(list: TimelineEntry[], entry: TimelineEntry): TimelineEntry[] {
  if (list.some(one => one.id === entry.id)) return list
  if ((list.at(-1)?.at ?? 0) > entry.at) return merge(list, [entry])

  return [...list.slice(1 - MAX_ENTRIES), entry]
}

function cut(line: string, room: number): string {
  if (room <= 0) return ''

  return line.length <= room ? line : `${line.slice(0, Math.max(1, room - 1)).trimEnd()}…`
}

// A prompt on one line, as far as the search reads it.
function flatten(text: string): string {
  return text.slice(0, FULL).replace(/\s+/g, ' ').trim()
}

// What the timeline keeps of a prompt: one line, no longer than a pane shows.
// The full text would be copied on every write and scanned on every draw.
function preview(text: string): string {
  return cut(flatten(text), PREVIEW)
}

// The corpus drops prompts the timeline no longer lists.
function prune(list: TimelineEntry[]) {
  if (corpus.size <= MAX_ENTRIES) return
  const listed = new Set(list.map(entry => entry.id))
  for (const id of corpus.keys()) if (!listed.has(id)) corpus.delete(id)
}

// Each word of a query, matched anywhere and in any case.
function termsOf(query: string): RegExp[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(term => term !== '')
    .map(term => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
}

// The prompts holding every word of the query, newest first: how many, and
// the first MAX_HITS of them with the line around the first word's match.
function search(list: TimelineEntry[], query: string): SearchResults {
  const terms = termsOf(query)
  if (terms.length === 0) return NOTHING_FOUND

  const hits: SearchHit[] = []
  let total = 0
  for (let index = list.length - 1; index >= 0; index--) {
    const entry = list[index]!
    const text = corpus.get(entry.id) ?? entry.text
    if (!terms.every(term => term.test(text))) continue

    total++
    if (hits.length === MAX_HITS) continue
    const match = terms[0]!.exec(text)!
    const from = Math.max(0, match.index - LEAD)
    hits.push({
      id: entry.id,
      before: `${from > 0 ? '…' : ''}${text.slice(from, match.index)}`,
      match: match[0],
      after: cut(text.slice(match.index + match[0].length), PREVIEW),
    })
  }

  return { query, total, hits }
}

// A hit's line in `room` columns: the match whole where it fits, after as much
// of what leads to it as leaves the match within the first two thirds.
function fit(hit: SearchHit, room: number): [string, string, string] {
  const match = cut(hit.match, room)
  const spare = room - match.length
  const lead = Math.floor((room * 2) / 3) - match.length
  let before = hit.before
  if (before.length > Math.max(0, lead)) {
    const kept = Math.max(0, Math.min(lead, spare))
    before = kept > 1 ? `…${before.slice(before.length - kept + 1)}` : ''
  }

  return [before, match, cut(hit.after, spare - before.length)]
}

function age(at: number, now: number): string {
  if (at === 0) return ''
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)

  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

// Dim while the window has room; the theme's warning, then error, as it fills.
function contextTone(percent: number | undefined) {
  if (percent !== undefined && percent >= 90) return { color: 'error' }
  if (percent !== undefined && percent >= 70) return { color: 'warning' }

  return { dimColor: true }
}

// The Claude Code folder that holds every project's transcripts.
async function configDir($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')

  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home && `${home}/.claude`)
}

async function transcriptPath($: EngineInterface): Promise<string | undefined> {
  const id = await $.session.id()
  const config = await configDir($)
  if (!config) return undefined

  const projects = `${config}/projects`
  const cwd = await $.session.cwd()
  const guess = `${projects}/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
  if (await $.fs.exists(guess)) return guess
  if (!(await $.fs.exists(projects))) return undefined

  for (const dir of await $.fs.list(projects)) {
    const path = `${projects}/${dir.name}/${id}.jsonl`
    if (dir.kind === 'dir' && (await $.fs.exists(path))) return path
  }

  return undefined
}

// A JSON string's opening as the scan cut it, decoded: up to its closing
// quote, or where it was cut, short of a broken escape and marked as cut.
function decode(escaped: string): string {
  // Most come back whole, closing quote and all: one parse.
  if (escaped.endsWith('"')) {
    try {
      return JSON.parse(`"${escaped}`)
    } catch {
      // Something after the string, or a quote that was escaped: walk it.
    }
  }
  let end = 0
  while (end < escaped.length && escaped[end] !== '"') {
    const size = escaped[end] !== '\\' ? 1 : escaped[end + 1] === 'u' ? 6 : 2
    if (end + size > escaped.length) break
    end += size
  }
  try {
    const text: string = JSON.parse(`"${escaped.slice(0, end)}"`)

    return escaped[end] === '"' ? text : `${text.trimEnd()}…`
  } catch {
    return ''
  }
}

function percentOf(tokens: number, window: number): number {
  return Math.min(100, Math.round((tokens / window) * 100))
}

// The prompts in the transcript, each with the context its first response was
// answered over: those before the mod loaded, and a resumed session's earlier
// ones. Live prompts take theirs from the API instead (turn.step), so this
// runs once per load, and its output is a short record per row.
async function seed($: EngineInterface): Promise<void> {
  const path = await transcriptPath($)
  if (path === undefined) return

  const scan = await $.process.run(['awk', SCAN, path])
  if (scan.exitCode !== 0) return

  const prompts: [number, TimelineEntry][] = []
  const answered: [number, number][] = []
  for (const record of scan.stdout.split('\n')) {
    const [kind, line = '', first = '', timestamp = '', escaped = ''] = record.split('\t')
    if (kind === 'R') answered.push([Number(line), Number(first)])
    if (kind !== 'P') continue

    const text = decode(escaped)
    if (first === '' || !isTyped(text)) continue
    const whole = flatten(text)
    corpus.set(first, whole)
    prompts.push([Number(line), { id: first, text: cut(whole, PREVIEW), at: Date.parse(timestamp) || 0 }])
  }

  // Both lists ascend by line: one walk pairs each prompt with the first
  // response after it and before the next prompt.
  const { window } = (await $.session.usage()).context
  let next = 0
  for (const [index, [line, entry]] of prompts.entries()) {
    const before = prompts[index + 1]?.[0] ?? Infinity
    while (next < answered.length && answered[next]![0] < line) next++
    const response = answered[next]
    if (response !== undefined && response[0] < before && window > 0) {
      entry.context = percentOf(response[1], window)
    }
  }

  // Entries an earlier load kept whole are cut down too.
  await update($, entries, list =>
    merge(
      list.map(entry => ({ ...entry, text: preview(entry.text) })),
      prompts.map(([, entry]) => entry),
    ),
  )
  await refind($)
}

// Runs the query over the timeline and shows what it matched, unless a newer
// search was asked meanwhile.
async function find($: EngineInterface, query: string) {
  const ask = ++searches
  const results = search(await read($, entries), query)
  if (ask !== searches) return

  await update($, found, () => results)
}

// The search shown, run again over a timeline that changed under it.
async function refind($: EngineInterface) {
  const { query } = await read($, found)
  if (query !== '') await find($, query)
}

// The query typed so far: searched once typing pauses, or at once on Enter.
function typed($: EngineInterface, query: string, isSubmitted = false) {
  settling?.cancel()
  if (isSubmitted) {
    void find($, query).catch(() => undefined)

    return
  }
  settling = $.clock.after(SETTLE, () => void find($, query).catch(() => undefined))
}

async function toggleSearch($: EngineInterface) {
  settling?.cancel()
  searches++
  // Each search starts from an empty field and the whole timeline.
  const key = (await read($, field)) === '' ? `${SEARCH}${await $.clock.now()}` : ''
  await update($, found, () => NOTHING_FOUND)
  await update($, field, () => key)
  if (key === '') return

  // The search filters the list: leave the tree for it.
  if (await read($, isTree)) {
    await update($, isTree, () => false)
    await $.store.set('isTree', false)
  }

  // The field sits at the top: scroll it into view. A press leaves the keys
  // with the prompt, so the pane asks for them (granted over an empty prompt),
  // and the ring goes to the field.
  await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
  await $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS, focus: true }).catch(() => undefined)
  await $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

async function closeSearch($: EngineInterface) {
  settling?.cancel()
  searches++
  await update($, found, () => NOTHING_FOUND)
  await update($, field, () => '')
}

async function toggleContext($: EngineInterface) {
  await update($, showContext, isShown => !isShown)
  await $.store.set('showContext', await read($, showContext))
}

async function open($: EngineInterface) {
  await $.store.set('isOpen', true)

  return $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS })
}

async function jump($: EngineInterface, id: string) {
  // Scroll first: a transcript row moves only while answering the press.
  const moved = await $.ui
    .scroll({ to: { requestId: id }, block: 'start' })
    .catch((error: unknown) => ({ deny: String(error) }))
  await update($, picked, () => id)
  if (moved.deny !== undefined) $.ui.toast(`Couldn't scroll to that prompt: ${moved.deny}`)
}

// What a turn did, by what most deserves its row: a push, a commit, the files
// it changed, another tool it used, the commands it ran, or a reply alone.
function outcomeOf(cmds: number, files: number, tool: string, git: number, reply: string): Outcome {
  if (git === 2) return { label: '⇡ pushed', kind: 'push' }
  if (git === 1) return { label: '● committed', kind: 'commit' }
  if (files > 0) return { label: `✎ ${files} file${files === 1 ? '' : 's'}`, kind: 'files' }
  if (tool !== '') return { label: `◇ ${tool.replace(/^mcp__.*__/, '')}`, kind: 'tool' }
  if (cmds > 0) return { label: `› ${cmds} cmd${cmds === 1 ? '' : 's'}`, kind: 'cmds' }

  return reply === '' ? { label: 'no reply', kind: 'none' } : { label: 'reply', kind: 'reply' }
}

// A line's colour, by its tone.
function toneColor(tone: number): string {
  return tone === PATH ? ACCENT : TONES[tone % TONES.length]!
}

// When a prompt was sent: its time today, its date before.
function sentAt(at: number, now: number): string {
  if (at === 0) return ''
  const date = new Date(at)
  if (date.toDateString() !== new Date(now).toDateString()) {
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }

  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// A text in lines of at most `room` columns, broken between words, the last
// of `most` lines cut short with an ellipsis where more was left.
function wrap(text: string, room: number, most: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(one => one !== '')) {
    if (line !== '' && line.length + 1 + word.length > room) {
      lines.push(line)
      line = ''
    }
    line = line === '' ? cut(word, room) : `${line} ${word}`
  }
  if (line !== '') lines.push(line)
  if (lines.length <= most) return lines

  return [...lines.slice(0, most - 1), cut(`${lines[most - 1]} …`, room)]
}

// The tree drawn as lanes, top down, each prompt a dot on its branch's line,
// below the one it was asked after. At every split the newest branch carries
// on down the lane and older ones fork off one lane to the right, each drawn
// whole before the lane goes on. A row of lines sits between every two
// prompts: it carries each line on, or forks a branch off (`├─╮`). Where the
// conversation stands decides only which dots are lit and which lines are the
// accent, so a switch moves nothing; a new branch takes its lane.
function layout(list: Turn[], here: string): TreeNode[] {
  const byId = new Map(list.map(turn => [turn.id, turn]))
  const roots: Turn[] = []
  const children = new Map<string, Turn[]>()
  for (const turn of list) {
    const siblings = children.get(turn.parent)
    if (!byId.has(turn.parent)) roots.push(turn)
    else if (siblings === undefined) children.set(turn.parent, [turn])
    else siblings.push(turn)
  }

  // The prompts the conversation passes through on its way to here.
  const path = new Set<string>()
  for (let id = here; byId.has(id) && !path.has(id); id = byId.get(id)!.parent) path.add(id)

  const nodes: TreeNode[] = []
  let branches = 0
  // Draws a branch from its first prompt, right of `lanes`, each the tone its
  // line goes on below in. Its first row forks from the lane left of it, in
  // the `fork` tone.
  const draw = (first: Turn, depth: number, lanes: number[], fork: number | undefined) => {
    const branch = branches++
    const beside = lanes.map(tone => ({ text: '│ ', tone }))
    const own: TreeNode[] = []
    let turn: Turn | undefined = first
    for (; turn !== undefined; depth++) {
      const place = turn.id === here ? 'here' : path.has(turn.id) ? 'path' : 'off'
      const tone = place === 'off' ? branch : PATH
      const above =
        own.length > 0
          ? [...beside, { text: '│', tone }]
          : fork === undefined
            ? []
            : [...beside.slice(0, -1), { text: '├', tone: fork }, { text: '─╮', tone }]
      const node: TreeNode = {
        id: turn.id,
        text: turn.text,
        at: turn.at,
        depth,
        lane: lanes.length,
        above,
        cells: [...beside, { text: DOTS[place], tone }],
        tone,
        place,
        outcome: turn.outcome,
      }
      nodes.push(node)
      own.push(node)

      const next: Turn[] = children.get(turn.id) ?? []
      const sides = next.slice(0, -1)
      const onward: Turn | undefined = next[next.length - 1]
      sides.forEach((side, index) => {
        // The path runs on down this lane past the branch to the onward
        // prompt or to a later branch.
        const leadsOn = [onward!, ...sides.slice(index + 1)].some(later => path.has(later.id))
        const lane = leadsOn ? PATH : branch
        draw(side, depth + 1, [...lanes, lane], path.has(side.id) ? PATH : lane)
      })
      turn = onward
    }

    // The path runs down the start of a branch, if at all: the rest of it is a
    // branch the conversation left, and its first row says how long it is.
    const left = own.filter(node => node.place === 'off')
    if (left[0] !== undefined) {
      const isUnanswered = left.length === 1 && left[0].outcome.kind === 'none'
      left[0].chip = isUnanswered ? 'no reply' : `${left.length} turn${left.length === 1 ? '' : 's'}`
    }
  }
  for (const root of roots) draw(root, 1, [], undefined)

  return nodes
}

// Reads the transcript's tree again, unless it has not grown since it was
// last read.
async function grow($: EngineInterface, isForced = false): Promise<void> {
  const path = await transcriptPath($)
  if (path === undefined) return
  const { size } = await $.fs.stat(path)
  if (!isForced && size === grownAt) return

  const ask = ++grows
  const scan = await $.process.run(['awk', TREE_SCAN, path])
  if (scan.exitCode !== 0 || ask !== grows) return

  let here = ''
  const list: Turn[] = []
  for (const record of scan.stdout.split('\n')) {
    const [kind, id = '', parent = '', timestamp = '', end = '', cmds = '', files = '', tool = '', git = '', text = '', reply = ''] =
      record.split('\t')
    if (kind === 'H') here = id
    if (kind !== 'T' || id === '') continue
    // A turn with no text has no reply to decode, not one cut short.
    const said = reply === '' ? '' : cut(flatten(decode(reply)), REPLY)
    list.push({
      id,
      parent,
      at: Date.parse(timestamp) || 0,
      end,
      // A pasted image is a mark, not its placeholder's words.
      text: preview(decode(text)).replace(/\[Image #\d+\]/g, '▣'),
      reply: said,
      outcome: outcomeOf(Number(cmds) || 0, Number(files) || 0, tool, Number(git) || 0, said),
    })
  }
  grownAt = size
  turns = new Map(list.map(turn => [turn.id, turn]))
  await update($, tree, () => layout(list, here))
}

async function regrow($: EngineInterface) {
  if (await read($, isTree)) await grow($).catch(() => undefined)
}

async function toggleTree($: EngineInterface) {
  const isShown = !(await read($, isTree))
  await closeSearch($)
  await update($, opened, () => '')
  await update($, isTree, () => isShown)
  await $.store.set('isTree', isShown)
  if (!isShown) return

  await grow($).catch(() => undefined)
  void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
}

// A press opens the prompt's card, or closes it. A prompt the conversation
// passes through is in the transcript too: the press scrolls to it.
async function pick($: EngineInterface, id: string) {
  const node = (await read($, tree)).find(one => one.id === id)
  if (node?.place !== 'off') await jump($, id)
  await update($, opened, shown => (shown === id ? '' : id))
}

// Copies the command that opens this session at the end of the prompt's turn
// from another terminal, the message named by its first eight characters as
// the status line names it.
async function copyResume($: EngineInterface, id: string) {
  const end = turns.get(id)?.end
  if (!end) {
    $.ui.toast("Couldn't find that turn in the transcript.")

    return
  }
  const command = `/resume-at ${await $.session.id()}:${end.slice(0, 8)}`
  const { isCopied } = await $.ui.copy({ text: command }).catch(() => ({ isCopied: false }))
  $.ui.toast(isCopied ? `Copied ${command}` : `Couldn't copy it: ${command}`)
}

// Points a session at a message with a `last-prompt` record, the one Claude
// Code writes when it rewinds: resuming the session follows the last one
// written. No row is changed or removed. Resolves why not, if it could not.
async function pointAt(
  $: EngineInterface,
  path: string,
  sessionId: string,
  leaf: string,
  lastPrompt: string,
): Promise<string | undefined> {
  const record = JSON.stringify({
    type: 'last-prompt',
    ...(lastPrompt === '' ? {} : { lastPrompt }),
    leafUuid: leaf,
    explicit: true,
    sessionId,
  })
  const wrote = await $.process.run(['sh', '-c', 'printf "%s\\n" "$1" >> "$2"', 'sh', record, path])

  return wrote.exitCode === 0 ? undefined : `Couldn't write to the transcript: ${wrote.stderr.trim()}`
}

// Resumes a session, so the conversation reads from where it was pointed.
// Resolves whether the resume took, and what `/resume` said.
async function resume($: EngineInterface, sessionId: string): Promise<{ isResumed: boolean; said: string }> {
  const before = resumes
  const resumed = await $.command
    .run({ command: 'resume', args: sessionId })
    .catch((error: unknown) => ({ text: String(error) }))

  return { isResumed: resumes !== before, said: resumed.text?.trim() ?? '' }
}

// Points this session at the end of the prompt's turn, so the next turn grows
// from there; every branch stays in the transcript.
async function switchTo($: EngineInterface, id: string) {
  const turn = turns.get(id)
  const path = await transcriptPath($)
  if (turn === undefined || turn.end === '' || path === undefined) {
    $.ui.toast("Couldn't find that branch in the transcript.")

    return
  }

  await update($, opened, () => '')
  const depth = (await read($, tree)).find(one => one.id === id)?.depth
  const sessionId = await $.session.id()
  const unwritten = await pointAt($, path, sessionId, turn.end, turn.text)
  if (unwritten !== undefined) {
    $.ui.toast(unwritten)

    return
  }
  const { isResumed, said } = await resume($, sessionId)
  if (isResumed) {
    $.ui.toast(`Back at turn ${depth ?? '?'}, “${cut(turn.text, 40)}”: your next prompt continues from there.`)

    return
  }

  // The record stands, so the next resume opens the branch, as long as no
  // turn is taken here first.
  const command = `claude --resume ${sessionId}`
  const isCopied = (await $.ui.copy({ text: command }).catch(() => ({ isCopied: false }))).isCopied
  $.ui.toast(
    `${said ? `${said} ` : ''}Branch saved: quit, then run ${command}${isCopied ? ' (copied)' : ''}.`,
  )
}

// The transcripts, in any project, of the sessions whose id starts with
// `prefix`.
async function sessionFiles($: EngineInterface, prefix: string): Promise<string[]> {
  const config = await configDir($)
  const projects = `${config}/projects`
  if (!config || !(await $.fs.exists(projects))) return []

  const found: string[] = []
  for (const dir of await $.fs.list(projects)) {
    if (dir.kind !== 'dir') continue
    for (const file of await $.fs.list(`${projects}/${dir.name}`)) {
      if (file.kind === 'file' && file.name.startsWith(prefix) && file.name.endsWith('.jsonl')) {
        found.push(`${projects}/${dir.name}/${file.name}`)
      }
    }
  }

  return found
}

// A Claude Code process that has the session open. Each process keeps a
// record under sessions/ and leaves it behind when it exits, so only a record
// whose process still runs counts.
async function openElsewhere(
  $: EngineInterface,
  sessionId: string,
): Promise<{ pid: number; jobId?: string } | undefined> {
  const config = await configDir($)
  if (!config) return undefined

  const found = await $.process.run(['grep', '-l', '-r', '-F', `"sessionId":"${sessionId}"`, `${config}/sessions`])
  for (const file of found.stdout.split('\n').filter(line => line.endsWith('.json'))) {
    const record = await $.fs.read(file).then(
      text => JSON.parse(text),
      () => undefined,
    )
    if (typeof record?.pid !== 'number') continue
    if ((await $.process.run(['kill', '-0', String(record.pid)])).exitCode !== 0) continue

    return { pid: record.pid, jobId: typeof record.jobId === 'string' ? record.jobId : undefined }
  }

  return undefined
}

// The prompt whose turn ends at the message, one line of it, or ''.
async function promptEndingAt($: EngineInterface, path: string, leaf: string): Promise<string> {
  const scan = await $.process.run(['awk', TREE_SCAN, path])
  for (const record of scan.stdout.split('\n')) {
    const [kind, , , , end = '', , , , , text = ''] = record.split('\t')
    if (kind === 'T' && end === leaf) return preview(decode(text))
  }

  return ''
}

// `/resume-at`: opens a session at one of its messages. The session itself is
// pointed at the message, as a switch in the tree does. A session open in
// another Claude Code window is never written to: its whole transcript, every
// branch, is copied into a new session pointed at the message, and the copy is
// opened; `--copy` asks for that always.
async function resumeAt($: EngineInterface, args: string): Promise<{ text?: string }> {
  const words = args.trim().split(/\s+/).filter(word => word !== '')
  const isCopy = words[0] === '--copy'
  const target = words[isCopy ? 1 : 0]
  if (target === undefined || words.length !== (isCopy ? 2 : 1)) return { text: RESUME_AT_USAGE }
  const [sessionPrefix, messagePrefix] = target.includes(':') ? target.split(':', 2) : ['', target]
  if (!/^[0-9a-z-]*$/i.test(sessionPrefix!) || !/^[0-9a-f-]+$/i.test(messagePrefix!)) {
    return { text: RESUME_AT_USAGE }
  }

  const current = await $.session.id()
  const isCurrent = sessionPrefix === '' || current.startsWith(sessionPrefix!.toLowerCase())
  const here = isCurrent ? await transcriptPath($) : undefined
  const paths = isCurrent ? (here === undefined ? [] : [here]) : await sessionFiles($, sessionPrefix!.toLowerCase())
  if (paths.length !== 1) {
    return {
      text:
        paths.length === 0
          ? `No session's id starts with ${sessionPrefix}.`
          : `${paths.length} sessions' ids start with ${sessionPrefix}: give more of the id.`,
    }
  }
  const path = paths[0]!
  const sessionId = path.slice(path.lastIndexOf('/') + 1, -'.jsonl'.length)

  const prefix = messagePrefix!.toLowerCase()
  const found = await $.process.run(['grep', '-o', '-E', `"uuid":"${prefix}[0-9a-f-]*"`, path])
  const leaves = [...new Set(found.stdout.split('\n').filter(match => match !== '').map(match => match.slice(8, -1)))]
  if (leaves.length !== 1) {
    return {
      text:
        leaves.length === 0
          ? `No message in session ${sessionId} has an id starting with ${messagePrefix}.`
          : `${leaves.length} messages in session ${sessionId} have ids starting with ${messagePrefix}: give more of the id.`,
    }
  }
  const leaf = leaves[0]!
  const lastPrompt = await promptEndingAt($, path, leaf)

  const holder = isCurrent ? undefined : await openElsewhere($, sessionId)
  let opening = { path, sessionId }
  if (isCopy || holder !== undefined) {
    const copyId = crypto.randomUUID()
    const copyPath = `${path.slice(0, path.lastIndexOf('/'))}/${copyId}.jsonl`
    const copied = await $.process.run([
      'awk',
      '-v',
      `from="sessionId":"${sessionId}"`,
      '-v',
      `to="sessionId":"${copyId}"`,
      '-v',
      `dst=${copyPath}`,
      COPY_SCAN,
      path,
    ])
    if (copied.exitCode !== 0) return { text: `Couldn't copy session ${sessionId}: ${copied.stderr.trim()}` }
    opening = { path: copyPath, sessionId: copyId }
  }

  const unwritten = await pointAt($, opening.path, opening.sessionId, leaf, lastPrompt)
  if (unwritten !== undefined) return { text: unwritten }

  // A command cannot run another while it answers: `/resume` runs once this
  // one has.
  $.clock.after(0, () => void openPointed($, opening.sessionId, sessionId, holder).catch(() => undefined))

  return {
    text: `Opening session ${opening.sessionId} at message ${leaf.slice(0, 8)}${opening.sessionId === sessionId ? '' : `, a copy of session ${sessionId}`}.`,
  }
}

// Resumes the session `/resume-at` pointed, and says how to open it if that
// did not take, or why it is a copy if it is one.
async function openPointed(
  $: EngineInterface,
  opening: string,
  sessionId: string,
  holder: { pid: number; jobId?: string } | undefined,
) {
  const { isResumed, said } = await resume($, opening)
  if (!isResumed) {
    $.ui.toast(
      `${said ? `${said} ` : ''}Session ${opening} is set to open at that message: run claude --resume ${opening} in its project folder.`,
    )
  } else if (holder !== undefined) {
    $.ui.toast(
      `Session ${sessionId} is open in another window, so this is a copy of it.${holder.jobId === undefined ? '' : ` To open it there: claude attach ${holder.jobId}`}`,
    )
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'timeline',
      description: 'Show or hide the pane of this session’s prompts',
    })
    await $.command.register({
      name: 'resume-at',
      description: 'Open a session at one of its messages, keeping every branch',
      argumentHint: '[--copy] <session-id>:<message-id>',
    })
    const started = await next(e)
    const isContextShown = (await $.store.get('showContext')) !== false
    await update($, showContext, () => isContextShown)
    // A reload starts with search closed: the field's closures and the corpus
    // went with the old module. The turns went too: the tree is read again.
    await closeSearch($)
    void seed($).catch(() => undefined)
    const isTreeShown = (await $.store.get('isTree')) === true
    await update($, isTree, () => isTreeShown)
    await update($, opened, () => '')
    grownAt = -1
    if (isTreeShown) void grow($).catch(() => undefined)
    // The minute also reads in a rewind, which no hook here sees: it writes a
    // record the scan's size check notices.
    $.clock.every(60_000, () => {
      void update($, tick, n => n + 1)
      void regrow($)
    })
    if (e.isInteractive && (await $.store.get('isOpen')) !== false) void open($)

    return started
  })

  on('command.run', { command: 'resume-at' }, ($, e) => resumeAt($, e.args))

  on('command.run', { command: 'timeline' }, async $ => {
    const pane = (await $.ui.panes()).find(one => one.id === PANE)
    if (pane?.isShown) {
      await $.store.set('isOpen', false)
      await $.ui.close({ id: PANE })

      return { text: 'Timeline closed.' }
    }
    await open($)

    return { text: 'Timeline opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    if (e.origin.kind === 'person') await $.store.set('isOpen', false)

    return closed
  })

  // Keep the focus ring off the entries: the one clicked would stay inverted.
  // A click still presses the entry. The search field takes it, to be typed in.
  on('ui.focus', { requestId: PANE }, ($, e, next) => (e.element?.startsWith(SEARCH) ? next(e) : {}))

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const isPrompt =
      (e.door === 'prompt' || e.door === 'delivery') &&
      e.agentId === undefined &&
      e.message.type === 'user' &&
      !e.message.isMeta &&
      PERSON_KINDS.includes(e.origin.kind)
    if (!isPrompt || stored.deny !== undefined) return stored

    const text = textOf(stored.message.content)
    if (!isTyped(text)) return stored

    const whole = flatten(text)
    corpus.set(stored.uuid, whole)
    const entry = { id: stored.uuid, text: cut(whole, PREVIEW), at: await $.clock.now() }
    waiting = [...waiting, entry.id]
    await update($, entries, list => append(list, entry))
    prune(await read($, entries))
    // While searching, the field stays in view and the new prompt joins the
    // matches if it is one.
    if ((await read($, field)) !== '') await refind($)
    else void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
    // The tree is read from the transcript: once the prompt is written there.
    $.clock.after(1000, () => void regrow($))

    return stored
  })

  // A finished turn moved the conversation: the tree reads where it stands now.
  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId === undefined) void regrow($)

    return completed
  })

  // The context each live prompt was answered over, as the API reports it: the
  // usage of the first response on main whose request carried the prompt.
  on('turn.step', async function* ($, e, next) {
    const asked = e.agentId === undefined ? waiting : []
    const result = yield* next(e)
    const { usage } = result
    if (asked.length === 0 || usage === null) return result

    waiting = waiting.filter(id => !asked.includes(id))
    try {
      const { window } = (await $.session.usage()).context
      const tokens =
        usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
      if (window > 0) {
        const context = percentOf(tokens, window)
        await update($, entries, list =>
          list.map(entry => (asked.includes(entry.id) ? { ...entry, context } : entry)),
        )
      }
    } catch {
      // The response stands whatever the timeline makes of it.
    }

    return result
  })

  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason !== 'clear' && e.reason !== 'resume') return ended

    waiting = []
    corpus.clear()
    turns = new Map()
    grownAt = -1
    await update($, entries, () => [])
    await update($, picked, () => '')
    await update($, tree, () => [])
    await update($, opened, () => '')
    await closeSearch($)
    // A resumed session goes on under its own id: read its prompts once the
    // switch has settled.
    if (e.reason === 'resume') {
      resumes++
      $.clock.after(1000, () => {
        void seed($).catch(() => undefined)
        void regrow($)
      })
    }

    return ended
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Mobile draws no text field, so no search there.
    const Input = 'Input' in elements ? elements.Input : undefined
    const list = await read($, entries)
    const current = await read($, picked)
    const isContextShown = await read($, showContext)
    const fieldKey = await read($, field)
    const isSearchShown = fieldKey !== '' && Input !== undefined
    const results = await read($, found)
    const isTreeShown = await read($, isTree)
    const nodes = await read($, tree)
    const openedId = await read($, opened)
    await read($, tick)
    const now = await $.clock.now()
    const width = Math.max(12, e.props.bodyColumns - 1)
    // Each prompt's number, right-aligned, then its text and, flush right, its
    // context and age, each column a fixed width so they line up down the list.
    const digits = String(list.length).length
    const right = AGE_COLUMNS + (isContextShown ? CONTEXT_COLUMNS + 2 : 0)
    const room = width - digits - 2 - right - 2
    const isFiltered = isSearchShown && results.query !== ''

    // The tree counts the turns to where the conversation stands, and the
    // branches beside them: one for each fork.
    const here = nodes.find(node => node.place === 'here')
    const forks = nodes.filter(node => node.above.at(-1)?.text === '─╮').length
    // As the dock narrows the title gives way first, then the count.
    const count =
      isTreeShown && here !== undefined
        ? `${here.depth} turn${here.depth === 1 ? '' : 's'} · ${forks} branch${forks === 1 ? '' : 'es'}`
        : isFiltered
          ? `${results.total} of ${list.length}`
          : `${list.length} prompt${list.length === 1 ? '' : 's'}`
    const controls = SWITCH_COLUMNS + FIND_COLUMNS + (isTreeShown ? 0 : CONTEXT_TOGGLE_COLUMNS)
    const isNamed = width >= TITLE_COLUMNS + controls + 2 + count.length
    const isCounted = width >= (isNamed ? TITLE_COLUMNS : 1) + controls + 2 + count.length
    // The list and the tree, side by side: the one shown filled in the accent,
    // the other on the theme's shade, so the pair reads as one switch.
    const view = (name: 'list' | 'tree', key: string) => {
      const isOn = (name === 'tree') === isTreeShown

      return (
        <Button key={key} plain onPress={() => (isOn ? undefined : toggleTree($))}>
          <Text
            {...(isOn
              ? { backgroundColor: ACCENT, color: 'inverseText', bold: true }
              : { backgroundColor: HIGHLIGHT, dimColor: true })}
          >{` ${name} `}</Text>
        </Button>
      )
    }
    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Box justifyContent="space-between" height={1} overflow="hidden">
          <Box>
            <Text color={ACCENT}>{isNamed ? '◆ ' : '◆'}</Text>
            {isNamed && <Text bold>Timeline</Text>}
            <Text>{'  '}</Text>
            {view('list', 'list-view')}
            {view('tree', 'tree-toggle')}
            {!isTreeShown && <Text>{'  '}</Text>}
            {!isTreeShown && (
              <Button key="context" plain onPress={() => toggleContext($)}>
                <Text color={isContextShown ? ACCENT : undefined} dimColor={!isContextShown}>
                  {isContextShown ? '● ctx' : '○ ctx'}
                </Text>
              </Button>
            )}
            {Input !== undefined && <Text>{'  '}</Text>}
            {Input !== undefined && (
              <Button key="search-toggle" plain onPress={() => toggleSearch($)}>
                <Text color={isSearchShown ? ACCENT : undefined} dimColor={!isSearchShown}>
                  {isSearchShown ? '● find' : '○ find'}
                </Text>
              </Button>
            )}
          </Box>
          {isCounted && <Text dimColor>{count}</Text>}
        </Box>
        {isSearchShown && (
          <Input
            key={fieldKey}
            placeholder="search every prompt"
            submitLabel="search"
            autoFocus
            onInput={value => typed($, value)}
            onSubmit={value => typed($, value, true)}
          />
        )}
        <Text dimColor wrap="truncate">
          {'─'.repeat(width)}
        </Text>
      </Box>
    )
    const note = (title: string, body: string) => (
      <Box flexDirection="column" paddingLeft={1}>
        {header}
        <Text dimColor>○  {title}</Text>
        <Text dimColor>{'   '}{body}</Text>
      </Box>
    )

    if (e.props.view.agentId !== undefined) {
      return note("An agent's transcript", 'Switch back to the main one to jump.')
    }

    if (isTreeShown) {
      if (nodes.length === 0) return note('No prompts yet', 'Send one and it lands here.')
      // A press on a prompt names its Button; on a card's button, the button's.
      const pressTree = (pressed: UiPressArgument) => {
        const key = pressed.element
        if (key.startsWith(SWITCH)) return switchTo($, key.slice(SWITCH.length))
        if (key.startsWith(COPY)) return copyResume($, key.slice(COPY.length))
        if (key === COPY_HERE) return here === undefined ? undefined : copyResume($, here.id)

        return pick($, key)
      }

      const lines = (cells: TreeLine[]) =>
        cells.map(cell => <Text color={toneColor(cell.tone)}>{cell.text}</Text>)
      // Beside an opened card the lines carry on as they do into the row
      // below, a fork there not yet begun.
      const through = (cells: TreeLine[]) =>
        cells.map(cell => (cell.text === '├' ? { ...cell, text: '│' } : cell.text === '─╮' ? { ...cell, text: '  ' } : cell))
      const columns = (cells: TreeLine[]) => cells.reduce((sum, cell) => sum + cell.text.length, 0)

      // A card under a prompt: on a branch the conversation left, its last
      // reply and the switch to it; on the conversation, the command alone, as
      // the transcript shows the reply. Each row keeps the lines beside it.
      const card = (node: TreeNode, below: TreeNode | undefined) => {
        const turn = turns.get(node.id)
        const side = through(below?.above ?? [])
        const indent = columns(node.cells) + String(node.depth).length + 2
        const pad = ' '.repeat(Math.max(0, indent - columns(side)))
        const isOff = node.place === 'off'
        const said = isOff ? wrap(turn?.reply || 'No reply in the transcript.', Math.max(12, width - indent - 2), REPLY_LINES) : []
        const row = (content: RenderChildren) => (
          <Box height={1} overflow="hidden">
            {lines(side)}
            <Text>{pad}</Text>
            <Box flexGrow={1} backgroundColor={HIGHLIGHT} paddingX={1}>
              {content}
            </Box>
          </Box>
        )

        // The switch is a pill in the branch's colour; the copy sits beside it
        // where the card has room for both, under it where it has not.
        const end = turn?.end ?? ''
        const copy = `⧉ copy /resume-at …:${end.slice(0, 8)}`
        const resume = (
          <Button key={`${SWITCH}${node.id}`} plain onPress={pressTree}>
            <Text backgroundColor={toneColor(node.tone)} color="inverseText" bold>
              {CONTINUE}
            </Text>
          </Button>
        )
        const copier = (
          <Button key={`${COPY}${node.id}`} plain onPress={pressTree}>
            <Text color="suggestion">{copy}</Text>
          </Button>
        )
        const isSideBySide = width - indent - 2 >= CONTINUE.length + 3 + copy.length

        return [
          ...said.map(line => row(<Text dimColor italic>{line}</Text>)),
          isOff && end !== '' && isSideBySide && row([resume, <Text>{'   '}</Text>, copier]),
          isOff && !(end !== '' && isSideBySide) && row(resume),
          end !== '' && !(isOff && isSideBySide) && row(copier),
        ]
      }

      // Where the conversation stands: on the line the tree starts down, or on
      // a branch it took at a turn.
      const left = nodes.find(node => node.place !== 'off' && node.lane > 0)
      const where = left === undefined ? 'on the main line' : `on a branch from turn ${left.depth - 1}`
      const context = await $.session
        .usage()
        .then(usage => usage.context.percent)
        .catch(() => undefined)

      return (
        <Box flexDirection="column" paddingLeft={1}>
          {header}
          {nodes.map((node, index) => {
            const isOff = node.place === 'off'
            const isHere = node.place === 'here'
            // What the turn did, and when it was asked, give way to the
            // prompt where a deep branch leaves little room.
            const space = width - columns(node.cells) - String(node.depth).length - 2
            const isTimed = space - AT_COLUMNS - 2 >= 12
            const isTold = isTimed && space - AT_COLUMNS - OUTCOME_COLUMNS - 4 >= 12
            const room = space - (isTimed ? AT_COLUMNS + 2 : 0) - (isTold ? OUTCOME_COLUMNS + 2 : 0)
            const kind = node.outcome.kind

            return (
              <Box flexDirection="column">
                {/* Between two prompts, a row of the lines running on. */}
                {index > 0 && <Box height={1}>{node.above.length > 0 ? lines(node.above) : <Text> </Text>}</Box>}
                <Box
                  justifyContent="space-between"
                  height={1}
                  overflow="hidden"
                  backgroundColor={isHere ? HIGHLIGHT : undefined}
                >
                  <Button key={node.id} plain onPress={pressTree}>
                    {lines(node.cells)}
                    <Text
                      {...(isHere ? { bold: true } : isOff ? { color: toneColor(node.tone) } : { dimColor: true })}
                    >{` ${node.depth} `}</Text>
                    <Text bold={isHere}>{cut(node.text, room)}</Text>
                  </Button>
                  <Box>
                    {isTold && (
                      <Text
                        {...(node.chip !== undefined
                          ? { color: toneColor(node.tone) }
                          : kind === 'push' || kind === 'commit'
                            ? { color: 'warning' }
                            : kind === 'files'
                              ? { color: 'success' }
                              : kind === 'tool'
                                ? { color: 'suggestion' }
                                : { dimColor: true })}
                      >
                        {`  ${cut(node.chip ?? node.outcome.label, OUTCOME_COLUMNS).padStart(OUTCOME_COLUMNS)}`}
                      </Text>
                    )}
                    {isTimed &&
                      (isHere ? (
                        <Text color={ACCENT} bold>{`  ${'◂ here'.padStart(AT_COLUMNS)}`}</Text>
                      ) : (
                        <Text dimColor>{`  ${sentAt(node.at, now).padStart(AT_COLUMNS)}`}</Text>
                      ))}
                  </Box>
                </Box>
                {node.id === openedId && card(node, nodes[index + 1])}
              </Box>
            )
          })}
          {here !== undefined && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor wrap="truncate">
                {'─'.repeat(width)}
              </Text>
              <Box justifyContent="space-between" height={1} overflow="hidden">
                <Text wrap="truncate">
                  <Text color={ACCENT}>◉</Text>
                  <Text dimColor>{` turn ${here.depth} · ${where}${context === undefined ? '' : ` · ${context}% ctx`}`}</Text>
                </Text>
                <Button key={COPY_HERE} plain onPress={pressTree}>
                  <Text color="suggestion">⧉ copy /resume-at</Text>
                </Button>
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    if (list.length === 0) return note('No prompts yet', 'Send one and it lands here.')
    if (isFiltered && results.total === 0) {
      return note('No prompt holds that', 'Fewer or shorter words find more.')
    }

    // One handler for every entry: a press names its Button by key.
    const press = (pressed: UiPressArgument) => jump($, pressed.element)

    // One row, clipped: while the person drags the dock narrower, the tree
    // drawn for the old width is not redrawn until the drag settles.
    const row = (entry: TimelineEntry, number: number, isLast: boolean, hit?: SearchHit) => {
      const isPicked = entry.id === current
      const context = entry.context === undefined ? '' : `${entry.context}%`
      const [before, match, after] = hit === undefined ? [] : fit(hit, room)

      return (
        <Box justifyContent="space-between" height={1} overflow="hidden" marginBottom={isLast ? 0 : 1}>
          <Button key={entry.id} plain onPress={press}>
            <Text color={isPicked ? ACCENT : undefined} dimColor={!isPicked}>
              {String(number).padStart(digits)}{'  '}
            </Text>
            {hit === undefined ? (
              <Text color={isPicked ? ACCENT : undefined} bold={isPicked}>
                {cut(entry.text, room)}
              </Text>
            ) : (
              [
                before !== '' && <Text color={isPicked ? ACCENT : undefined}>{before}</Text>,
                <Text color={MATCH} bold>{match}</Text>,
                after !== '' && <Text color={isPicked ? ACCENT : undefined}>{after}</Text>,
              ]
            )}
          </Button>
          <Box>
            {isContextShown && (
              <Text {...contextTone(entry.context)}>{context.padStart(CONTEXT_COLUMNS)}</Text>
            )}
            <Text dimColor wrap="truncate">
              {`${isContextShown ? '  ' : ''}${age(entry.at, now).padStart(AGE_COLUMNS)}`}
            </Text>
          </Box>
        </Box>
      )
    }

    if (isFiltered) {
      // Matches newest first under the field, each by its place in the timeline.
      const place = new Map(list.map((entry, index) => [entry.id, index]))
      const shown = results.hits.filter(hit => place.has(hit.id))
      const more = results.total - shown.length

      return (
        <Box flexDirection="column" paddingLeft={1}>
          {header}
          {shown.map((hit, index) => {
            const at = place.get(hit.id)!

            return row(list[at]!, at + 1, index === shown.length - 1 && more <= 0, hit)
          })}
          {more > 0 && (
            <Text dimColor>{`   ${more} older match${more === 1 ? '' : 'es'}: add a word to narrow`}</Text>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingLeft={1}>
        {header}
        {list.map((entry, index) => row(entry, index + 1, index === list.length - 1))}
      </Box>
    )
  })
}
