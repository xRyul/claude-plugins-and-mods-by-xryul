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

// The engine beneath the plugin, as far as these tests reach it: a transcript
// whose tree is SCAN, a shell that appends, and a `/resume` that takes or not.
const engine = (on: On, resume?: () => Promise<unknown>, scan = SCAN) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T14:00:00Z') })
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  mock.session(on)
  const toasts: string[] = []
  const copies: string[] = []
  const appended: string[][] = []
  const commands: string[] = []
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
  on('fs.stat', () => ({ value: { kind: 'file', size: 100, mtimeMs: 0, isLink: false, resolve: false } }))
  on('process.run', (_, e) => {
    const isTreeScan = e.argv[0] === 'awk' && e.argv[1]!.includes('last-prompt')
    if (e.argv[0] === 'sh') appended.push([...e.argv])

    return {
      value: {
        exitCode: 0,
        stdout: isTreeScan ? scan.join('\n') : '',
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

  return { clock, toasts, copies, appended, commands }
}

const rows = async (ui: { findAll: (q: { type: 'Button' }) => Promise<{ key?: unknown; text: string }[]> }) =>
  (await ui.findAll({ type: 'Button' }))
    .filter(button => /^[a-g]$/.test(String(button.key)))
    .map(button => button.text)

test('the tree draws every branch under the prompt it grew from, and marks where the session stands', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...WIDE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })

  // The switch shows the tree filled in the accent, the list beside it on the
  // theme's shade.
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
  // Between two prompts, a row of lines: above the old branch it forks off the
  // lane, which the path runs on down past it, lit; the branch takes a colour
  // of its own.
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
  expect((await ui.find({ type: 'Text', text: / turn 4 · / }))?.text).toBe('◉ turn 4 · on the main line')
  await ui.unmount()
})

test('a branch of a branch forks off its own line, one lane further in', async ($, on) => {
  // c and its branch g fork off b; g left no reply.
  engine(on, undefined, [
    ...SCAN,
    'T\tg\tc\t2026-10-20T13:06:00Z\tg9\t0\t0\t\t0\tseventh"\t',
  ].sort((one, other) => (one.startsWith('T\tg') ? -1 : 0) - (other.startsWith('T\tg') ? -1 : 0)))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...WIDE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })

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
  engine(on, undefined, ['H\td', ...SCAN.slice(1)])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })

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
  expect((await ui.find({ type: 'Text', text: / turn 4 · / }))?.text).toBe('◉ turn 4 · on a branch from turn 2')
  await ui.unmount()
})

test('after a rewind, the prompts past where the session stands stay where they were', async ($, on) => {
  engine(on, undefined, ['H\tb', ...SCAN.slice(1)])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })

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
  engine(on, undefined, RESTART)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...WIDE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })

  expect(await rows(ui)).toEqual(['│ ○ 1 first', '│ ○ 2 second', '◉ 1 first again'])
  expect(await ui.find({ type: 'Text', text: '1 turn · 1 branch' })).toBeDefined()
  // The fork sits above the first row, nothing above it; the lane runs on past
  // the old conversation, lit, to where the session stands.
  expect((await ui.find({ type: 'Text', text: '┬' }))?.props).toEqual({ color: 'claude' })
  expect((await ui.find({ type: 'Text', text: '─╮' }))?.props).toEqual({ color: 'planMode' })
  const colours = (await ui.findAll({ type: 'Text', text: '│' })).map(line => line.props?.color)
  expect(colours.filter(colour => colour !== 'claude')).toEqual(['planMode'])
  expect(colours.at(-1)).toBe('claude')
  expect((await ui.find({ type: 'Text', text: /2 turns$/ }))?.props).toEqual({ color: 'planMode' })
  expect((await ui.find({ type: 'Text', text: / turn 1 · / }))?.text).toBe('◉ turn 1 · on the main line')
  await ui.unmount()
})

test('back on the conversation a rewind to the top left, the tree says it branched from the start', async ($, on) => {
  engine(on, undefined, ['H\tb', ...RESTART.slice(1)])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...WIDE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })

  expect(await rows(ui)).toEqual(['│ ● 1 first', '│ ◉ 2 second', '○ 1 first again'])
  expect(await ui.find({ type: 'Text', text: '2 turns · 1 branch' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '┬' }))?.props).toEqual({ color: 'claude' })
  expect((await ui.find({ type: 'Text', text: '│ ' }))?.props).toEqual({ color: 'merged' })
  expect((await ui.find({ type: 'Text', text: /1 turn$/ }))?.props).toEqual({ color: 'merged' })
  expect((await ui.find({ type: 'Text', text: / turn 2 · / }))?.text).toBe('◉ turn 2 · on a branch from the start')
  await ui.unmount()
})

test("the last row copies the command that opens the session where it stands", async ($, on) => {
  const { copies } = engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })
  await ui.press({ key: 'copy-here' })

  expect(copies).toEqual(['/resume-at s1:f9'])
  await ui.unmount()
})

test('a prompt on an abandoned branch opens a card with its reply', async ($, on) => {
  const { toasts } = engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })

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
  const { copies, toasts } = engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })
  await ui.press({ key: 'd' })
  await ui.press({ key: 'copy:d' })

  expect(copies).toEqual(['/resume-at s1:d9'])
  expect(toasts).toEqual(['Copied /resume-at s1:d9'])
  await ui.unmount()
})

test('continue from here points the session at the end of that turn and resumes it', async ($, on) => {
  const { appended, commands, toasts } = engine(on, () =>
    $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } }),
  )
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })
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

test("a resume that does not take leaves the branch saved and says how to open it", async ($, on) => {
  const { commands, copies, toasts } = engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })
  await ui.press({ key: 'c' })
  await ui.press({ key: 'switch:c' })

  expect(commands).toEqual(['/resume s1'])
  expect(copies).toEqual(['claude --resume s1'])
  expect(toasts).toEqual(['Branch saved: quit, then run claude --resume s1 (copied).'])
  await ui.unmount()
})

test('find leaves the tree for the list', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })
  await ui.press({ key: 'search-toggle' })

  expect((await ui.find({ type: 'Text', text: ' list ' }))?.props).toEqual(
    expect.objectContaining({ backgroundColor: 'claude' }),
  )
  expect(await rows(ui)).toEqual([])
  await ui.unmount()
})
