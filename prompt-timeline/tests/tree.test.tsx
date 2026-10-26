import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'prompt-timeline',
  component: 'Pane',
  requestId: 'prompt-timeline',
  props: {
    title: 'Timeline',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// A dock wide enough for the header's count beside its controls.
const WIDE = { ...PANE, props: { ...PANE.props, bodyColumns: 64 } } as const

const TRANSCRIPT = '/home/me/.claude/projects/-work/s1.jsonl'

// The tree scan's records for a session rewound to b: a-b-c-d first, then
// e-f from b, where the conversation stands. Each turn did something else:
// nothing but reply, two commands, a file, another tool, a commit, a push.
const SCAN = [
  'H\tf',
  'T\ta\t\t2026-10-20T13:00:00Z\ta9\t0\t0\t\t0\tfirst"\tfirst reply"',
  'T\tb\ta\t2026-10-20T13:01:00Z\tb9\t2\t0\t\t0\tsecond"\tsecond reply"',
  'T\tc\tb\t2026-10-20T13:02:00Z\tc9\t0\t1\t\t0\tthird"\tthird reply"',
  'T\td\tc\t2026-10-20T13:03:00Z\td9\t0\t0\tArtifact\t0\tfourth"\tthe border is \\"done\\""',
  'T\te\tb\t2026-10-20T13:04:00Z\te9\t1\t0\t\t1\tfifth"\tfifth reply"',
  'T\tf\te\t2026-10-20T13:05:00Z\tf9\t1\t0\t\t2\tsixth"\tsixth reply"',
]

// The list scan's records for the same prompts: each first response's tokens,
// of a window of 200,000. c's turn has none.
const PROMPTS = [
  'P\t1\ta\t2026-10-20T13:00:00Z\tfirst"',
  'R\t2\t20000',
  'P\t3\tb\t2026-10-20T13:01:00Z\tsecond"',
  'R\t4\t150000',
  'P\t5\tc\t2026-10-20T13:02:00Z\tthird"',
  'P\t7\td\t2026-10-20T13:03:00Z\tfourth"',
  'R\t8\t190000',
  'P\t9\te\t2026-10-20T13:04:00Z\tfifth"',
  'R\t10\t60000',
  'P\t11\tf\t2026-10-20T13:05:00Z\tsixth"',
  'R\t12\t100000',
]

// The engine beneath the plugin, as far as these tests reach it: a transcript
// of `size` bytes whose tree is SCAN, whose list is `prompts`, and in which
// `found` is what a grep finds, a store holding `stored`, a shell that appends,
// an awk that copies, and a `/resume` that takes or not. Given `forks`, the
// project holds those transcripts beside it, by path, each with its tree, and
// one more that is no fork.
const engine = (
  on: On,
  resume?: () => Promise<unknown>,
  scan = SCAN,
  {
    stored = {},
    prompts = [],
    size = 100,
    found = '',
    forks,
  }: { stored?: Record<string, unknown>; prompts?: string[]; size?: number; found?: string; forks?: Record<string, string[]> } = {},
) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T14:00:00Z') })
  mock.store(on, stored)
  mock.env(on, { HOME: '/home/me' })
  mock.session(on)
  const toasts: string[] = []
  const copies: string[] = []
  const appended: string[][] = []
  const commands: string[] = []
  const copied: string[][] = []
  on('command.register', () => ({ value: { command: 'timeline' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.copy', (_, e) => (copies.push(e.text), { value: { isCopied: true } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file', size, mtimeMs: 0, isLink: false, resolve: false } }))
  const scanned: string[] = []
  const ran: string[][] = []
  if (forks !== undefined) {
    const file = (name: string) => ({ name, kind: 'file' as const, size: 100, mtimeMs: 0, isLink: false })
    on('fs.list', (_, e) => ({
      value:
        e.path === '/home/me/.claude/projects'
          ? [{ name: '-work', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }]
          : ['s1.jsonl', ...Object.keys(forks).map(path => path.slice(path.lastIndexOf('/') + 1)), 'other.jsonl'].map(file),
    }))
  }
  on('process.run', (_, e) => {
    const isTreeScan = e.argv[0] === 'awk' && e.argv[1]!.includes('last-prompt')
    if (isTreeScan) scanned.push(e.argv[2]!)
    ran.push([...e.argv])
    if (e.argv[0] === 'sh') appended.push([...e.argv])
    if (e.argv[0] === 'awk' && e.argv[1] === '-v') copied.push([...e.argv])
    // The grep that looks for forks names the files it reads after `--`.
    const isForkSearch = e.argv[0] === 'grep' && e.argv.includes('--')

    return {
      value: {
        exitCode: 0,
        stdout: isTreeScan
          ? (forks?.[e.argv[2]!] ?? scan).join('\n')
          : isForkSearch
            ? Object.keys(forks ?? {}).join('\n')
            : e.argv[0] === 'grep'
              ? found
              : e.argv[0] === 'awk'
                ? prompts.join('\n')
                : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('command.run', async (_, e) => {
    commands.push(`/${e.command} ${e.args}`)
    await resume?.()

    return {}
  })

  return { clock, toasts, copies, appended, commands, copied, scanned, ran }
}

const rows = async (ui: { findAll: (q: { type: 'Button' }) => Promise<{ key?: unknown; text: string }[]> }) =>
  (await ui.findAll({ type: 'Button' }))
    .filter(button => /^[a-g]$/.test(String(button.key)))
    .map(button => button.text)

test('the tree draws every branch under the prompt it grew from, and marks where the session stands', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  // The tree is read unawaited at start.
  await clock.settle()
  const ui = await $.ui.mount({ ...WIDE, surface: 'terminal' })

  // The pane opens on the tree: the switch shows it filled in the accent, the
  // list beside it on the theme's shade.
  expect((await ui.find({ type: 'Text', text: ' tree ' }))?.props).toEqual({
    backgroundColor: 'claude',
    color: 'inverseText',
    bold: true,
  })
  expect((await ui.find({ type: 'Text', text: ' list ' }))?.props).toEqual({
    backgroundColor: 'userMessageBackground',
    dimColor: true,
  })
  expect(await ui.find({ type: 'Text', text: '4 turns · 1 branch' })).toBeDefined()
  // Each row: the lanes and the prompt's dot on its own, then its turn number,
  // then the prompt. At b the newer branch, e, carries on down the lane and the
  // older one forks off.
  expect(await rows(ui)).toEqual([
    '● 1 first',
    '● 2 second',
    '│ ○ 3 third',
    '│ ○ 4 fourth',
    '● 3 fifth',
    '◉ 4 sixth',
  ])
  expect((await ui.find({ type: 'Text', text: 'sixth' }))?.props).toEqual({ bold: true })
  expect((await ui.findAll({ type: 'Text', text: /^ 4 $/ })).map(number => number.props)).toEqual([
    { color: 'planMode' },
    { bold: true },
  ])
  // Above the old branch a row of lines forks it off the lane, which the path
  // runs on down past it, lit; the branch takes a colour of its own.
  expect((await ui.find({ type: 'Text', text: '├' }))?.props).toEqual({ color: 'claude' })
  expect((await ui.find({ type: 'Text', text: '─╮' }))?.props).toEqual({ color: 'planMode' })
  expect((await ui.find({ type: 'Text', text: '│ ' }))?.props).toEqual({ color: 'claude' })
  expect((await ui.find({ type: 'Text', text: /^○$/ }))?.props).toEqual({ color: 'planMode' })
  // Each row ends with what the turn did, the branch's first with its length,
  // and the row where the conversation stands with where it is.
  expect((await ui.find({ type: 'Text', text: /⇡ pushed$/ }))?.props).toEqual({ color: 'warning' })
  expect((await ui.find({ type: 'Text', text: /● committed$/ }))?.props).toEqual({ color: 'warning' })
  expect((await ui.find({ type: 'Text', text: /› 2 cmds$/ }))?.props).toEqual({ dimColor: true })
  expect((await ui.find({ type: 'Text', text: /◇ Artifact$/ }))?.props).toEqual({ color: 'suggestion' })
  expect((await ui.find({ type: 'Text', text: /2 turns$/ }))?.props).toEqual({ color: 'planMode' })
  expect(await ui.findAll({ type: 'Text', text: /◂ here/ })).toHaveLength(1)
  await ui.unmount()
})

test('each row shows the context its prompt was answered over, between what the turn did and when it was sent', async ($, on) => {
  const { clock } = engine(on, undefined, SCAN, { prompts: PROMPTS })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...WIDE, surface: 'terminal' })

  // In the tree's order, a branch's prompts too, toned as the list tones them;
  // c's row leaves the column blank.
  const gauges = async () =>
    (await ui.findAll({ type: 'Text', text: /%$/ })).map(gauge => [gauge.text, gauge.props])
  expect(await gauges()).toEqual([
    ['   10%', { color: '#bbbb66' }],
    ['   75%', { color: '#ff4600' }],
    ['   95%', { color: '#ff0e00' }],
    ['   30%', { color: '#ffff00' }],
    ['   50%', { color: '#ff8c00' }],
  ])
  const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
  const at = texts.indexOf('   10%')
  expect(texts[at - 1]?.trim()).toBe('reply')
  expect(texts[at + 1]).toMatch(/^ {2}.{6}$/)

  // ctx hides the column here as in the list.
  expect((await ui.find({ key: 'context' }))?.text).toBe('● ctx')
  await ui.press({ key: 'context' })
  expect((await ui.find({ key: 'context' }))?.text).toBe('○ ctx')
  expect(await gauges()).toEqual([])
  await ui.press({ key: 'context' })
  await ui.unmount()

  // In a narrow dock the context gives way first: what the turn did stays.
  const narrow = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await narrow.findAll({ type: 'Text', text: /%$/ })).toEqual([])
  expect(await narrow.find({ type: 'Text', text: /› 2 cmds$/ })).toBeDefined()
  await narrow.unmount()
})

