import { atom, memberOf, read, update } from 'claude-code'
import type { CodeProps, EngineInterface, Register, SessionMessage } from 'claude-code'

import type { CardState, FileCall, RunState, TurnTime } from '../types'

// Colours chosen in the Transcript Line Tints mockup
const TOOL_SUMMARY = '#6272a4'
const TIMING = '#ffb86c'
const CODE_TEXT = '#ec7e7e'
const CODE_BG = '#363848'
const CARD_BG = '#303241'
const CARD_NAME = '#ff79c6'
const CARD_ARGS = '#6272a4'

// Heading colours chosen in the Transcript Heading Styles mockup
const HEADING_1 = '#ff79c6'
const HEADING_2 = '#bd93f9'
const HEADING_REST = '#f8f8f2'
const HEADING_MARK = '#6272a4'

// Emphasis colours chosen in the Transcript Emphasis Styles mockup; bold italic takes the bold colour
const BOLD = '#ffb86c'
const ITALIC = '#f1fa8c'

// The faint frame around each turn's final reply: Dracula's selection colour
const FRAME = '#44475a'

// Text between a prompt and the turn's final reply is drawn halfway from its colour to
// Dracula's background, so it keeps its hue
const BACKGROUND = '#282a36'
const FOREGROUND = '#f8f8f2'
// Dracula's red and orange stand in for the theme's error and warning colours, which a
// theme key cannot be dimmed from
const ERROR = '#ff5555'
const WARNING = '#ffb86c'

const MAX_OUTPUT_LINES = 400
// Cards opened from a summary line sit this far in, two columns past the summary's own text
const NESTED_INDENT = 4

const cardState = atom({ plugin: 'dracula-theme-mod', key: 'cardState' } as const, 'auto' as CardState)
const turnTimes = atom({ plugin: 'dracula-theme-mod', key: 'turnTimes' } as const, [] as TurnTime[])
// The tool calls of the main turn that is still running
const liveCalls = atom({ plugin: 'dracula-theme-mod', key: 'liveCalls' } as const, [] as string[])

// Back-to-back file changes of finished turns, each run folded into one line
const fileRuns = atom({ plugin: 'dracula-theme-mod', key: 'fileRuns' } as const, [] as FileCall[][])
const runState = atom({ plugin: 'dracula-theme-mod', key: 'runState' } as const, 'folded' as RunState)
// Finished tool groups the person opened from their summary line
const groupState = atom({ plugin: 'dracula-theme-mod', key: 'groupState' } as const, 'folded' as RunState)
// Each turn's final reply, by replyKey, so its block is drawn in a frame
const finalReplies = atom({ plugin: 'dracula-theme-mod', key: 'finalReplies' } as const, [] as string[])

// File changes never join a tool summary, so once their turn ends they fold into a line of their own
const FILE_VERBS: Record<string, string> = { Edit: 'Edited', Write: 'Wrote', NotebookEdit: 'Edited' }

function basename(path: string) {
  return path.split('/').pop() ?? path
}

// A run ends at anything the transcript shows between two file changes: text, a prompt,
// another tool's row, or a failed change, which keeps its own card
function findFileRuns(messages: ReadonlyArray<SessionMessage>) {
  const runs: FileCall[][] = []
  let run: FileCall[] = []
  const close = () => {
    if (run.length > 1) runs.push(run)
    run = []
  }

  for (const message of messages) {
    if (message.role === 'user') {
      if ((message.toolResults ?? []).length === 0 && message.text.trim() !== '') close()
      continue
    }
    if (message.text.trim() !== '') close()
    for (const use of message.toolUses) {
      const verb = FILE_VERBS[use.tool]
      const file = use.input.file_path ?? use.input.notebook_path
      if (verb !== undefined && typeof file === 'string' && use.isError !== true) {
        run.push({ id: use.tool_use_id, verb, file: basename(file) })
      } else {
        close()
      }
    }
  }
  close()

  return runs
}

// "Edited index.d.ts, register.tsx (6 changes)"
function describeRun(calls: ReadonlyArray<FileCall>) {
  const byVerb = new Map<string, string[]>()
  for (const call of calls) byVerb.set(call.verb, [...(byVerb.get(call.verb) ?? []), call.file])

  return [...byVerb]
    .map(([verb, files], index) => {
      const names = [...new Set(files)]
      const what = names.length <= 3 ? names.join(', ') : `${names.length} files`
      const repeats = files.length > names.length ? ` (${files.length} changes)` : ''
      return `${index === 0 ? verb : verb.toLowerCase()} ${what}${repeats}`
    })
    .join(', ')
}

