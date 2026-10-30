import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, UiPressArgument } from 'claude-code'

import type {
  Group,
  ImageGroup,
  SessionArtifact,
  SessionChange,
  SessionFile,
  SessionImage,
} from '../types'

const PANE = 'session-outputs'
const TITLE = 'Outputs'
const EXPLORER = '/mnt/c/Windows/explorer.exe'
// VS Code's command line, which opens two files side by side with `--diff`.
const CODE = 'code'
// The tools whose own record of a call holds the file as it was before.
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']
// A diff takes the shortest path up to this many changed lines; past it, it
// counts the lines each side has that the other lacks, in any order.
const MAX_EDITS = 1000
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?|ico|heic)$/i
// Documents a tool call writes. A text one's lines are counted, up to this size.
const FILE_EXTENSION = /\.(pdf|docx?|odt|rtf|pptx?|odp|key|xlsx?|ods|csv|md|markdown|html?)$/i
const TEXT_EXTENSION = /\.(csv|md|markdown|html?)$/i
const MAX_TEXT_FILE = 2 * 1024 * 1024
// The pane's word for an extension that is long.
const EXTENSION_NAMES: Record<string, string> = { markdown: 'md', htm: 'html' }
// A tool's input field that holds one whole path, spaces and all.
const PATH_FIELDS = ['file_path', 'notebook_path']
// The quotes a name with spaces sits between: `cat "Jane Doe.md"`.
const QUOTES = ['"', "'", '`']
// Each folder a command moves to: `cd /vault && ...`, its name maybe quoted.
const CD = /(?:^|&&|\|\||[;\n(])\s*cd\s+("[^"\n]+"|'[^'\n]+'|[^\s;&|)]+)/g
// The engine stores each pasted image as a file and records its path in the
// conversation as this line.
const PASTED_SOURCE = /\[Image: source: ([^\]\n]+)\]/g
// The instructions a typed Artifact's first publish answers with open with
// the type's name.
const TYPE_NAME = /^name:\s*["']?([\w-]+)["']?\s*$/m
// A doc the Claude Docs connector creates.
const DOCS_TOOL = /Claude_Docs__(?:batch|create)$/
const ARTIFACT_LINK = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/
// The pane's word for a type whose own name is long, and each kind's colour.
const KIND_NAMES: Record<string, string> = { docs: 'doc', document: 'doc', dashboard: 'dash' }
const KIND_COLORS: Record<string, string> = {
  design: '#ff79c6',
  dash: '#4eba65',
  page: '#4fa597',
  doc: '#b1b9f9',
  slides: '#ffc107',
}
const YOURS = '#b1b9f9'
const SELECTED = '#33354a'
// A tool call's text is searched up to this length, for this many paths of
// each kind, images and documents.
const MAX_TEXT = 200_000
const MAX_PATHS = 100
// A session joined midway is searched for this many paths, its latest calls'
// first, checked this many at a time.
const MAX_BACKFILL_PATHS = 1000
const STAT_BATCH = 50
// Rows a group shows before "Show more".
const LIMIT = 5
// The kind, time and detail columns after a row's name, and the least room a
// name keeps before the columns go, from the right.
const COLUMNS = [8, 7, 9]
const MIN_NAME = 12
// Characters a terminal draws two cells wide: CJK, Hangul, fullwidth forms
// and emoji.
const WIDE =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const images = atom({ plugin: 'session-outputs', key: 'images' } as const, [], {
  shape: 'images-3',
})
const artifacts = atom({ plugin: 'session-outputs', key: 'artifacts' } as const, [], {
  shape: 'artifacts-2',
})
const files = atom({ plugin: 'session-outputs', key: 'files' } as const, [], {
  shape: 'files-1',
})
const changes = atom({ plugin: 'session-outputs', key: 'changes' } as const, [], {
  shape: 'changes-1',
})
const typeNames = atom({ plugin: 'session-outputs', key: 'typeNames' } as const, {})
const hasAutoOpened = atom(
  { plugin: 'session-outputs', key: 'hasAutoOpened' } as const,
  false,
)
const showAll = atom(
  { plugin: 'session-outputs', key: 'showAll' } as const,
  { artifacts: false, changes: false, files: false, images: false },
  { shape: 'groups-2' },
)
const selected = atom({ plugin: 'session-outputs', key: 'selected' } as const, '')
// The key of the element the pane's focus ring is on, '' for none of ours.
const ring = atom({ plugin: 'session-outputs', key: 'ring' } as const, '')
// Whether the ring has moved since the pane last let go of the keyboard: a
// pane that takes it back starts its ring on nothing, and says nothing of it.
let isRingSet = false

type Found = { path: string; source: ImageGroup }
// A file an edit tool changed, and what it held before, '' for a new one.
type Edited = { path: string; before: string }
// A part of a row's last cell, in its own colour.
type Part = { text: string; color?: string }
type Block = { type: string; [field: string]: unknown }
// A call to the Artifact tool or the Docs connector, with the tool's record of
// it and the text the model read.
type Call = { tool: string; input: Record<string, unknown>; result: unknown; text: string }

// One row of the pane, whichever group it sits in.
type Row = {
  key: string
  // What opening and copying it use: a link or a path.
  target: string
  isLink: boolean
  name: string
  // What "show in folder" shows: a file, selected in its folder, or a folder.
  place?: { path: string; isFolder: boolean }
  glyph?: { text: string; color: string }
  kind: string
  kindColor?: string
  time: string
  detail: string
  // A change's counts, drawn in place of `detail` where they fit.
  counts?: Part[]
  // A change's copy from before, which opening shows it against.
  before?: string
}

function basename(path: string) {
  return path.slice(path.lastIndexOf('/') + 1)
}

function dirname(path: string) {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}

// A file's extension, '' for a name with none, such as `Makefile`.
function extension(path: string) {
  const file = basename(path)
  const dot = file.lastIndexOf('.')
  const name = dot < 0 ? '' : file.slice(dot + 1).toLowerCase()

  return EXTENSION_NAMES[name] ?? name
}

// The last part of a link, its id: `abc` for both `claude.ai/artifact/abc`
// and `claude.ai/artifact/abc/`.
function lastPart(url: string) {
  return basename(url.replace(/\/+$/, ''))
}

function recordOf(value: unknown) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringOf(value: unknown) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function kindOf(typeName: string) {
  const name = typeName.toLowerCase()

  return KIND_NAMES[name] ?? name
}

function textsOf(blocks: readonly Block[]) {
  return blocks.flatMap(block =>
    block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
  )
}

// Every string inside a tool's input or result, skipping inline media.
function stringsIn(value: unknown, out: string[] = []) {
  if (typeof value === 'string') {
    out.push(value)
  } else if (Array.isArray(value)) {
    value.forEach(item => stringsIn(item, out))
  } else if (value !== null && typeof value === 'object') {
    const { type } = value as { type?: unknown }
    if (type !== 'image' && type !== 'document') {
      Object.values(value).forEach(item => stringsIn(item, out))
    }
  }

  return out
}

// The image and document paths one call's texts name, each kind counted on
// its own, so a listing of many documents cannot crowd out an image.
function outputTokens(texts: readonly string[]) {
  const imagePaths = new Set<string>()
  const documentPaths = new Set<string>()
  const add = (raw: string) => {
    const token = raw.replace(/[.:!?]+$/, '')
    if (token.includes('://')) return
    if (IMAGE_EXTENSION.test(token)) {
      if (imagePaths.size < MAX_PATHS) imagePaths.add(token)
    } else if (FILE_EXTENSION.test(token) && documentPaths.size < MAX_PATHS) {
      documentPaths.add(token)
    }
  }
  for (const text of texts) {
    const head = text.slice(0, MAX_TEXT)
    // A name with spaces is whole only between its quotes. Every stretch
    // between two of a kind is tried, as an apostrophe can pair them wrong.
    for (const quote of QUOTES) {
      for (const part of head.split(quote).slice(1, -1)) {
        if (part.includes(' ') && !part.includes('\n')) add(part)
      }
    }
    head.split(/[\s"'`<>()[\]{}|;,=]+/).forEach(add)
  }

  return [...imagePaths, ...documentPaths]
}

// The folders a command moves to, as written: a relative one is the session
// folder's.
function foldersOf(command: string) {
  return [...command.matchAll(CD)].flatMap(match => {
    const folder = (match[1] ?? '').replace(/^(["'])(.*)\1$/, '$2').replace(/(.)\/+$/, '$1')

    return folder === '' || folder === '-' ? [] : [folder]
  })
}

// The paths one call names: its tool's path fields whole, then what its texts
// name, a relative one also in each folder its command moves to, as in
// `cd /vault && python3 edit.py "Jane Doe.md"`.
function callTokens(input: Record<string, unknown>, text: string) {
  const whole = PATH_FIELDS.flatMap(field => {
    const path = stringOf(input[field])

    return path && (IMAGE_EXTENSION.test(path) || FILE_EXTENSION.test(path)) ? [path] : []
  })
  const folders = typeof input.command === 'string' ? foldersOf(input.command) : []
  const named = outputTokens([...stringsIn(input), text]).flatMap(token =>
    token.startsWith('/') || token.startsWith('~/')
      ? [token]
      : [token, ...folders.map(folder => `${folder}/${token}`)],
  )

  return [...new Set([...whole, ...named])]
}

// Turns a path a tool call named into an absolute one, against `base` or the
// session's folder.
async function resolver($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  const cwd = await $.session.cwd()

  return (path: string, base = cwd) =>
    path.startsWith('~/') ? home + path.slice(1) : path.startsWith('/') ? path : `${base}/${path}`
}

// Where an absolute path leads, links followed, without a trailing slash.
async function realPath($: EngineInterface, path: string) {
  const trimmed = path.replace(/(.)\/+$/, '$1')
  const stat = await $.fs.stat(trimmed, { resolve: true }).catch(() => undefined)

  return stat?.realPath ?? trimmed
}

// An image's time, from its file's details alone: the file itself is not read.
async function describe($: EngineInterface, found: Found) {
  const stat = await $.fs.stat(found.path).catch(() => undefined)
  if (stat?.kind !== 'file') return undefined

  return { ...found, modifiedAt: stat.mtimeMs }
}

async function describeFile($: EngineInterface, path: string) {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat?.kind !== 'file') return undefined

  const file: SessionFile = { path, modifiedAt: stat.mtimeMs, size: stat.size }
  if (TEXT_EXTENSION.test(path) && stat.size <= MAX_TEXT_FILE) {
    const text = await $.fs.read(path, { as: 'text' }).catch(() => undefined)
    if (typeof text === 'string') file.lines = linesOf(text).length
  }

  return file
}

// A text's lines, without the empty one after its last newline.
function linesOf(text: string) {
  const lines = text === '' ? [] : text.split('\n')
  if (lines.at(-1) === '') lines.pop()

  return lines
}

// How many lines two texts share in order, by Myers' shortest edit; past
// MAX_EDITS changes, how many lines of one the other also has.
function commonLines(a: readonly string[], b: readonly string[]) {
  const max = Math.min(a.length + b.length, MAX_EDITS)
  // The furthest line of `a` reached on each diagonal, `max` its middle.
  const reach = new Int32Array(2 * max + 2)
  for (let d = 0; d <= max; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      const down = reach[max + k + 1] ?? 0
      const right = reach[max + k - 1] ?? 0
      let x = k === -d || (k !== d && right < down) ? down : right + 1
      let y = x - k
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x += 1
        y += 1
      }
      reach[max + k] = x
      if (x >= a.length && y >= b.length) return (a.length + b.length - d) / 2
    }
  }
  const left = new Map<string, number>()
  for (const line of a) left.set(line, (left.get(line) ?? 0) + 1)
  let shared = 0
  for (const line of b) {
    const count = left.get(line) ?? 0
    if (count > 0) {
      shared += 1
      left.set(line, count - 1)
    }
  }

  return shared
}

// The lines `after` has gained and lost against `before`, the head and tail
// they share set aside before they are diffed.
function lineChanges(before: string, after: string) {
  const a = linesOf(before)
  const b = linesOf(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const shared = commonLines(a.slice(start, endA), b.slice(start, endB))

  return { added: endB - start - shared, removed: endA - start - shared }
}

// The pasted images the texts name, plus every image in the folders they sit
// in, so images whose lines a compaction dropped are still found.
async function findPasted($: EngineInterface, texts: readonly string[]) {
  const paths = texts.flatMap(text =>
    [...text.matchAll(PASTED_SOURCE)].flatMap(match =>
      match[1] ? [match[1].trim()] : [],
    ),
  )
  const folders = [...new Set(paths.map(dirname))]
  const listed = await Promise.all(
    folders.map(async folder => {
      const entries = await $.fs.list(folder).catch(() => [])

      return entries
        .filter(entry => entry.kind === 'file' && IMAGE_EXTENSION.test(entry.name))
        .map(entry => `${folder}/${entry.name}`)
    }),
  )

  return [...paths, ...listed.flat()]
}

// The image and document files the tokens name that were written at or after
// `since`.
async function findCreated(
  $: EngineInterface,
  tokens: readonly string[],
  since: number,
) {
  if (tokens.length === 0) return []

  const resolve = await resolver($)
  const found: string[] = []
  for (let i = 0; i < tokens.length; i += STAT_BATCH) {
    const batch = await Promise.all(
      tokens.slice(i, i + STAT_BATCH).map(async token => {
        const path = resolve(token)
        const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)

        return stat?.kind === 'file' && stat.mtimeMs >= since ? [stat.realPath ?? path] : []
      }),
    )
    found.push(...batch.flat())
  }

  return [...new Set(found)]
}

// The pane opens by itself the first time a session has something to list.
async function openOnce($: EngineInterface) {
  if (!(await read($, hasAutoOpened))) {
    await update($, hasAutoOpened, () => true)
    void $.ui.open({ id: PANE, title: TITLE })
  }
}

// A pasted image never changes, so one already listed is left alone; an image
// a tool call writes again is looked up afresh, for its new time.
async function addImages($: EngineInterface, found: readonly Found[]) {
  const known = new Map((await read($, images)).map(image => [image.path, image]))
  const fresh = new Map<string, Found>()
  for (const image of found) {
    const stored = known.get(image.path)
    if (!stored || (stored.source === 'claude' && image.source === 'claude')) {
      fresh.set(image.path, image)
    }
  }
  if (fresh.size === 0) return

  const described = await Promise.all([...fresh.values()].map(image => describe($, image)))
  const added = described.filter(image => image !== undefined)
  if (added.length === 0) return

  const changed = new Set(added.map(image => image.path))
  await update($, images, list => [...list.filter(image => !changed.has(image.path)), ...added])
  await openOnce($)
}

// A file written again replaces what was stored for it.
async function addFiles($: EngineInterface, paths: readonly string[]) {
  const described = await Promise.all([...new Set(paths)].map(path => describeFile($, path)))
  const added = described.filter(file => file !== undefined)
  if (added.length === 0) return

  const changed = new Set(added.map(file => file.path))
  await update($, files, list => [...list.filter(file => !changed.has(file.path)), ...added])
  await openOnce($)
}

async function addCreated($: EngineInterface, paths: readonly string[]) {
  await addImages(
    $,
    paths
      .filter(path => IMAGE_EXTENSION.test(path))
      .map(path => ({ path, source: 'claude' as const })),
  )
  await addFiles(
    $,
    paths.filter(path => FILE_EXTENSION.test(path)),
  )
}

// The file an edit tool's own record of a call says it changed, and what the
// file held before; undefined for a call held for review, or a file too large
// for the record to hold.
function editedBy(tool: string, result: unknown): Edited | undefined {
  const record = recordOf(result)
  const path = stringOf(record.filePath) ?? stringOf(record.notebook_path)
  if (!EDIT_TOOLS.includes(tool) || !path || record.staged === true) return undefined

  const before = tool === 'NotebookEdit' ? record.original_file : record.originalFile
  if (typeof before === 'string') return { path, before }
  // A file the call created held nothing.
  const isCreated = tool === 'Edit' ? record.oldString === '' : record.type === 'create'

  return before === null && isCreated ? { path, before: '' } : undefined
}

// Where the copy of a file from before the session changed it is kept: under
// the session's own folder, at the file's own path, so a diff is titled with
// the file's name and the editor reads its language from it.
async function copyPathOf($: EngineInterface, path: string) {
  const temp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')

  return `${temp}/claude-session-outputs/${await $.session.id()}${path}`
}

// Counts a changed file's lines against its copy from before, and stores
// them; a file gone, or too large to read, keeps the counts it had.
async function countChange($: EngineInterface, path: string, before: string) {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat?.kind !== 'file' || stat.size > MAX_TEXT_FILE) return false

  const [now, then] = await Promise.all(
    [path, before].map(file => $.fs.read(file, { as: 'text' }).catch(() => undefined)),
  )
  if (typeof now !== 'string' || typeof then !== 'string') return false

  const change: SessionChange = { path, before, modifiedAt: stat.mtimeMs, ...lineChanges(then, now) }
  await update($, changes, list => [...list.filter(other => other.path !== path), change])

  return true
}

// A file an edit tool changed. The first change of the session keeps a copy
// of what it held, which every later count and diff is against.
async function addChange($: EngineInterface, edited: Edited) {
  const path = await realPath($, edited.path)
  const known = (await read($, changes)).find(change => change.path === path)
  const before = known?.before ?? (await copyPathOf($, path))
  if (!known) {
    const isKept = await $.fs.write(before, edited.before).then(
      () => true,
      () => false,
    )
    if (!isKept) return
  }
  if (await countChange($, path, before)) await openOnce($)
}

// Counts again each change whose file a later call wrote, such as a command
// that formats it or puts it back.
async function refreshChanges($: EngineInterface) {
  const list = await read($, changes)
  for (let i = 0; i < list.length; i += STAT_BATCH) {
    await Promise.all(
      list.slice(i, i + STAT_BATCH).map(async change => {
        const stat = await $.fs.stat(change.path).catch(() => undefined)
        if (stat?.kind === 'file' && stat.mtimeMs !== change.modifiedAt) {
          await countChange($, change.path, change.before)
        }
      }),
    )
  }
}

async function nameType($: EngineInterface, typeUrl: unknown, typeName: unknown) {
  const url = stringOf(typeUrl)
  const name = stringOf(typeName)
  if (!url || !name) return

  const kind = kindOf(name)
  if ((await read($, typeNames))[url] !== kind) {
    await update($, typeNames, names => ({ ...names, [url]: kind }))
  }
}

// The local paths a publish's `files` takes its files from, against the
// Artifact's folder: a list's paths, or a map's sources (a copy from another
// Artifact has none).
function supportingPaths(value: unknown) {
  const paths = Array.isArray(value)
    ? value.map(entry => stringOf(entry) ?? stringOf(recordOf(entry).path))
    : Object.values(recordOf(value)).map(
        entry => stringOf(entry) ?? stringOf(recordOf(entry).from),
      )

  return paths.flatMap(path => (path ? [path] : []))
}

async function saveArtifact(
  $: EngineInterface,
  artifact: Omit<SessionArtifact, 'publishedAt'>,
  isBackfill: boolean,
) {
  const known = (await read($, artifacts)).find(other => other.url === artifact.url)
  // A backfill knows the order of publishes but not their times.
  if (isBackfill && known && known.version >= artifact.version) return

  const publishedAt =
    isBackfill && known ? known.publishedAt : await $.clock.now()
  await update($, artifacts, list => [
    ...list.filter(other => other.url !== artifact.url),
    { ...artifact, publishedAt },
  ])
  await openOnce($)
}

// What an Artifact call tells: a type's name, a publish, or a delete. Read
// from the tool's own record of the call, not the text the model read.
async function noteArtifact($: EngineInterface, call: Call, isBackfill: boolean) {
  const { input } = call
  const result = recordOf(call.result)
  const action = stringOf(input.action) ?? 'publish'

  const match = recordOf(recordOf(result.quickstart).match)
  await nameType($, match.type_url, match.title)
  const readType = recordOf(recordOf(result.file_read).type)
  await nameType($, readType.url, readType.title)

  if (action === 'delete' && typeof input.url === 'string' && input.path === undefined) {
    const gone = lastPart(input.url)
    await update($, artifacts, list =>
      list.filter(other => lastPart(other.url) !== gone && other.id !== gone),
    )

    return
  }
  const url = stringOf(result.url)
  if (action !== 'publish' || input.asset === true || !url) return

  const known = (await read($, artifacts)).find(other => other.url === url)
  const resolve = await resolver($)
  const rootGiven = stringOf(input.root)
  const root = rootGiven ? await realPath($, resolve(rootGiven)) : known?.root
  const sent = [
    stringOf(result.path) ?? stringOf(input.file_path),
    ...supportingPaths(input.files).map(path => resolve(path, root)),
  ].flatMap(path => (path ? [resolve(path)] : []))
  const sources = [
    ...new Set([
      ...(known?.sources ?? []),
      ...(await Promise.all(sent.map(path => realPath($, path)))),
    ]),
  ]

  const typeUrl = stringOf(recordOf(result.type).url) ?? known?.typeUrl
  const typeName = TYPE_NAME.exec(stringOf(result.instructions) ?? '')?.[1]
  await nameType($, typeUrl, typeName)
  const seq = typeof result.seq === 'number' ? result.seq : undefined
  const id = stringOf(result.artifact_id) ?? known?.id
  const title =
    stringOf(result.title) ?? known?.title ?? (sources[0] ? basename(sources[0]) : lastPart(url))

  await saveArtifact(
    $,
    {
      url,
      ...(id === undefined ? {} : { id }),
      title,
      kind: typeUrl ? (typeName ? kindOf(typeName) : (known?.kind ?? 'other')) : 'page',
      ...(typeUrl === undefined ? {} : { typeUrl }),
      // An answer without a number keeps the version, never goes back.
      version: Math.max(known?.version ?? 1, seq ?? 1),
      sources,
      ...(root === undefined ? {} : { root }),
    },
    isBackfill,
  )
}

// A doc the Docs connector created, from the link in its answer.
async function noteDoc($: EngineInterface, call: Call, isBackfill: boolean) {
  const { container } = call.input as { container?: { create?: { name?: unknown } } }
  const url = ARTIFACT_LINK.exec(call.text)?.[0]
  if (!container?.create || !url) return

  const { name } = container.create
  await saveArtifact(
    $,
    {
      url,
      title: typeof name === 'string' ? name : 'Untitled doc',
      kind: 'doc',
      version: 1,
      sources: [],
    },
    isBackfill,
  )
}

async function notePublished($: EngineInterface, call: Call, isBackfill = false) {
  if (call.tool === 'Artifact') await noteArtifact($, call, isBackfill)
  else if (DOCS_TOOL.test(call.tool)) await noteDoc($, call, isBackfill)
}

// What the conversation already holds, for a session the mod joins midway.
async function backfill($: EngineInterface) {
  const messages = await $.session.messages({ as: 'api' })
  const rows = await $.session.messages()
  if (!Array.isArray(messages) || !Array.isArray(rows)) return

  const userTexts = messages.flatMap(message =>
    message.role === 'user' ? textsOf(message.content) : [],
  )
  const published: Call[] = []
  const perCall: string[][] = []
  // Each changed file with what it held before its first change.
  const edited = new Map<string, Edited>()
  for (const row of rows) {
    for (const use of row.toolUses) {
      if (use.tool === 'Artifact' || DOCS_TOOL.test(use.tool)) {
        if (!use.isError) {
          published.push({ tool: use.tool, input: use.input, result: use.result, text: use.text ?? '' })
        }
      } else {
        const change = use.isError ? undefined : editedBy(use.tool, use.result)
        if (change && !edited.has(change.path)) edited.set(change.path, change)
        perCall.push(callTokens(use.input, use.text ?? ''))
      }
    }
  }
  // Each call is searched on its own, as a live one is, and the latest calls
  // first, so a long session's early paths cannot crowd out its late ones.
  const tokens = new Set<string>()
  for (const found of perCall.reverse()) {
    if (tokens.size >= MAX_BACKFILL_PATHS) break
    found.forEach(token => tokens.add(token))
  }

  const { startedAt } = await $.session.usage()
  const pasted = await findPasted($, userTexts)
  await addImages(
    $,
    pasted.map(path => ({ path, source: 'user' as const })),
  )
  await addCreated($, await findCreated($, [...tokens], startedAt))
  for (const change of edited.values()) await addChange($, change)
  for (const call of published) await notePublished($, call, true)
}

async function windowsPath($: EngineInterface, path: string) {
  const { stdout } = await $.process.run(['/usr/bin/wslpath', '-w', path])

  return stdout.trim()
}

// A file in its default app, or a link in the default browser: through
// explorer.exe on WSL, the same as a double click, and xdg-open elsewhere.
async function openRow($: EngineInterface, row: Row) {
  await update($, selected, () => row.key)
  if (row.before !== undefined) {
    await openDiff($, row, row.before)

    return
  }
  try {
    if (!row.isLink && !(await $.fs.exists(row.target))) {
      $.ui.toast(`${row.name} no longer exists`)

      return
    }
    if (await $.fs.exists(EXPLORER)) {
      const target = row.isLink ? row.target : await windowsPath($, row.target)
      // explorer.exe exits 1 even when it opened the file.
      await $.process.run([EXPLORER, target], { cwd: '/mnt/c', timeoutMs: 15_000 })
    } else {
      await $.process.run(['xdg-open', row.target], { timeoutMs: 15_000 })
    }
    $.ui.toast(`Opened ${row.name}`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    $.ui.toast(`Could not open ${row.name}: ${reason}`)
  }
}

// A change as a diff in VS Code: its copy from before on the left, the file
// as it is now on the right.
async function openDiff($: EngineInterface, row: Row, before: string) {
  try {
    if (!(await $.fs.exists(row.target))) {
      $.ui.toast(`${row.name} no longer exists`)

      return
    }
    if (!(await $.fs.exists(before))) {
      $.ui.toast(`The copy of ${row.name} from before was removed`)

      return
    }
    const ran = await $.process.run([CODE, '--diff', before, row.target], { timeoutMs: 30_000 })
    if (ran.exitCode !== 0) {
      throw new Error(ran.stderr.trim() || `${CODE} exited with ${ran.exitCode}`)
    }
    $.ui.toast(`Opened the changes to ${row.name} in VS Code`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    $.ui.toast(`Could not open the changes to ${row.name}: ${reason}`)
  }
}

async function showInFolder($: EngineInterface, row: Row) {
  const { place } = row
  try {
    if (!place || !(await $.fs.exists(place.path))) {
      $.ui.toast(`${row.name} has no file here`)

      return
    }
    if (await $.fs.exists(EXPLORER)) {
      const path = await windowsPath($, place.path)
      await $.process.run([EXPLORER, place.isFolder ? path : `/select,${path}`], {
        cwd: '/mnt/c',
        timeoutMs: 15_000,
      })
    } else {
      await $.process.run(['xdg-open', place.isFolder ? place.path : dirname(place.path)], {
        timeoutMs: 15_000,
      })
    }
    $.ui.toast(`Showed ${row.name} in its folder`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    $.ui.toast(`Could not show ${row.name}: ${reason}`)
  }
}

async function copyRow($: EngineInterface, row: Row, surface: RenderSurface) {
  const copied = await $.ui.copy({ text: row.target, surface })
  $.ui.toast(
    copied.isCopied
      ? `Copied the ${row.isLink ? 'link' : 'path'} of ${row.name}`
      : `Could not copy: ${copied.reason}`,
  )
}

function pastedNumber(image: SessionImage) {
  return Number(/^(\d+)\./.exec(basename(image.path))?.[1] ?? 0)
}

// "14:05" for today, "25 Oct" for an earlier day.
function shortTime(ms: number, now: number) {
  const date = new Date(ms)
  if (date.toDateString() !== new Date(now).toDateString()) {
    return `${date.getDate()} ${MONTHS[date.getMonth()]}`
  }

  return [date.getHours(), date.getMinutes()]
    .map(part => String(part).padStart(2, '0'))
    .join(':')
}

function shortSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function shortLines(lines: number) {
  if (lines >= 1000) return `${Math.round(lines / 1000)}k lines`

  return `${lines} line${lines === 1 ? '' : 's'}`
}

// "12", or "3k" from a thousand.
function shortCount(count: number) {
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count)
}

// A change's counts as its last cell's parts: "+12" green and "-3" red, or a
// dim "unchanged" for a file that is back as it was.
function countsOf(change: SessionChange): Part[] {
  const parts = [
    ...(change.added > 0 ? [{ text: `+${shortCount(change.added)}`, color: 'success' }] : []),
    ...(change.removed > 0 ? [{ text: `-${shortCount(change.removed)}`, color: 'error' }] : []),
  ]

  return parts.length > 0 ? parts : [{ text: 'unchanged' }]
}

function cellsOf(text: string) {
  let cells = 0
  for (const char of text) cells += WIDE.test(char) ? 2 : 1

  return cells
}

// The text in exactly `width` cells: cut with an ellipsis where it is longer,
// losing its middle or its end, and padded where it is shorter.
function fit(text: string, width: number, cutMiddle = false) {
  if (width <= 0) return ''
  const pad = (out: string) => out + ' '.repeat(Math.max(0, width - cellsOf(out)))
  if (cellsOf(text) <= width) return pad(text)

  const chars = [...text]
  const room = width - 1
  let head = ''
  for (const char of chars) {
    if (cellsOf(head + char) > (cutMiddle ? Math.ceil(room / 2) : room)) break
    head += char
  }
  let tail = ''
  if (cutMiddle) {
    for (const char of chars.reverse()) {
      if (cellsOf(head + char + tail) > room) break
      tail = char + tail
    }
  }

  return pad(`${head}…${tail}`)
}

// The text in exactly `width` cells, as `fit` cuts it, but padded at its start
// so that it ends at the edge.
function fitEnd(text: string, width: number) {
  const out = fit(text, width).trimEnd()

  return ' '.repeat(Math.max(0, width - cellsOf(out))) + out
}

// Each path's file name, with its folder's name before it where two share one.
function namesOf(paths: readonly string[]) {
  const names = paths.map(basename)

  return paths.map((path, i) =>
    names.filter(name => name === names[i]).length > 1
      ? `${basename(dirname(path))}/${names[i]}`
      : names[i],
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-outputs',
      description: 'Show the artifacts, files and images of this session in a pane',
    })
    await backfill($)

    return next(e)
  })

  on('command.run', { command: 'session-outputs' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Outputs pane opened.' }
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.message.type === 'user') {
      const texts = textsOf(e.message.content)
      if (texts.some(text => text.includes('[Image: source: '))) {
        const pasted = await findPasted($, texts)
        await addImages(
          $,
          pasted.map(path => ({ path, source: 'user' as const })),
        )
      }
    }

    return stored
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    // A second's slack for file systems that round modification times.
    const since = (await $.clock.now()) - 1000
    const ran = await next(e)
    if (ran.deny === undefined) {
      const tool = String(e.tool)
      const input = e as unknown as Record<string, unknown>
      if (tool === 'Artifact' || DOCS_TOOL.test(tool)) {
        // Their calls write nothing of Claude's: a read saves a copy of the
        // page, which is no document of the session's.
        if (ran.isError !== true) {
          await notePublished($, { tool, input, result: ran.result, text: ran.text ?? '' })
        }
      } else {
        const edited = ran.isError === true ? undefined : editedBy(tool, ran.result)
        if (edited) await addChange($, edited)
        await refreshChanges($)
        await addCreated($, await findCreated($, callTokens(input, ran.text ?? ''), since))
      }
    }

    return ran
  }).catch(($, e, next) => next(e))

  // The row the person tabs to is the one c and s act on, and where the ring
  // lands is the element Claude Code draws inverted. Both are written before
  // the ring moves, so no frame shows the row inverted in its own colours.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const { element } = e
    const was = { ring: await read($, ring), selected: await read($, selected), isRingSet }
    isRingSet = true
    await update($, ring, () => element ?? '')
    if (element?.startsWith('open:')) await update($, selected, () => element)
    const moved = await next(e)
    if (moved.deny !== undefined) {
      isRingSet = was.isRingSet
      await update($, ring, () => was.ring)
      await update($, selected, () => was.selected)
    }

    return moved
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const imageList = await read($, images)
    const artifactList = await read($, artifacts)
    const fileList = await read($, files)
    const changeList = await read($, changes)
    const names = await read($, typeNames)
    const expanded = await read($, showAll)
    const picked = await read($, selected)
    if (!e.props.isFocused) isRingSet = false
    // Only the terminal draws the ring as an inverse; a desktop draws its own.
    const ringOn = e.surface === 'terminal' && isRingSet ? await read($, ring) : ''
    const now = await $.clock.now()
    // One column spare, so a full row never wraps at the frame's edge.
    const width = Math.max(20, e.props.bodyColumns - 1)

    const artifactRows = [...artifactList]
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .map((artifact): Row => {
        const kind = (artifact.typeUrl && names[artifact.typeUrl]) || artifact.kind
        const source = artifact.sources[0]

        return {
          key: `open:${artifact.url}`,
          target: artifact.url,
          isLink: true,
          name: artifact.title,
          ...(artifact.root !== undefined
            ? { place: { path: artifact.root, isFolder: true } }
            : source !== undefined
              ? { place: { path: source, isFolder: false } }
              : {}),
          kind,
          ...(KIND_COLORS[kind] ? { kindColor: KIND_COLORS[kind] } : {}),
          time: shortTime(artifact.publishedAt, now),
          detail: `v${artifact.version}`,
        }
      })

    // An Artifact's own files are its row, not rows of their own.
    const isSource = (path: string) =>
      artifactList.some(
        artifact =>
          artifact.sources.includes(path) ||
          (artifact.root !== undefined && path.startsWith(`${artifact.root}/`)),
      )
    const shownChanges = changeList
      .filter(change => !isSource(change.path))
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
    const changeNames = namesOf(shownChanges.map(change => change.path))
    const changeRows = shownChanges.map((change, i): Row => {
      const counts = countsOf(change)

      return {
        key: `open:${change.path}`,
        target: change.path,
        isLink: false,
        name: changeNames[i] ?? basename(change.path),
        place: { path: change.path, isFolder: false },
        kind: extension(change.path),
        time: shortTime(change.modifiedAt, now),
        detail: counts.map(part => part.text).join(' '),
        counts,
        before: change.before,
      }
    })

    // A changed file is its row under Changes, not under Files or Images.
    const isChanged = (path: string) => changeList.some(change => change.path === path)
    const shownFiles = fileList
      .filter(file => !isSource(file.path) && !isChanged(file.path))
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
    const fileNames = namesOf(shownFiles.map(file => file.path))
    const fileRows = shownFiles.map(
      (file, i): Row => ({
        key: `open:${file.path}`,
        target: file.path,
        isLink: false,
        name: fileNames[i] ?? basename(file.path),
        place: { path: file.path, isFolder: false },
        kind: extension(file.path),
        time: shortTime(file.modifiedAt, now),
        detail: file.lines === undefined ? shortSize(file.size) : shortLines(file.lines),
      }),
    )

    const pasted = imageList
      .filter(image => image.source === 'user')
      .sort((a, b) => pastedNumber(b) - pastedNumber(a) || b.modifiedAt - a.modifiedAt)
    const created = imageList
      .filter(image => image.source === 'claude' && !isChanged(image.path))
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
    const createdNames = namesOf(created.map(image => image.path))
    const labelOf = (image: SessionImage) => {
      if (image.source === 'claude') {
        return createdNames[created.indexOf(image)] ?? basename(image.path)
      }
      const number = pastedNumber(image)

      return number ? `Image #${number}` : basename(image.path)
    }
    const imageRows = [...pasted, ...created]
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .map(
        (image): Row => ({
          key: `open:${image.path}`,
          target: image.path,
          isLink: false,
          name: labelOf(image),
          place: { path: image.path, isFolder: false },
          glyph:
            image.source === 'user'
              ? { text: '■', color: YOURS }
              : { text: '◆', color: 'claude' },
          kind: '',
          time: shortTime(image.modifiedAt, now),
          detail: '',
        }),
      )

    if (artifactRows.length + changeRows.length + fileRows.length + imageRows.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold>Nothing yet</Text>
          <Text dimColor>
            Images you paste, the artifacts, documents and images Claude makes, and
            the files it changes show up here.
          </Text>
        </Box>
      )
    }

    const shownOf = (key: Group, items: readonly Row[]) =>
      expanded[key] ? items : items.slice(0, LIMIT)
    // c and s act on a row the person can see: the one picked, while its
    // group shows it, else the first.
    const visible = [
      ...shownOf('artifacts', artifactRows),
      ...shownOf('changes', changeRows),
      ...shownOf('files', fileRows),
      ...shownOf('images', imageRows),
    ]
    const current = visible.find(row => row.key === picked) ?? visible[0]

    // Every row is the pane's width: its name takes what its group's columns
    // leave, and its last cell ends at the edge.
    const room = width - 2
    const widthOf = (columns: readonly number[]) =>
      columns.reduce((sum, column) => sum + (COLUMNS[column] ?? 0), 0)
    // The columns a group shows: those any of its rows fills, less the ones a
    // narrow pane drops from the right before a name gets too short.
    const columnsOf = (items: readonly Row[]) => {
      let shown = COLUMNS.flatMap((_, column) =>
        items.some(item => [item.kind, item.time, item.detail][column]) ? [column] : [],
      )
      while (shown.length > 0 && room - widthOf(shown) < MIN_NAME) shown = shown.slice(0, -1)

      return shown
    }

    const row = (shown: readonly number[]) => (item: Row) => {
      const isCurrent = item.key === current?.key
      // Claude Code inverts the row its focus ring is on, part by part, so that
      // row's colours are swapped here for the inverse to put them back.
      const isRinged = item.key === ringOn
      // A part's colours: its own, on the selected row's background.
      const tint = (color: string | undefined, isDim = false) =>
        isRinged
          ? { color: SELECTED, backgroundColor: color ?? (isDim ? 'inactive' : 'text') }
          : {
              ...(color !== undefined ? { color } : isDim ? { dimColor: true } : {}),
              ...(isCurrent ? { backgroundColor: SELECTED } : {}),
            }
      const glyph = item.glyph ? `${item.glyph.text} ` : ''
      // A space always parts the name, and each cell but the last, from what
      // follows it.
      const name = fit(item.name, room - widthOf(shown) - glyph.length - 1, true) + ' '
      const detail = isCurrent && item.isLink ? `${item.detail} ↗` : item.detail
      const texts = [item.kind, item.time, detail]
      const cells = shown.map((column, n) => {
        const text = texts[column] ?? ''
        const cellWidth = COLUMNS[column] ?? 0

        return n === shown.length - 1 ? fitEnd(text, cellWidth) : `${fit(text, cellWidth - 1)} `
      })
      const colorOf = (column: number) =>
        column === 0 ? item.kindColor : column === 2 && isCurrent && item.isLink ? 'claude' : undefined
      // A cell as drawn. A change's counts, where they fit whole, each take
      // their own colour after the cell's padding.
      const partsOf = (cell: string, column: number) => {
        const { counts } = item
        if (column !== 2 || !counts || !cell.endsWith(detail)) {
          return [
            <Text key={`cell:${column}`} {...tint(colorOf(column), true)}>
              {cell}
            </Text>,
          ]
        }

        return [
          <Text key={`cell:${column}`} {...tint(undefined, true)}>
            {cell.slice(0, cell.length - detail.length)}
          </Text>,
          ...counts.map((part, n) => (
            <Text key={`count:${n}`} {...tint(part.color, true)}>
              {n === 0 ? part.text : ` ${part.text}`}
            </Text>
          )),
        ]
      }

      // Claude Code inverts a Button under the pointer, each part in its own
      // colours; a hover on the keyed Box that turns inverse off keeps the row
      // still. The ring's row stays inverted, as its colours are drawn for that.
      return (
        <Box key={`row:${item.key}`}>
          <Button key={item.key} plain hover={{ inverse: isRinged }} onPress={() => openRow($, item)}>
            {[
              <Text key="mark" {...tint('claude')}>
                {isCurrent ? '▌ ' : '  '}
              </Text>,
              ...(item.glyph
                ? [
                    <Text key="glyph" {...tint(item.glyph.color)}>
                      {glyph}
                    </Text>,
                  ]
                : []),
              <Text key="name" {...tint(undefined)}>
                {name}
              </Text>,
              ...cells.flatMap((cell, n) => partsOf(cell, shown[n] ?? 0)),
            ]}
          </Button>
        </Box>
      )
    }

    const group = (key: Group, title: string, count: string, items: readonly Row[]) => {
      if (items.length === 0) return undefined
      const isOpen = expanded[key]
      const rule = '─'.repeat(Math.max(1, width - title.length - count.length - 2))

      return (
        <Box key={`group:${key}`} flexDirection="column">
          <Box flexDirection="row">
            <Text bold>{title}</Text>
            <Text dimColor>{` ${rule} ${count}`}</Text>
          </Box>
          {shownOf(key, items).map(row(columnsOf(items)))}
          {items.length > LIMIT && (
            <Box key={`more-row:${key}`}>
              <Button
                key={`more:${key}`}
                plain
                hover={{ underline: true, inverse: false }}
                onPress={() =>
                  update($, showAll, state => ({ ...state, [key]: !state[key] }))
                }
              >
                <Text dimColor>
                  {isOpen ? '  Show fewer' : `  Show ${items.length - LIMIT} more`}
                </Text>
              </Button>
            </Box>
          )}
        </Box>
      )
    }

    const imageCount = [
      pasted.length > 0 ? `${pasted.length} you` : '',
      created.length > 0 ? `${created.length} Claude` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    // Docked, the pane fills its column so the keys sit on its last rows.
    // Inline, the frame fits what is drawn, so the keys follow the list.
    const fill = e.props.placement === 'dock' ? { minHeight: e.props.scroll.bodyRows } : {}

    // A key at the foot, its letter in the accent colour a plain Button gives
    // its hotkey and its label dim until pointed at. It sits in a keyed Box, for
    // its hover to turn off the inverse Claude Code draws under the pointer.
    const keyLine = (
      key: string,
      hotkey: string,
      label: string,
      onPress: (press: UiPressArgument) => unknown,
    ) => (
      <Box key={`${key}-row`}>
        <Button
          key={key}
          plain
          dimColor
          hotkey={hotkey}
          label={label}
          hover={{ inverse: false }}
          onPress={onPress}
        />
      </Box>
    )

    return (
      <Box flexDirection="column" rowGap={1} {...fill}>
        <Box flexDirection="column" rowGap={1} flexGrow={1}>
          {group('artifacts', 'Artifacts', String(artifactRows.length), artifactRows)}
          {group('changes', 'Changes', String(changeRows.length), changeRows)}
          {group('files', 'Files', String(fileRows.length), fileRows)}
          {group('images', 'Images', imageCount, imageRows)}
        </Box>
        {/* The keys, one to a line. */}
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Text color="suggestion">enter:</Text>
            <Text dimColor> open</Text>
          </Box>
          {keyLine('copy', 'c', 'copy link or path', press => current && copyRow($, current, press.surface))}
          {keyLine('reveal', 's', 'show in folder', () => current && showInFolder($, current))}
        </Box>
      </Box>
    )
  })
}
