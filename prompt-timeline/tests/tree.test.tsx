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

const TRANSCRIPT = '/home/me/.claude/projects/-work/s1.jsonl'

// The tree scan's records for a session rewound to b: a-b-c-d first, then
// e-f from b, where the conversation stands.
const SCAN = [
  'H\tf',
  'T\ta\t\t2026-10-20T13:00:00Z\ta9\tfirst"\tfirst reply"',
  'T\tb\ta\t2026-10-20T13:01:00Z\tb9\tsecond"\tsecond reply"',
  'T\tc\tb\t2026-10-20T13:02:00Z\tc9\tthird"\tthird reply"',
  'T\td\tc\t2026-10-20T13:03:00Z\td9\tfourth"\tthe border is \\"done\\""',
  'T\te\tb\t2026-10-20T13:04:00Z\te9\tfifth"\tfifth reply"',
  'T\tf\te\t2026-10-20T13:05:00Z\tf9\tsixth"\tsixth reply"',
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
    .filter(button => /^[a-f]$/.test(String(button.key)))
    .map(button => button.text)

test('the tree draws every branch under the prompt it grew from, and marks where the session stands', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })

  expect((await ui.find({ key: 'tree-toggle' }))?.text).toBe('● tree')
  // Each row: the lanes, then the turn number on the conversation's prompts or
  // a circle on a branch a rewind left, then the prompt. At b the newer branch,
  // e, carries on down the lane and the older one sticks out.
  expect(await rows(ui)).toEqual([
    '1 first',
    '2 second',
    '├─○ third',
    '│ ○ fourth',
    '3 fifth',
    '4 sixth',
  ])
  const here = await ui.find({ type: 'Text', text: 'sixth' })
  expect(here?.props).toEqual(expect.objectContaining({ color: 'claude', bold: true }))
  expect((await ui.find({ type: 'Text', text: '4 ' }))?.props).toEqual({ color: 'claude', bold: true })
  // The path runs on down the lane past the old branch: lit; the branch's own
  // line is not.
  expect((await ui.find({ type: 'Text', text: /^├$/ }))?.props).toEqual({ color: 'claude' })
  expect((await ui.find({ type: 'Text', text: /^─$/ }))?.props).toEqual({ dimColor: true })
  expect((await ui.find({ type: 'Text', text: /^│ $/ }))?.props).toEqual({ color: 'claude' })
  expect((await ui.find({ type: 'Text', text: /← here/ }))?.text).toBe('    ← here')
  expect(await ui.findAll({ type: 'Text', text: /← here/ })).toHaveLength(1)
  expect((await ui.find({ type: 'Text', text: 'third' }))?.props).toEqual({ dimColor: true })
  await ui.unmount()
})

test('a switch moves the numbers and the lit lines, never the rows', async ($, on) => {
  engine(on, undefined, ['H\td', ...SCAN.slice(1)])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })

  // The same rows as when the session stood at f: now d is turn 4, and the
  // path turns off the lane into the old branch.
  expect(await rows(ui)).toEqual([
    '1 first',
    '2 second',
    '├─3 third',
    '│ 4 fourth',
    '○ fifth',
    '○ sixth',
  ])
  expect((await ui.find({ type: 'Text', text: /^├$/ }))?.props).toEqual({ color: 'claude' })
  expect((await ui.find({ type: 'Text', text: /^─$/ }))?.props).toEqual({ color: 'claude' })
  expect((await ui.find({ type: 'Text', text: /^│ $/ }))?.props).toEqual({ dimColor: true })
  await ui.unmount()
})

test('after a rewind, the prompts past where the session stands stay where they were', async ($, on) => {
  engine(on, undefined, ['H\tb', ...SCAN.slice(1)])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })

  expect(await rows(ui)).toEqual(['1 first', '2 second', '├─○ third', '│ ○ fourth', '○ fifth', '○ sixth'])
  expect((await ui.find({ type: 'Text', text: '2 ' }))?.props).toEqual({ color: 'claude', bold: true })
  await ui.unmount()
})

test('a prompt on an abandoned branch opens a card with its reply', async ($, on) => {
  const { toasts } = engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tree-toggle' })

  await ui.press({ key: 'd' })
  expect(await ui.find({ type: 'Text', text: 'the border is "done"' })).toBeDefined()
  expect((await ui.find({ key: 'switch:d' }))?.text).toBe('↪ continue from here')
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

  expect((await ui.find({ key: 'tree-toggle' }))?.text).toBe('○ tree')
  expect(await rows(ui)).toEqual([])
  await ui.unmount()
})