async function refreshFileRuns($: EngineInterface) {
  const messages = await $.session.messages()
  await update($, fileRuns, () => findFileRuns(messages))
  return messages
}

// A reply is known by its length and an FNV-1a hash of its text, so the list stays small
function replyKey(text: string) {
  const trimmed = text.trim()
  let hash = 0x811c9dc5
  for (let i = 0; i < trimmed.length; i++) hash = Math.imul(hash ^ trimmed.charCodeAt(i), 0x01000193)
  return `${trimmed.length}:${(hash >>> 0).toString(36)}`
}

// A turn's final reply is text with no tool call after it: the transcript ends there,
// or the next thing is the person's prompt
function findFinalReplies(messages: ReadonlyArray<SessionMessage>) {
  return messages
    .filter((message, index) => {
      const after = messages[index + 1]
      const endsTurn = after === undefined || (after.role === 'user' && (after.toolResults ?? []).length === 0)
      return message.role === 'assistant' && message.toolUses.length === 0 && message.text.trim() !== '' && endsTurn
    })
    .map(message => replyKey(message.text))
    .slice(-500)
}

type Span = {
  text: string
  code?: boolean
  bold?: boolean
  italic?: boolean
  strike?: boolean
  href?: string
}

type Block =
  | { kind: 'markdown'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'table'; source: string; align: Align[]; rows: Span[][][] }

type ListItem = { depth: number; marker: string; text: string }
type Align = 'left' | 'center' | 'right'

const FENCE = /^\s*(```|~~~)/
const HEADING = /^(#{1,6})\s+(.*)$/
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const TABLE = /^\s*\|/
const QUOTE = /^\s*>/
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
// Characters a terminal draws two cells wide (CJK, emoji) or none (combining marks, joiners),
// which the mod cannot line up in a table
const UNEVEN =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}\u200b-\u200f\ufe0f]|\p{Emoji_Presentation}|\p{Mn}/u
const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*\*(?!\s)([\s\S]+?)\*\*\*|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(?<![\w])_(?!\s)([^_\n]+?)_(?![\w])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\\([\\`*_{}[\]()#+\-.!|~<>])/g

function dimmed(color: string) {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16)
  const mixed = [1, 3, 5].map(at => Math.round((channel(color, at) + channel(BACKGROUND, at)) / 2))
  return `#${mixed.map(value => value.toString(16).padStart(2, '0')).join('')}`
}

function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function formatClock(ms: number) {
  const date = new Date(ms)
  const hours = date.getHours()
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

function summarize(calls: ReadonlyArray<{ tool: string }>) {
  const counts = { search: 0, read: 0, list: 0, shell: 0, edit: 0, write: 0 }
  // Any other tool is named, so "Used Artifact" says which one ran
  const others = new Map<string, number>()
  for (const call of calls) {
    if (call.tool === 'Grep' || call.tool === 'Glob') counts.search++
    else if (call.tool === 'Read') counts.read++
    else if (call.tool === 'LS') counts.list++
    else if (call.tool === 'Bash' || call.tool === 'PowerShell') counts.shell++
    else if (call.tool === 'Edit' || call.tool === 'NotebookEdit') counts.edit++
    else if (call.tool === 'Write') counts.write++
    else others.set(displayName(call.tool), (others.get(displayName(call.tool)) ?? 0) + 1)
  }
  const parts = [
    counts.search > 0 && `searched for ${plural(counts.search, 'pattern', 'patterns')}`,
    counts.read > 0 && `read ${plural(counts.read, 'file', 'files')}`,
    counts.list > 0 && `listed ${plural(counts.list, 'directory', 'directories')}`,
    counts.shell > 0 && `ran ${plural(counts.shell, 'shell command', 'shell commands')}`,
    counts.edit > 0 && `edited ${plural(counts.edit, 'file', 'files')}`,
    counts.write > 0 && `wrote ${plural(counts.write, 'file', 'files')}`,
    ...[...others].map(([name, count]) => `used ${name}${count > 1 ? ` ${count} times` : ''}`),
  ].filter((part): part is string => typeof part === 'string')
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function displayName(tool: string) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  return mcp ? `${mcp[1]} ${mcp[2]}` : tool
}

// The card's first line: the input that says what the call did
function describeInput(tool: string, input: unknown) {
  const fields = (input ?? {}) as Record<string, unknown>
  const field = (name: string) => (typeof fields[name] === 'string' ? (fields[name] as string) : undefined)
  const joined = (...values: Array<string | undefined>) => values.filter(Boolean).join(' ')

  let text: string
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      text = field('command') ?? ''
      break
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      text = field('file_path') ?? field('notebook_path') ?? ''
      break
    case 'Grep':
      text = joined(field('pattern'), field('path'), field('glob'))
      break
    case 'Glob':
      text = joined(field('pattern'), field('path'))
      break
    case 'WebFetch':
      text = field('url') ?? ''
      break
    case 'WebSearch':
      text = field('query') ?? ''
      break
    case 'Agent':
    case 'Task':
      text = field('description') ?? ''
      break
    default:
      text = Object.values(fields)
        .filter((value): value is string => typeof value === 'string' && value.length < 300)
        .slice(0, 2)
        .join(' ')
  }

  const lines = text.split('\n')
  return { first: lines[0] ?? '', more: lines.length - 1 }
}