test('the pane opens on the tree, whatever view an earlier version stored, and the list lasts the session', async ($, on) => {
  const { clock } = engine(on, undefined, SCAN, { stored: { isTree: false } })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: ' tree ' }))?.props).toEqual(
    expect.objectContaining({ backgroundColor: 'claude' }),
  )
  expect(await rows(ui)).toHaveLength(6)

  await ui.press({ key: 'list-view' })
  await ui.unmount()
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await again.find({ type: 'Text', text: ' list ' }))?.props).toEqual(
    expect.objectContaining({ backgroundColor: 'claude' }),
  )
  await again.unmount()
})

test('a branch of a branch forks off its own line, one lane further in', async ($, on) => {
  // c and its branch g fork off b; g left no reply.
  const { clock } = engine(on, undefined, [
    ...SCAN,
    'T\tg\tc\t2026-10-20T13:06:00Z\tg9\t0\t0\t\t0\tseventh"\t',
  ].sort((one, other) => (one.startsWith('T\tg') ? -1 : 0) - (other.startsWith('T\tg') ? -1 : 0)))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...WIDE, surface: 'terminal' })

  expect(await rows(ui)).toEqual([
    '● 1 first',
    '● 2 second',
    '│ ○ 3 third',
    '│ │ ○ 4 seventh',
    '│ ○ 4 fourth',
    '● 3 fifth',
    '◉ 4 sixth',
  ])
  expect(await ui.find({ type: 'Text', text: '4 turns · 2 branches' })).toBeDefined()
  // g's fork leaves c's line, in c's colour, and g's line takes the next.
  const forks = await ui.findAll({ type: 'Text', text: '├' })
  expect(forks.map(fork => fork.props)).toEqual([{ color: 'claude' }, { color: 'planMode' }])
  expect((await ui.findAll({ type: 'Text', text: '─╮' })).map(fork => fork.props)).toEqual([
    { color: 'planMode' },
    { color: 'bashBorder' },
  ])
  expect((await ui.find({ type: 'Text', text: /no reply$/ }))?.props).toEqual({ color: 'bashBorder' })
  await ui.unmount()
})

