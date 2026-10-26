import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'session-outputs',
  component: 'Pane',
  requestId: 'session-outputs',
  props: {
    title: 'Outputs',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const FOLDER = '/tmp/session/images'
const PASTED = `${FOLDER}/3.png`
const WINDOWS_PATH = '\\\\wsl.localhost\\Ubuntu\\tmp\\session\\images\\3.png'
// The first 24 bytes of a 542x624 PNG: signature and IHDR.
const PNG_HEADER = 'iVBORw0KGgoAAAANSUhEUgAAAh4AAAJwCAIAAAA='
const ARTIFACT = 'https://claude.ai/artifact/abc123'
const TYPE = 'https://claude.ai/artifact/TYPE'
// The Artifact tool's records of a typed Artifact's first publish and of a
// later one, as `tool.call` resolves them.
const CREATED = {
  result: {
    created_from_type: true,
    url: ARTIFACT,
    title: 'Pane mockups',
    type: { url: TYPE },
    instructions: '---\nname: design\ndescription: "How to fill a canvas."\n---',
  },
  text: `Created a new Artifact at ${ARTIFACT}`,
}
const UPDATED = {
  result: {
    url: ARTIFACT,
    path: '/tmp/canvas/project/canvas.json',
    artifact_id: 'uuid-1',
    title: 'Pane mockups',
    seq: 3,
    type: { url: TYPE },
  },
  text: `Updated the Artifact at ${ARTIFACT} (Version 3)`,
}

type Answer = { result: unknown; text: string }

function entry(name: string) {
  return { name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false }
}

// The hidden row the engine appends after a paste, naming the stored file.
function pastedRow(...paths: string[]) {
  return {
    message: {
      type: 'user' as const,
      role: 'user' as const,
      isMeta: true as const,
      content: paths.map(path => ({ type: 'text', text: `[Image: source: ${path}]` })),
    },
    door: 'prompt' as const,
    origin: { kind: 'composer' as const },
    uuid: 'row-1',
  }
}

// What every test needs from the engine beneath: nothing sits there but these.
// Every path is a file written at `mtimeMs`, a text file reads as `text`, a
// folder lists what `listing` gives, and each toast lands in `toasts`.
function files(
  on: Parameters<TestBody>[1],
  mtimeMs: number | (() => number),
  {
    onOpen = () => {},
    text = 'one\ntwo\nthree\n',
    listing = () => [],
    toasts = [],
  }: {
    onOpen?: () => void
    text?: string
    listing?: (path: string) => ReturnType<typeof entry>[]
    toasts?: string[]
  } = {},
) {
  on('ui.open', () => {
    onOpen()

    return { value: { isPlaced: true } }
  })
  on('clock.now', () => ({ value: 1_000_000 }))
  on('fs.stat', (_, e) => ({
    value: {
      kind: 'file',
      size: 24,
      mtimeMs: typeof mtimeMs === 'function' ? mtimeMs() : mtimeMs,
      isLink: false,
      realPath: e.path,
    },
  }))
  on('fs.read', (_, e) => ({ value: e.as === 'bytes' ? { base64: PNG_HEADER } : text }))
  on('fs.list', (_, e) => ({ value: listing(e.path) }))
  on('env.get', () => ({ value: '/home/me' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
}

// Each tool call answers with what `answer` holds when it runs.
function answers(on: Parameters<TestBody>[1], first: Answer) {
  const state = { answer: first }
  on('tool.call', () => state.answer as never)

  return state
}

async function artifactCall($: Parameters<TestBody>[0], input: Record<string, unknown>) {
  await $.tool.call({ tool: 'Artifact', ...input } as never)
}

// Every row's text, in the order drawn.
async function rowsOf(ui: {
  findAll: (query: { type: string }) => Promise<{ key: string | undefined; text: string }[]>
}) {
  return (await ui.findAll({ type: 'Button' }))
    .filter(button => button.key?.startsWith('open:'))
    .map(button => button.text)
}

test('the pane lists pasted and created images, newest first, on every surface', async ($, on) => {
  let opened = 0
  // The pasted folder also holds an image whose line a compaction dropped.
  files(on, 1_000_500, {
    onOpen: () => (opened += 1),
    listing: path => (path === FOLDER ? [entry('1.png'), entry('3.png'), entry('notes.txt')] : []),
  })
  answers(on, { result: {}, text: 'Saved the chart to out/chart.png' })

  await $.session.append(pastedRow(PASTED))
  await $.tool.call({ tool: 'Bash', command: 'python plot.py' })

  expect(opened).toBe(1)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    const rows = await rowsOf(ui)
    // The first row is selected; each is its time and pixel size, the
    // pane's width across.
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatch(/^▌ ■ Image #3 +\d\d:\d\d {2}542×624 {2}$/)
    expect(rows[1]).toMatch(/^ {2}■ Image #1 /)
    expect(rows[2]).toMatch(/^ {2}◆ chart\.png +\d\d:\d\d {2}542×624 {2}$/)
    expect(rows.every(text => text.length === 39)).toBe(true)
    expect(await ui.find({ type: 'Text', text: / 2 you · 1 Claude$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a file the call did not write is not listed', async ($, on) => {
  files(on, 5)
  answers(on, { result: {}, text: 'old.png and notes.md' })

  await $.tool.call({ tool: 'Read', file_path: '/work/old.png' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowsOf(ui)).toEqual([])
  expect((await ui.find({ type: 'Text', text: /^Nothing yet$/ }))?.text).toBe('Nothing yet')
  await ui.unmount()
})

test('a long group shows the newest five until asked for more', async ($, on) => {
  files(on, 1_000_500)

  const paths = Array.from({ length: 10 }, (_, i) => `${FOLDER}/${i + 1}.png`)
  await $.session.append(pastedRow(...paths))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowsOf(ui)).toHaveLength(5)
  expect((await ui.find({ key: 'more:images' }))?.text).toBe('  Show 5 more')

  await ui.press({ key: 'more:images' })
  expect(await rowsOf(ui)).toHaveLength(10)
  expect((await ui.find({ key: 'more:images' }))?.text).toBe('  Show fewer')
  await ui.unmount()
})

test('Open hands the Windows path to explorer.exe', async ($, on) => {
  const ran: (readonly string[])[] = []
  const toasts: string[] = []
  files(on, 1_000_500, { toasts })
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_, e) => {
    ran.push(e.argv)
    const stdout = e.argv[0] === '/usr/bin/wslpath' ? `${WINDOWS_PATH}\n` : ''

    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  await $.session.append(pastedRow(PASTED))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `open:${PASTED}` })

  expect(ran).toEqual([
    ['/usr/bin/wslpath', '-w', PASTED],
    ['/mnt/c/Windows/explorer.exe', WINDOWS_PATH],
  ])
  expect(toasts).toEqual(['Opened Image #3'])
  await ui.unmount()
})

test('a published Artifact is listed with its kind and version, and opens in the browser', async ($, on) => {
  const ran: (readonly string[])[] = []
  files(on, 5)
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_, e) => {
    ran.push(e.argv)

    return {
      value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  const calls = answers(on, CREATED)

  await artifactCall($, { type_url: TYPE, title: 'Pane mockups' })
  calls.answer = UPDATED
  await artifactCall($, { url: ARTIFACT, root: '/tmp/canvas', file_path: '/tmp/canvas/project/canvas.json' })
  // A record without a version number keeps the one known.
  calls.answer = { result: { url: ARTIFACT, title: 'Pane mockups', type: { url: TYPE } }, text: '' }
  await artifactCall($, { url: ARTIFACT, file_path: '/tmp/canvas/project/canvas.json' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowsOf(ui)).toEqual([
    expect.stringMatching(/^▌ Pane mockups design {2}\d\d:\d\d {2}v3 ↗ {5}$/),
  ])
  await ui.press({ key: `open:${ARTIFACT}` })
  expect(ran).toEqual([['/mnt/c/Windows/explorer.exe', ARTIFACT]])
  await ui.unmount()
})

test('a document Claude writes is listed under Files, an Artifact’s own files are not', async ($, on) => {
  files(on, 1_000_500)
  const calls = answers(on, {
    result: {},
    text: 'Wrote /work/report.md, /work/quarterly-latency-report-final.md and /tmp/canvas/project/Main.dc.html',
  })

  await $.tool.call({ tool: 'Bash', command: 'make docs' })
  calls.answer = CREATED
  await artifactCall($, { type_url: TYPE, title: 'Pane mockups' })
  calls.answer = UPDATED
  // The folder named with a trailing slash still holds the Artifact's files.
  await artifactCall($, { url: ARTIFACT, root: '/tmp/canvas/', file_path: '/tmp/canvas/project/canvas.json' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = await rowsOf(ui)
  expect(rows).toHaveLength(3)
  expect(rows[1]).toMatch(/^ {2}report\.md {4}md {6}\d\d:\d\d {2}3 lines {2}$/)
  // A name cut to fit still leaves a space before the kind.
  expect(rows[2]).toMatch(/^ {2}quarte…al\.md md {6}\d\d:\d\d {2}3 lines {2}$/)
  expect(await ui.find({ key: 'open:/tmp/canvas/project/Main.dc.html' })).toBeUndefined()
  await ui.unmount()
})

test('a page published from a relative path, with its data, is one row', async ($, on) => {
  files(on, 1_000_500)
  const calls = answers(on, { result: {}, text: 'Wrote page.html and out/data.csv' })

  await $.tool.call({ tool: 'Bash', command: 'python report.py' })
  calls.answer = { result: { url: ARTIFACT, title: 'Quarterly report' }, text: '' }
  await artifactCall($, { file_path: 'page.html', files: { 'data.csv': 'out/data.csv' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowsOf(ui)).toEqual([expect.stringMatching(/^▌ Quarte…eport page {4}/)])
  await ui.unmount()
})

test('an Artifact read lists no copy, and names the type for later publishes', async ($, on) => {
  files(on, 1_000_500)
  const saved = '/tmp/scratch/abc/index.html'
  const calls = answers(on, {
    result: { file_read: { url: ARTIFACT, saved_to: saved, type: { url: TYPE, title: 'Dashboard' } } },
    text: `Saved to ${saved}`,
  })

  await artifactCall($, { action: 'read', url: 'https://claude.ai/artifact/other', path: 'index.html' })
  calls.answer = { result: { created_from_type: true, url: ARTIFACT, title: 'Latency', type: { url: TYPE } }, text: '' }
  await artifactCall($, { type_url: TYPE, title: 'Latency' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowsOf(ui)).toEqual([expect.stringMatching(/^▌ Latency +dash {4}/)])
  await ui.unmount()
})

test('a long kind or extension is cut to its column, every row the pane’s width', async ($, on) => {
  files(on, 1_000_500)
  const calls = answers(on, {
    result: { quickstart: { match: { title: 'Presentation', type_url: TYPE } } },
    text: '',
  })

  await artifactCall($, { action: 'quickstart', intent: 'slides' })
  calls.answer = { result: { created_from_type: true, url: ARTIFACT, title: 'Q4 review', type: { url: TYPE } }, text: '' }
  await artifactCall($, { type_url: TYPE, title: 'Q4 review' })
  calls.answer = { result: {}, text: 'Wrote notes.markdown' }
  await $.tool.call({ tool: 'Bash', command: 'make notes' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = await rowsOf(ui)
  expect(rows[0]).toMatch(/^▌ Q4 review +presen… \d\d:\d\d/)
  expect(rows[1]).toMatch(/^ {2}notes\.…kdown md {6}\d\d:\d\d/)
  expect(rows.every(text => text.length === 39)).toBe(true)
  await ui.unmount()
})

test('deleting an Artifact by its other link takes its row away', async ($, on) => {
  files(on, 5)
  const calls = answers(on, CREATED)

  await artifactCall($, { type_url: TYPE, title: 'Pane mockups' })
  calls.answer = UPDATED
  await artifactCall($, { url: ARTIFACT, file_path: '/tmp/canvas/project/canvas.json' })
  calls.answer = { result: {}, text: 'Deleted' }
  await artifactCall($, { action: 'delete', url: 'https://claude.ai/code/artifact/uuid-1/' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowsOf(ui)).toEqual([])
  await ui.unmount()
})

test('an image written again shows its new time', async ($, on) => {
  let mtime = 1_000_500
  files(on, () => mtime)
  answers(on, { result: {}, text: 'Saved out/chart.png' })

  await $.tool.call({ tool: 'Bash', command: 'python plot.py' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const before = (await rowsOf(ui))[0]
  mtime = 4_600_500
  await $.tool.call({ tool: 'Bash', command: 'python plot.py' })

  expect(await rowsOf(ui)).toHaveLength(1)
  expect((await rowsOf(ui))[0]).not.toBe(before)
  await ui.unmount()
})

test('an empty document has no lines', async ($, on) => {
  files(on, 1_000_500, { text: '' })
  answers(on, { result: {}, text: 'Wrote notes.md' })

  await $.tool.call({ tool: 'Bash', command: 'touch notes.md' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowsOf(ui)).toEqual([expect.stringMatching(/ 0 lines {2}$/)])
  await ui.unmount()
})

test('c copies the selected row, and the row the person tabs to is selected', async ($, on) => {
  const copied: string[] = []
  files(on, 1_000_500)
  on('ui.focus', () => ({}))
  on('ui.copy', (_, e) => {
    copied.push(e.text)

    return { value: { isCopied: true } }
  })

  const older = `${FOLDER}/1.png`
  await $.session.append(pastedRow(PASTED, older))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'copy' })
  await $.ui.focus({
    component: 'Pane',
    requestId: 'session-outputs',
    element: `open:${older}`,
    origin: { kind: 'person' },
  })
  await ui.press({ key: 'copy' })

  expect(copied).toEqual([PASTED, older])
  expect((await rowsOf(ui))[1]).toMatch(/^▌ ■ Image #1 /)
  await ui.unmount()
})

test('a selected row a group folds away gives way to the first shown', async ($, on) => {
  const copied: string[] = []
  files(on, 1_000_500)
  on('ui.focus', () => ({}))
  on('ui.copy', (_, e) => {
    copied.push(e.text)

    return { value: { isCopied: true } }
  })

  const paths = Array.from({ length: 10 }, (_, i) => `${FOLDER}/${i + 1}.png`)
  await $.session.append(pastedRow(...paths))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'more:images' })
  await $.ui.focus({
    component: 'Pane',
    requestId: 'session-outputs',
    element: `open:${FOLDER}/2.png`,
    origin: { kind: 'person' },
  })
  await ui.press({ key: 'more:images' })
  await ui.press({ key: 'copy' })

  expect(copied).toEqual([`${FOLDER}/10.png`])
  expect((await rowsOf(ui))[0]).toMatch(/^▌ /)
  await ui.unmount()
})

test('a session joined midway finds a late file, however many paths came before it', async ($, on) => {
  // An early call that named more paths than one call is searched for, none of
  // them still there, a late one that wrote the file, and an Artifact publish.
  const early = Array.from({ length: 120 }, (_, i) => `/gone/${i}.md`).join(' ')
  const rows = [
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 't1', tool: 'Bash', input: { command: `ls ${early}` }, text: early },
        { tool_use_id: 't2', tool: 'Write', input: { file_path: '/work/late.md' }, text: 'Wrote it' },
        { tool_use_id: 't3', tool: 'Artifact', input: { url: ARTIFACT }, ...UPDATED },
      ],
    },
  ]
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('fs.stat', (_, e) => ({
    value: e.path.startsWith('/gone/')
      ? { kind: 'other', size: 0, mtimeMs: 0, isLink: false }
      : { kind: 'file', size: 24, mtimeMs: 1_000_500, isLink: false, realPath: e.path },
  }))
  on('fs.read', () => ({ value: 'one\n' }))
  on('fs.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/me' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('command.register', () => ({ value: {} }) as never)
  on('session.messages', (_, e) => ({ value: (e as { as?: string }).as === 'api' ? [] : rows }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work', surface: null, isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowsOf(ui)).toEqual([
    expect.stringMatching(/^▌ Pane mockups other {3}\d\d:\d\d {2}v3 ↗/),
    expect.stringMatching(/^ {2}late\.md +md /),
  ])
  await ui.unmount()
})