// A card nobody has clicked is open only when its call failed
function isCardOpen(saved: CardState, isErrored: boolean) {
  return saved === 'auto' ? isErrored : saved === 'open'
}

function toggled(current: CardState, isErrored: boolean): CardState {
  return isCardOpen(current, isErrored) ? 'closed' : 'open'
}

function cap(text: string) {
  const lines = text.replace(/\s+$/, '').split('\n')
  return { text: lines.slice(0, MAX_OUTPUT_LINES).join('\n'), more: Math.max(0, lines.length - MAX_OUTPUT_LINES) }
}

function shellOutput(output: unknown) {
  if (output === null || typeof output !== 'object') return undefined
  const { stdout, stderr } = output as { stdout?: unknown; stderr?: unknown }
  if (typeof stdout !== 'string' && typeof stderr !== 'string') return undefined
  return [stdout, stderr].filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n')
}

// The readable text of a result: a string, its text blocks, or its plain fields as "name: value" lines
function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.map(outputText).filter(text => text !== '').join('\n')
  if (output === null || typeof output !== 'object') return output === undefined ? '' : String(output)

  const fields = output as Record<string, unknown>
  for (const name of ['text', 'content', 'message', 'result', 'output']) {
    const value = fields[name]
    const text = typeof value === 'string' || Array.isArray(value) ? outputText(value) : ''
    if (text.trim() !== '') return text
  }
  if (Array.isArray(fields.filenames)) return fields.filenames.join('\n')

  return Object.entries(fields)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join('\n')
}

type Patch = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

type Body =
  | { kind: 'text'; text: string; more: number; isError: boolean }
  | { kind: 'code'; props: CodeProps; more: number }

// What an opened card shows under its first line, read from the call's stored result.
// Whole hunks only, since a diff cut mid-hunk draws as plain text
function describeOutput(tool: string, output: unknown, isErrored: boolean): Body | undefined {
  if (output === undefined) return undefined
  const text = (value: string) => {
    const { text, more } = cap(value)
    return { kind: 'text' as const, text: text.trim() === '' ? '(No output)' : text, more, isError: isErrored }
  }
  if (isErrored) return text(outputText(output))

  const shell = tool === 'Bash' || tool === 'PowerShell' ? shellOutput(output) : undefined
  if (shell !== undefined) return text(shell)

  const fields = (output ?? {}) as Record<string, unknown>
  const patches = Array.isArray(fields.structuredPatch) ? (fields.structuredPatch as Patch[]) : []
  if (patches.length > 0) {
    const hunks: string[] = []
    let lines = 0
    for (const patch of patches) {
      if (hunks.length > 0 && lines + patch.lines.length > MAX_OUTPUT_LINES) break
      hunks.push(`@@ -${patch.oldStart},${patch.oldLines} +${patch.newStart},${patch.newLines} @@\n${patch.lines.join('\n')}`)
      lines += patch.lines.length
    }
    const left = patches.slice(hunks.length).reduce((sum, patch) => sum + patch.lines.length, 0)
    return { kind: 'code', props: { source: hunks.join('\n'), format: 'diff' }, more: left }
  }

  const file = (fields.file ?? {}) as Record<string, unknown>
  const path = typeof fields.filePath === 'string' ? fields.filePath : typeof file.filePath === 'string' ? file.filePath : ''
  const content = typeof fields.content === 'string' ? fields.content : typeof file.content === 'string' ? file.content : undefined
  if (content !== undefined && path !== '') {
    const { text, more } = cap(content)
    const startLine = typeof file.startLine === 'number' ? file.startLine : 1
    return { kind: 'code', props: { source: text, path, startLine }, more }
  }

  return text(outputText(output))
}