test('a switch moves the numbers and the lit lines, never the rows', async ($, on) => {
  const { clock } = engine(on, undefined, ['H\td', ...SCAN.slice(1)])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // The same rows as when the session stood at f: now the path turns off the
  // lane into the old branch, and the lane's own turns are a branch it left.
  expect(await rows(ui)).toEqual([
    '● 1 first',
    '● 2 second',
    '│ ● 3 third',
    '│ ◉ 4 fourth',
    '○ 3 fifth',
    '○ 4 sixth',
  ])
  expect((await ui.find({ type: 'Text', text: '├' }))?.props).toEqual({ color: 'claude' })
  expect((await ui.find({ type: 'Text', text: '─╮' }))?.props).toEqual({ color: 'claude' })
  expect((await ui.find({ type: 'Text', text: '│ ' }))?.props).toEqual({ color: 'merged' })
  expect((await ui.find({ type: 'Text', text: /2 turns$/ }))?.props).toEqual({ color: 'merged' })
  await ui.unmount()
})

test('after a rewind, the prompts past where the session stands stay where they were', async ($, on) => {
  const { clock } = engine(on, undefined, ['H\tb', ...SCAN.slice(1)])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await rows(ui)).toEqual(['● 1 first', '◉ 2 second', '│ ○ 3 third', '│ ○ 4 fourth', '○ 3 fifth', '○ 4 sixth'])
  expect((await ui.find({ type: 'Text', text: 'second' }))?.props).toEqual({ bold: true })
  await ui.unmount()
})