function isPlain(span: Span) {
  return !span.code && !span.bold && !span.italic && !span.strike && !span.href
}

function parseInline(text: string): Span[] {
  const spans: Span[] = []
  // Plain text next to plain text (around an escape, say) joins into one span
  const push = (span: Span) => {
    const previous = spans[spans.length - 1]
    if (previous && isPlain(previous) && isPlain(span)) previous.text += span.text
    else spans.push(span)
  }
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0
    if (index > last) push({ text: text.slice(last, index) })
    const [, ticks, code, linkText, linkHref, boldItalic, bold1, bold2, strike, italic1, italic2, url, escaped] = match
    if (ticks !== undefined && code !== undefined) {
      spans.push({ text: /^ .* $/.test(code) ? code.slice(1, -1) : code, code: true })
    } else if (linkText !== undefined && linkHref !== undefined) {
      spans.push({ text: linkText, href: linkHref })
    } else if (boldItalic !== undefined) {
      spans.push(...parseInline(boldItalic).map(span => ({ ...span, bold: true, italic: true })))
    } else if (bold1 !== undefined || bold2 !== undefined) {
      spans.push(...parseInline(bold1 ?? bold2 ?? '').map(span => ({ ...span, bold: true })))
    } else if (strike !== undefined) {
      spans.push(...parseInline(strike).map(span => ({ ...span, strike: true })))
    } else if (italic1 !== undefined || italic2 !== undefined) {
      spans.push(...parseInline(italic1 ?? italic2 ?? '').map(span => ({ ...span, italic: true })))
    } else if (url !== undefined) {
      spans.push({ text: url, href: url })
    } else if (escaped !== undefined) {
      push({ text: escaped })
    }
    last = index + match[0].length
  }
  if (last < text.length) push({ text: text.slice(last) })
  return spans
}

// Cells split on pipes outside code spans; `\|` is a pipe inside a cell
function splitRow(line: string) {
  const row = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cell = ''
  let inCode = false
  for (let i = 0; i < row.length; i++) {
    const char = row[i] ?? ''
    if (char === '\\' && row[i + 1] === '|') {
      cell += '|'
      i++
      continue
    }
    if (char === '`') inCode = !inCode
    if (char === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += char
  }
  cells.push(cell.trim())
  return cells
}

// A table the mod can draw cell by cell; any other is left to the engine's Markdown
function tableBlock(lines: string[]): Block {
  const source = lines.join('\n')
  const [header, rule, ...body] = lines
  if (header === undefined || rule === undefined || !TABLE_RULE.test(rule)) return { kind: 'markdown', text: source }
  const align = splitRow(rule).map((cell): Align => (cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : 'left'))
  const cells = [header, ...body].map(splitRow)
  if (cells.some(row => row.some(cell => UNEVEN.test(cell)))) return { kind: 'markdown', text: source }
  return { kind: 'table', source, align, rows: cells.map(row => align.map((_, column) => parseInline(row[column] ?? ''))) }
}

function spansWidth(spans: Span[]) {
  return spans.reduce((sum, span) => sum + span.text.length + (span.code ? 2 : 0), 0)
}

// The widest piece a cell holds that wrapping cannot break without cutting it: a pill or a word
function longestPiece(spans: Span[]) {
  return spans.reduce(
    (widest, span) => Math.max(widest, span.code ? span.text.length + 2 : Math.max(0, ...span.text.split(' ').map(word => word.length))),
    0,
  )
}

// Column widths for the room a table has. When the natural widths do not fit, each
// column keeps its longest piece (or a fair share of the room, if that is narrower) and
// the rest of the room goes to the columns that want more, in proportion.
function fitWidths(natural: number[], longest: number[], room: number) {
  if (natural.reduce((sum, width) => sum + width, 0) <= room) return natural
  const fair = Math.floor(room / natural.length)
  const least = natural.map((width, column) => Math.min(width, Math.max(3, Math.min(longest[column] ?? width, fair))))
  const spare = room - least.reduce((sum, width) => sum + width, 0)
  const wanted = natural.reduce((sum, width, column) => sum + width - (least[column] ?? 0), 0)
  return least.map((width, column) => width + Math.floor((spare * ((natural[column] ?? 0) - width)) / Math.max(1, wanted)))
}

function sameStyle(a: Span, b: Span) {
  return !a.code && !b.code && a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.href === b.href
}

// A cell's text in lines no wider than its column. Words and pills stay whole unless one
// alone is wider than the column, and runs of one style stay one span.
function wrapSpans(spans: Span[], width: number) {
  const lines: Span[][] = [[]]
  let used = 0
  let spaceBefore = false
  const append = (piece: Span) => {
    const line = lines[lines.length - 1] ?? []
    const previous = line[line.length - 1]
    if (previous && sameStyle(previous, piece)) previous.text += piece.text
    else line.push(piece)
  }
  const place = (piece: Span, size: number) => {
    const gap = spaceBefore && used > 0 ? 1 : 0
    spaceBefore = false
    if (used > 0 && used + gap + size > width) {
      lines.push([])
      used = 0
    } else if (gap) {
      const line = lines[lines.length - 1] ?? []
      const previous = line[line.length - 1]
      append(previous && sameStyle(previous, piece) ? { ...piece, text: ' ' } : { text: ' ' })
      used += 1
    }
    append(piece)
    used += size
  }

  for (const span of spans) {
    if (span.code) {
      const cut = Math.max(1, width - 2)
      let text = span.text
      while (text.length > cut) {
        place({ ...span, text: text.slice(0, cut) }, cut + 2)
        text = text.slice(cut)
      }
      place({ ...span, text }, text.length + 2)
      continue
    }
    span.text.split(' ').forEach((word, index) => {
      if (index > 0) spaceBefore = true
      let rest = word
      while (rest.length > width) {
        place({ ...span, text: rest.slice(0, width) }, width)
        rest = rest.slice(width)
      }
      if (rest) place({ ...span, text: rest }, rest.length)
    })
  }
  return lines
}

function startsBlock(line: string) {
  return FENCE.test(line) || HEADING.test(line) || LIST_ITEM.test(line) || TABLE.test(line) || QUOTE.test(line) || RULE.test(line)
}

// Headings, paragraphs, lists and tables are drawn here, so headings get their level's
// colour, bold and italic theirs, and code its pill; code blocks, quotes and rules go to
// the engine's own Markdown element.
function splitBlocks(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let i = 0

  const take = (test: (line: string) => boolean) => {
    const start = i
    while (i < lines.length && test(lines[i] ?? '')) i++
    return lines.slice(start, i)
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i++
      continue
    }

    if (FENCE.test(line)) {
      const fence = line.trim().slice(0, 3)
      const start = i
      i++
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(fence)) i++
      i = Math.min(i + 1, lines.length)
      blocks.push({ kind: 'markdown', text: lines.slice(start, i).join('\n') })
      continue
    }

    if (RULE.test(line)) {
      i++
      blocks.push({ kind: 'markdown', text: line })
      continue
    }

    // A table needs its rule as the second line; the outer pipes are optional
    const second = lines[i + 1] ?? ''
    if (line.includes('|') && second.includes('|') && TABLE_RULE.test(second)) {
      blocks.push(tableBlock(take(next => next.includes('|') && next.trim() !== '')))
      continue
    }

    if (TABLE.test(line) || QUOTE.test(line)) {
      const pattern = TABLE.test(line) ? TABLE : QUOTE
      blocks.push({ kind: 'markdown', text: take(next => pattern.test(next)).join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      i++
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' })
      continue
    }

    if (LIST_ITEM.test(line)) {
      const items: ListItem[] = []
      while (i < lines.length) {
        const current = lines[i] ?? ''
        const item = LIST_ITEM.exec(current)
        if (item) {
          const indent = (item[1] ?? '').length
          items.push({ depth: Math.min(4, Math.floor(indent / 2)), marker: /^\d/.test(item[2] ?? '') ? item[2] ?? '' : '-', text: item[3] ?? '' })
        } else if (/^\s+\S/.test(current) && items.length > 0 && !FENCE.test(current)) {
          const previous = items[items.length - 1]
          if (previous) previous.text += ` ${current.trim()}`
        } else {
          break
        }
        i++
      }
      blocks.push({ kind: 'list', items })
      continue
    }

    const paragraph = [line]
    i++
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !startsBlock(lines[i] ?? '')) {
      paragraph.push(lines[i] ?? '')
      i++
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
  }

  return blocks
}

export const register: Register = on => {
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, liveCalls, () => [])

    return next(e)
  })

  // Only records the call; a failure here must never stop the tool
  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    if (e.agentId === undefined && id !== undefined) await update($, liveCalls, ids => [...ids, id].slice(-500))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A resumed session's earlier final replies get their frame too
    const messages = await refreshFileRuns($)
    await update($, finalReplies, () => findFinalReplies(messages))

    return started
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    const doneAt = await $.clock.now()
    await update($, turnTimes, list => [...list, { durationMs: e.durationMs, doneAt }].slice(-500))
    if (e.answer.trim() !== '') await update($, finalReplies, keys => [...keys, replyKey(e.answer)].slice(-500))
    const completed = await next(e)
    await refreshFileRuns($)
    await update($, liveCalls, () => [])

    return completed
  })

  // "✻ Cooked for 36s · done 1:14 PM" in dimmed orange
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const times = await read($, turnTimes)
    const match = times
      .filter(time => Math.abs(time.durationMs - e.props.durationMs) <= 1000)
      .sort((a, b) => Math.abs(a.durationMs - e.props.durationMs) - Math.abs(b.durationMs - e.props.durationMs))[0]
    const done = match ? ` · done ${formatClock(match.doneAt)}` : ''

    return (
      <Box flexDirection="row" marginTop={1}>
        <Box width={2}>
          <Text color={dimmed(TIMING)}>✻</Text>
        </Box>
        <Text color={dimmed(TIMING)}>{`${e.props.word} for ${formatDuration(e.props.durationMs)}${done}`}</Text>
      </Box>
    )
  })

  // A running group unfolds into one card per call; a finished one folds into an italic summary
  // that opens into its cards, set in under it. Tool rows always sit between a prompt and its
  // final reply, so every part of them is dimmed
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const expanded = { ...e, props: { ...e.props, isExpanded: true } }
    if (e.props.isActive) return next(expanded)

    const { Box, Text, Button } = $.ui.resolve(e)
    const state = memberOf(groupState, { requestId: e.props.calls[0]?.tool_use_id ?? e.requestId })
    // A fullscreen click on the row expands it too
    const isOpen = e.props.isExpanded || (await read($, state)) === 'open'
    const failed = e.props.calls.filter(call => call.isErrored).length

    const summary = (
      <Box paddingLeft={2}>
        <Button key="group" plain onPress={() => update($, state, current => (current === 'open' ? 'folded' : 'open'))}>
          <Text>
            <Text color={dimmed(TOOL_SUMMARY)} italic>
              {`${summarize(e.props.calls)}${isOpen ? ' ▾' : ''}`}
            </Text>
            {failed > 0 ? <Text color={dimmed(ERROR)} italic>{` · ${failed} failed`}</Text> : ''}
          </Text>
        </Button>
      </Box>
    )

    return (
      <Box flexDirection="column" marginTop={1}>
        {summary}
        {isOpen ? (
          <Box flexDirection="column" paddingLeft={NESTED_INDENT}>
            {await next(expanded)}
          </Box>
        ) : null}
      </Box>
    )
  })

  // Each tool call's first line as a card; a click on it shows or hides the result inside it
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)

    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const { tool_use_id: id, tool, input, output, isRunning, isErrored, isInterrupted } = e.props
    const state = memberOf(cardState, e)
    const isOpen = !isRunning && isCardOpen(await read($, state), isErrored)
    const { first, more } = describeInput(tool, input)
    const toggle = () => update($, state, current => toggled(current, isErrored))
    const cardBg = dimmed(CARD_BG)
    const muted = dimmed(CARD_ARGS)

    const head = [
      <Text weight="bold" color={dimmed(isErrored ? ERROR : CARD_NAME)} backgroundColor={cardBg}>
        {displayName(tool)}
      </Text>,
      first !== '' ? (
        <Text color={muted} backgroundColor={cardBg}>
          {` ${first}`}
        </Text>
      ) : null,
      more > 0 ? (
        <Text color={muted} backgroundColor={cardBg}>
          {` (+${more} lines)`}
        </Text>
      ) : null,
      isRunning ? (
        <Text color={dimmed(WARNING)} backgroundColor={cardBg}>
          {' •••'}
        </Text>
      ) : null,
      isInterrupted ? (
        <Text color={muted} backgroundColor={cardBg}>
          {' · interrupted'}
        </Text>
      ) : null,
    ].filter(part => part !== null)

    // The result is drawn here rather than by Claude Code, whose own drawing a card cannot hold
    // at full width and which a row inside an expanded group does not get
    const body = isOpen ? describeOutput(tool, output, isErrored) : undefined
    const card = (
      <Box flexDirection="column" width="100%" marginTop={1} paddingX={1} paddingY={1} backgroundColor={cardBg}>
        <Button key="head" plain onPress={toggle}>
          {head}
        </Button>
        {body !== undefined ? (
          <Box flexDirection="column" marginTop={1} paddingLeft={2}>
            {body.kind === 'code' ? (
              <Code {...body.props} />
            ) : (
              <Text color={dimmed(body.isError ? ERROR : FOREGROUND)} backgroundColor={cardBg}>
                {body.text}
              </Text>
            )}
            {body.more > 0 ? (
              <Text color={muted} backgroundColor={cardBg}>
                {`… ${plural(body.more, 'more line', 'more lines')}`}
              </Text>
            ) : null}
          </Box>
        ) : null}
      </Box>
    )

    // A file change whose turn has ended is a line; a run of them folds into one summary line
    // that opens into their cards, each still closed
    const verb = FILE_VERBS[tool]
    if (verb === undefined || isRunning || isErrored || (await read($, liveCalls)).includes(id)) return card

    const run = (await read($, fileRuns)).find(calls => calls.some(call => call.id === id))
    const runMember = memberOf(runState, { requestId: run?.[0]?.id ?? id })
    const isRunOpen = run !== undefined && (await read($, runMember)) === 'open'

    if (run === undefined) {
      return isOpen ? (
        card
      ) : (
        <Box marginTop={1} paddingLeft={2}>
          <Button key="head" plain onPress={toggle}>
            <Text color={dimmed(TOOL_SUMMARY)} italic>
              {`${verb} ${basename(first)}`}
            </Text>
          </Button>
        </Box>
      )
    }

    const summary = (
      <Box marginTop={1} paddingLeft={2}>
        <Button key="run" plain onPress={() => update($, runMember, current => (current === 'open' ? 'folded' : 'open'))}>
          <Text color={dimmed(TOOL_SUMMARY)} italic>
            {`${describeRun(run)}${isRunOpen ? ' ▾' : ''}`}
          </Text>
        </Button>
      </Box>
    )
    const isFirstOfRun = run[0]?.id === id
    if (!isRunOpen) return isFirstOfRun ? summary : <Box />

    const nested = (
      <Box flexDirection="column" paddingLeft={NESTED_INDENT}>
        {card}
      </Box>
    )
    return isFirstOfRun ? (
      <Box flexDirection="column">
        {summary}
        {nested}
      </Box>
    ) : (
      nested
    )
  })

  // The result Claude Code draws under a tool row: the card draws it instead
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)

    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // Replies without the opening dot, with inline code drawn as a pill and bold and italic in
  // colour; every reply before the turn's final one is dimmed, summaries of the text between
  // tool calls included
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)

    const { Box, Text, Markdown, Link } = $.ui.resolve(e)
    const isFinal = e.props.isSummary !== true && (await read($, finalReplies)).includes(replyKey(e.props.text))
    const tone = (color: string) => (isFinal ? color : dimmed(color))
    const plain = isFinal ? undefined : dimmed(FOREGROUND)

    // Plain text goes in as a bare string, which keeps the tree small. Headings pass
    // emphasis false, so their own colour wins.
    const draw = (spans: Span[], emphasis = true) =>
      spans.map(span => {
        // No-break spaces pad the pill, so a line never breaks inside it
        if (span.code) return <Text color={tone(CODE_TEXT)} backgroundColor={CODE_BG}>{` ${span.text} `}</Text>
        // Where the terminal has no hyperlinks a Link draws its text then the URL again, so
        // a bare URL stays plain text
        if (span.href) return span.href === span.text ? span.text : <Link href={span.href}>{span.text}</Link>
        if (!span.bold && !span.italic && !span.strike) return span.text
        const color = emphasis && (span.bold || span.italic) ? tone(span.bold ? BOLD : ITALIC) : undefined
        return (
          <Text weight={span.bold ? 'bold' : undefined} italic={span.italic} strikethrough={span.strike} color={color}>
            {span.text}
          </Text>
        )
      })
    const inline = (text: string, emphasis = true) => draw(parseInline(text), emphasis)

    const drawn = splitBlocks(e.props.text).map((block, index) => {
      switch (block.kind) {
        case 'markdown':
          return <Markdown text={block.text} dimColor={!isFinal} />
        case 'heading': {
          const color = block.level === 1 ? HEADING_1 : block.level === 2 ? HEADING_2 : HEADING_REST
          // Level 1 and 2 headings get a second blank line above them, so sections stand apart
          return (
            <Box marginTop={index > 0 && block.level <= 2 ? 1 : 0}>
              <Text>
                <Text color={tone(HEADING_MARK)}>{`${'#'.repeat(block.level)} `}</Text>
                <Text weight="bold" color={tone(color)} italic={block.level === 1} underline={block.level === 1}>
                  {inline(block.text, false)}
                </Text>
              </Text>
            </Box>
          )
        }
        case 'paragraph':
          return <Text color={plain}>{inline(block.text)}</Text>
        case 'list':
          return (
            <Box flexDirection="column">
              {block.items.map(item => (
                <Box flexDirection="row" paddingLeft={item.depth * 2}>
                  <Box width={item.marker.length + 1} flexShrink={0}>
                    <Text color={plain}>{item.marker}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text color={plain}>{inline(item.text)}</Text>
                  </Box>
                </Box>
              ))}
            </Box>
          )
        case 'table': {
          const columns = block.align.length
          // Borders and cell padding take 3 cells a column and 1 more, and a final reply's
          // frame 2 more; the rest is for text
          const room = (e.viewport?.columns ?? 80) - 4 - (isFinal ? 2 : 0) - (3 * columns + 1)
          // Too narrow to give each column a few cells: the engine draws it
          if (room < 4 * columns) return <Markdown text={block.source} dimColor={!isFinal} />
          const natural = block.align.map((_, column) => Math.max(1, ...block.rows.map(row => spansWidth(row[column] ?? []))))
          const longest = block.align.map((_, column) => Math.max(1, ...block.rows.map(row => longestPiece(row[column] ?? []))))
          const widths = fitWidths(natural, longest, room)
          const wrapped = block.rows.map(cells => cells.map((cell, column) => wrapSpans(cell, widths[column] ?? 1)))

          const rule = (left: string, middle: string, right: string) => (
            <Text color={plain}>{left + widths.map(width => '─'.repeat(width + 2)).join(middle) + right}</Text>
          )
          // One line of a row. The header is centred, as the engine draws it; body cells
          // follow the rule's colons
          const line = (cells: Span[][][], index: number, isHeader: boolean) => {
            const parts = cells.flatMap((lines, column) => {
              const content = lines[index] ?? []
              const gap = (widths[column] ?? 0) - spansWidth(content)
              const align = isHeader ? 'center' : block.align[column]
              const before = align === 'right' ? gap : align === 'center' ? Math.floor(gap / 2) : 0
              return [`│ ${' '.repeat(before)}`, ...draw(content), `${' '.repeat(gap - before)} `]
            })
            // Borders, padding and plain cells join into as few strings as they can
            const joined = [...parts, '│'].reduce<typeof parts>((list, part) => {
              const previous = list[list.length - 1]
              if (typeof part === 'string' && typeof previous === 'string') list[list.length - 1] = previous + part
              else list.push(part)
              return list
            }, [])
            return <Text color={plain}>{joined}</Text>
          }
          const row = (cells: Span[][][], isHeader: boolean) =>
            Array.from({ length: Math.max(1, ...cells.map(lines => lines.length)) }, (_, index) => line(cells, index, isHeader))

          return (
            <Box flexDirection="column">
              {rule('┌', '┬', '┐')}
              {wrapped.flatMap((cells, index) => (index === 0 ? row(cells, true) : [rule('├', '┼', '┤'), ...row(cells, false)]))}
              {rule('└', '┴', '┘')}
            </Box>
          )
        }
      }
    })

    // The frame's left edge and padding keep the text where an unframed reply has it
    return isFinal ? (
      <Box flexDirection="column" marginTop={1} paddingX={1} gap={1} borderStyle="round" borderColor={FRAME}>
        {drawn}
      </Box>
    ) : (
      <Box flexDirection="column" marginTop={1} paddingLeft={2} gap={1}>
        {drawn}
      </Box>
    )
  })
}