// A session rewound to the top: a-b first, then c, asked over again from
// nothing, where the conversation stands.
const RESTART = [
  'H\tc',
  'T\ta\t\t2026-10-20T13:00:00Z\ta9\t0\t1\t\t0\tfirst"\tfirst reply"',
  'T\tb\ta\t2026-10-20T13:01:00Z\tb9\t0\t1\t\t0\tsecond"\tsecond reply"',
  'T\tc\t\t2026-10-20T13:02:00Z\tc9\t0\t1\t\t0\tfirst again"\tfirst reply again"',
]

test('a rewind to the top starts a line of its own, and the conversation it left forks off above it', async ($, on) => {
  const { clock } = engine(on, undefined, RESTART)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...WIDE, surface: 'terminal' })

  expect(await rows(ui)).toEqual(['│ ○ 1 first', '│ ○ 2 second', '◉ 1 first again'])
  expect(await ui.find({ type: 'Text', text: '1 turn · 1 branch' })).toBeDefined()
  // The fork sits above the first row, nothing above it; the lane runs on past
  // the old conversation, lit, to where the session stands.
  expect((await ui.find({ type: 'Text', text: '┬' }))?.props).toEqual({ color: 'claude' })
  expect((await ui.find({ type: 'Text', text: '─╮' }))?.props).toEqual({ color: 'planMode' })
  // No row of lines between the prompts: the lane runs on, lit, beside them.
  expect(await ui.findAll({ type: 'Text', text: /^│$/ })).toEqual([])
  expect((await ui.findAll({ type: 'Text', text: /^│ $/ })).map(line => line.props)).toEqual([
    { color: 'claude' },
    { color: 'claude' },
  ])
  expect((await ui.find({ type: 'Text', text: /2 turns$/ }))?.props).toEqual({ color: 'planMode' })
  await ui.unmount()
})

test('back on the conversation a rewind to the top left, its line is lit and the new start is a branch', async ($, on) => {
  const { clock } = engine(on, undefined, ['H\tb', ...RESTART.slice(1)])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...WIDE, surface: 'terminal' })

  expect(await rows(ui)).toEqual(['│ ● 1 first', '│ ◉ 2 second', '○ 1 first again'])
  expect(await ui.find({ type: 'Text', text: '2 turns · 1 branch' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '┬' }))?.props).toEqual({ color: 'claude' })
  expect((await ui.find({ type: 'Text', text: '│ ' }))?.props).toEqual({ color: 'merged' })
  expect((await ui.find({ type: 'Text', text: /1 turn$/ }))?.props).toEqual({ color: 'merged' })
  await ui.unmount()
})

test("the row where the session stands opens a card that copies the command to open it there", async ($, on) => {
  const { copies, clock } = engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'f' })
  await ui.press({ key: 'copy:f' })

  expect(copies).toEqual(['/resume-at s1:f9'])
  await ui.unmount()
})

test('a prompt on an abandoned branch opens a card with its reply', async ($, on) => {
  const { toasts, clock } = engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'd' })
  expect(await ui.find({ type: 'Text', text: 'the border is "done"' })).toBeDefined()
  expect((await ui.find({ key: 'switch:d' }))?.text).toBe(' ↪ continue here ')
  expect((await ui.find({ type: 'Text', text: ' ↪ continue here ' }))?.props).toEqual({
    backgroundColor: 'planMode',
    color: 'inverseText',
    bold: true,
  })
  expect((await ui.find({ key: 'copy:d' }))?.text).toBe('⧉ copy /resume-at …:d9')

  // A second press closes it. A prompt on the way here scrolls to it, and its
  // card holds only the command: the transcript shows its reply.
  await ui.press({ key: 'd' })
  expect(await ui.find({ key: 'switch:d' })).toBeUndefined()
  await ui.press({ key: 'b' })
  expect(await ui.find({ key: 'switch:b' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'second reply' })).toBeUndefined()
  expect((await ui.find({ key: 'copy:b' }))?.text).toBe('⧉ copy /resume-at …:b9')
  expect(toasts[0]).toContain("Couldn't scroll to that prompt")
  await ui.unmount()
})

test("a card copies the command that opens the session at its turn from another terminal", async ($, on) => {
  const { copies, toasts, clock } = engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'd' })
  await ui.press({ key: 'copy:d' })

  expect(copies).toEqual(['/resume-at s1:d9'])
  expect(toasts).toEqual(['Copied /resume-at s1:d9'])
  await ui.unmount()
})

test('continue from here points the session at the end of that turn and resumes it', async ($, on) => {
  const { appended, commands, toasts, clock } = engine(on, () =>
    $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } }),
  )
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'd' })
  await ui.press({ key: 'switch:d' })

  expect(appended).toHaveLength(1)
  const [shell, flag, script, name, record, path] = appended[0]!
  expect([shell, flag, script, name, path]).toEqual(['sh', '-c', 'printf "%s\\n" "$1" >> "$2"', 'sh', TRANSCRIPT])
  expect(JSON.parse(record!)).toEqual({
    type: 'last-prompt',
    lastPrompt: 'fourth',
    leafUuid: 'd9',
    explicit: true,
    sessionId: 's1',
  })
  expect(commands).toEqual(['/resume s1'])
  expect(toasts).toEqual(['Back at turn 4, “fourth”: your next prompt continues from there.'])
  await ui.unmount()
})

// Claude Code reads a transcript past 5 MiB only from its last compaction on.
const LONG = 6 * 1024 * 1024

test('a turn before the last compaction of a long transcript continues in a copy of the session', async ($, on) => {
  const { appended, commands, copied, toasts, clock } = engine(
    on,
    () => $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 'copy' } }),
    SCAN,
    { size: LONG, found: '12:"uuid":"d9"\n40:"subtype":"compact_boundary"' },
  )
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'd' })
  await ui.press({ key: 'switch:d' })

  // The copy takes every row under its own id, its compactions kept as notes.
  expect(copied).toHaveLength(1)
  const [, , from, , to, , dst, script, source] = copied[0]!
  const copyId = to!.slice('to="sessionId":"'.length, -1)
  expect([from, dst, source]).toEqual(['from="sessionId":"s1"', `dst=/home/me/.claude/projects/-work/${copyId}.jsonl`, TRANSCRIPT])
  expect(script).toContain('"subtype":"compact_boundary"')
  expect(script).toContain('informational')

  // It is the copy that is pointed at the turn, and resumed.
  expect(appended.map(argv => argv[5])).toEqual([`/home/me/.claude/projects/-work/${copyId}.jsonl`])
  expect(JSON.parse(appended[0]![4]!)).toEqual({
    type: 'last-prompt',
    lastPrompt: 'fourth',
    leafUuid: 'd9',
    explicit: true,
    sessionId: copyId,
  })
  expect(commands).toEqual([`/resume ${copyId}`])
  expect(toasts[0]).toContain(`so this is ${copyId}, a copy of the session with every branch`)
  await ui.unmount()
})

test('a turn after the last compaction of a long transcript continues in the session itself', async ($, on) => {
  const { commands, copied, clock } = engine(
    on,
    () => $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } }),
    SCAN,
    { size: LONG, found: '12:"subtype":"compact_boundary"\n40:"uuid":"d9"' },
  )
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'd' })
  await ui.press({ key: 'switch:d' })

  expect(copied).toEqual([])
  expect(commands).toEqual(['/resume s1'])
  await ui.unmount()
})

test("a resume that does not take leaves the branch saved and says how to open it", async ($, on) => {
  const { commands, copies, toasts, clock } = engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'c' })
  await ui.press({ key: 'switch:c' })

  expect(commands).toEqual(['/resume s1'])
  expect(copies).toEqual(['claude --resume s1'])
  expect(toasts).toEqual(['Branch saved: quit, then run claude --resume s1 (copied).'])
  await ui.unmount()
})

test('find searches the tree in place, lighting each match and dimming the rest', async ($, on) => {
  const { clock } = engine(on, undefined, SCAN, { prompts: PROMPTS })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...WIDE, surface: 'terminal' })
  await ui.press({ key: 'search-toggle' })
  expect((await ui.find({ type: 'Text', text: ' tree ' }))?.props).toEqual(
    expect.objectContaining({ backgroundColor: 'claude' }),
  )

  const field = (await ui.find({ type: 'Input' }))?.key as string
  await ui.input({ key: field, text: 'fi' })
  // Every row stays where it was: a and e matched.
  expect(await rows(ui)).toEqual([
    '● 1 first',
    '● 2 second',
    '│ ○ 3 third',
    '│ ○ 4 fourth',
    '● 3 fifth',
    '◉ 4 sixth',
  ])
  expect((await ui.findAll({ type: 'Text', text: /^fi$/ })).map(match => match.props)).toEqual([
    { color: 'warning', bold: true },
    { color: 'warning', bold: true },
  ])
  expect((await ui.find({ type: 'Text', text: 'second' }))?.props).toEqual({ dimColor: true })
  expect((await ui.find({ type: 'Text', text: 'sixth' }))?.props).toEqual({ dimColor: true })
  expect(await ui.find({ type: 'Text', text: '2 of 6' })).toBeDefined()

  // The search stays open across the switch: the list shows the matches alone.
  await ui.press({ key: 'list-view' })
  expect(await rows(ui)).toEqual(['5  fifth', '1  first'])
  await ui.press({ key: 'tree-toggle' })
  expect((await ui.find({ type: 'Input' }))?.key).toBe(field)
  expect(await rows(ui)).toHaveLength(6)

  await ui.input({ key: field, text: 'nothing like it' })
  expect(await ui.find({ type: 'Text', text: /No prompt holds that/ })).toBeDefined()

  // Closed, the tree is lit whole again.
  await ui.press({ key: 'search-toggle' })
  expect((await ui.find({ type: 'Text', text: 'sixth' }))?.props).toEqual({ bold: true })
  expect(await ui.find({ type: 'Text', text: '4 turns · 1 branch' })).toBeDefined()
  await ui.unmount()
})

// A fork the desktop app made of s1 at b: a session of its own, s2, holding a
// and b as s1 has them, then its own turn fe, asked after b and newer than any,
// its first response answered over 40,000 tokens.
const FORK_PATH = '/home/me/.claude/projects/-work/s2.jsonl'
const FORK = [
  'H\tfe',
  'N\tPassword page (fork)',
  'T\ta\t\t2026-10-20T13:00:00Z\ta9\t0\t0\t\t0\tfirst"\tfirst reply"',
  'T\tb\ta\t2026-10-20T13:01:00Z\tb8\t2\t0\t\t0\tsecond"\tsecond reply"',
  'T\tfe\tb\t2026-10-20T13:10:00Z\tfe9\t0\t1\t\t0\tforked"\tforked reply"\t40000',
]

const forkRows = async (ui: { findAll: (q: { type: 'Button' }) => Promise<{ key?: unknown; text: string }[]> }) =>
  (await ui.findAll({ type: 'Button' }))
    .filter(button => /^([a-f]|fe)$/.test(String(button.key)))
    .map(button => button.text)

test("a fork's own turns are a branch of the tree, under the turn it was made at", async ($, on) => {
  const { appended, commands, copies, toasts, scanned, clock } = engine(
    on,
    () => $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's2' } }),
    SCAN,
    { forks: { [FORK_PATH]: FORK }, found: '"uuid":"fe9"' },
  )
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...WIDE, surface: 'terminal' })

  // The fork's transcript is read; the project's other one is not, as it holds
  // none of the session's first prompts.
  expect(scanned).toEqual([TRANSCRIPT, FORK_PATH])
  // a and b are the session's own, drawn once. fe is the newest asked after b:
  // it carries on down the lane, and the conversation's turns fork off it.
  expect(await forkRows(ui)).toEqual([
    '● 1 first',
    '● 2 second',
    '│ ○ 3 third',
    '│ ○ 4 fourth',
    '│ ● 3 fifth',
    '│ ◉ 4 sixth',
    '○ 3 forked',
  ])
  expect(await ui.find({ type: 'Text', text: '4 turns · 2 branches' })).toBeDefined()

  // Its card says which chat it is, and copies the command for that session.
  await ui.press({ key: 'fe' })
  expect(await ui.find({ type: 'Text', text: 'forked reply' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'in the chat “Password page (fork)”' })).toBeDefined()
  await ui.press({ key: 'copy:fe' })
  expect(copies).toEqual(['/resume-at s2:fe9'])

  // Going on from it points the fork at the turn and resumes the fork.
  await ui.press({ key: 'switch:fe' })
  await clock.settle()
  expect(appended.map(argv => argv[5])).toEqual([FORK_PATH])
  expect(JSON.parse(appended[0]![4]!)).toEqual({
    type: 'last-prompt',
    lastPrompt: 'forked',
    leafUuid: 'fe9',
    explicit: true,
    sessionId: 's2',
  })
  expect(commands).toEqual(['/resume s2'])
  expect(toasts).toEqual(['Copied /resume-at s2:fe9', 'Opening session s2 at message fe9.'])
  await ui.unmount()
})

test('on the desktop the lanes are pictures, and a press opens a card where the terminal would scroll', async ($, on) => {
  const { appended, copied, copies, ran, toasts, clock } = engine(on, undefined, SCAN, {
    forks: { [FORK_PATH]: FORK },
    prompts: PROMPTS,
  })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...WIDE, surface: 'desktop' })

  // The pane's frame names it: the header is the views, as native buttons
  // with the one shown the primary, and what the view holds.
  expect(await ui.find({ type: 'Text', text: 'Timeline' })).toBeUndefined()
  expect((await ui.find({ key: 'tree-toggle' }))?.props).toEqual(expect.objectContaining({ variant: 'primary' }))
  expect((await ui.find({ key: 'list-view' }))?.props).toEqual(expect.objectContaining({ variant: 'secondary' }))
  expect(await ui.find({ type: 'Text', text: '4 turns · 2 branches' })).toBeDefined()

  // Each row is its lanes, one picture as wide as every other's, then its
  // number and prompt; no line is drawn in text.
  expect(await forkRows(ui)).toEqual(['1  first', '2  second', '3  third', '4  fourth', '3  fifth', '4  sixth', '3  forked'])
  expect(await ui.findAll({ type: 'Text', text: /[│├╮┬]/ })).toEqual([])
  const lanes = (await ui.findAll({ type: 'Svg' })).filter(svg => svg.props.height === 28)
  expect(lanes.map(svg => svg.props.width)).toEqual(Array(7).fill(28))
  const source = (index: number) => String(lanes[index]!.props.source)
  // c's branch curves off the lit lane in a colour of its own, its dot hollow.
  expect(source(2)).toContain('C')
  expect(source(2)).toContain('<circle cx="21" cy="14" r="3" stroke="#14b8a6"')
  // Where the chat stands, a lit dot with a halo; the fork's turn, hollow,
  // on the lane the conversation left, in the main line's colour.
  expect(source(5)).toContain('fill-opacity="0.25"')
  expect(source(6)).toContain('<circle cx="7" cy="14" r="3" stroke="#8b5cf6"')
  // Every row has its context, the fork's from its own transcript, in a
  // column as wide on every row; c's row leaves it blank.
  const gauges = (await ui.findAll({ type: 'Text', text: /^\d*%?$/ })).filter(text => text.props.tabular === true && text.props.size === 'caption')
  expect(gauges.map(gauge => gauge.text)).toEqual(['10%', '75%', '', '95%', '30%', '50%', '20%'])

  // A prompt on the conversation opens its card in place: nothing scrolls,
  // nothing is said, and its reply shows, as the transcript is not moved to it.
  await ui.press({ key: 'b' })
  expect(toasts).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'second reply' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '/resume-at s1:b9' })).toBeDefined()
  expect(await ui.find({ key: 'switch:b' })).toBeUndefined()

  // A branch a rewind left goes on in a new chat, as the app's own Fork
  // does: a copy of the session, pointed at the turn and named for it, which
  // the app is asked to open by its link. The session itself is not written.
  await ui.press({ key: 'd' })
  expect(await ui.find({ type: 'Text', text: 'A branch a rewind left.' })).toBeDefined()
  expect(await ui.find({ key: 'chat:d' })).toBeUndefined()
  await ui.press({ key: 'switch:d' })
  expect(copied).toHaveLength(1)
  const [, , from, , to, , dst, , source1] = copied[0]!
  const copyId = to!.slice('to="sessionId":"'.length, -1)
  const copyPath = `/home/me/.claude/projects/-work/${copyId}.jsonl`
  expect([from, dst, source1]).toEqual(['from="sessionId":"s1"', `dst=${copyPath}`, TRANSCRIPT])
  expect(appended.map(argv => [argv[5], JSON.parse(argv[4]!)])).toEqual([
    [copyPath, { type: 'last-prompt', lastPrompt: 'fourth', leafUuid: 'd9', explicit: true, sessionId: copyId }],
    [copyPath, { type: 'custom-title', customTitle: 'Branch (turn 4)', sessionId: copyId }],
  ])
  expect(ran.at(-1)).toEqual(['/mnt/c/Windows/explorer.exe', `claude://resume?session=${copyId}`])
  expect(toasts).toEqual(['Opening “Branch (turn 4)”, a new chat that goes on from turn 4.'])
  expect(await ui.find({ key: 'switch:d' })).toBeUndefined()

  // A fork's says which chat it is, goes on from its own transcript, and
  // opens that chat as it stands.
  await ui.press({ key: 'fe' })
  expect(await ui.find({ type: 'Text', text: 'forked reply' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'From the chat “Password page (fork)”.' })).toBeDefined()
  await ui.press({ key: 'copy:fe' })
  expect(copies).toEqual(['/resume-at s2:fe9'])
  await ui.press({ key: 'chat:fe' })
  expect(ran.at(-1)).toEqual(['/mnt/c/Windows/explorer.exe', 'claude://resume?session=s2'])
  await ui.press({ key: 'switch:fe' })
  expect(copied.at(-1)?.[2]).toBe('from="sessionId":"s2"')
  expect(copied.at(-1)?.at(-1)).toBe(FORK_PATH)
  expect(JSON.parse(appended.at(-1)![4]!)).toEqual(expect.objectContaining({ customTitle: 'Password page (fork) (turn 3)' }))
  await ui.unmount()
})
