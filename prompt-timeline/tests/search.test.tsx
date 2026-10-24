import type { On, SessionAppendInput } from 'claude-code'
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

const prompt = (uuid: string, text: string): SessionAppendInput => ({
  uuid,
  door: 'prompt',
  origin: { kind: 'composer' },
  message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
})

// The engine beneath the plugin, as far as these tests reach it. The kit's
// drawing answers the pane's scrolls and focus moves itself, unrecorded, and
// cannot scroll a transcript: a jump says so in a toast.
const engine = (on: On, env: Record<string, string> = {}) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T14:00:00Z') })
  mock.store(on)
  mock.env(on, env)
  mock.session(on)
  on('command.register', () => ({ value: { command: 'timeline' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return { clock }
}

type Drawing = {
  find: (q: { type?: string; key?: string }) => Promise<{ key?: unknown } | undefined>
  input: (target: { key: string; text: string; kind?: 'change' | 'submit' }) => Promise<unknown>
}

// The search field: found by its type, as its key is new each time it opens.
const field = async (ui: Drawing) => (await ui.find({ type: 'Input' }))?.key as string | undefined
const type = async (ui: Drawing, text: string, kind?: 'change') =>
  ui.input({ key: (await field(ui))!, text, kind })

const rows = async (ui: { findAll: (q: { type: 'Button' }) => Promise<{ key?: unknown; text: string }[]> }) =>
  (await ui.findAll({ type: 'Button' }))
    .filter(button => /^u\d+$/.test(String(button.key)))
    .map(button => button.text)

test('find opens a field whose words filter the timeline once typing pauses', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append(prompt('u1', 'fix the overlay'))
  // The word sits far past the 200 characters the row keeps.
  await $.session.append(prompt('u2', `${'filler '.repeat(60)}the zebracorn bug\nin the pane`))
  await $.session.append(prompt('u3', 'now add the tests'))

  const keys: string[] = []
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'search-toggle' }))?.text).toBe('○ find')
    expect(await field(ui)).toBeUndefined()

    await ui.press({ key: 'search-toggle' })
    expect((await ui.find({ key: 'search-toggle' }))?.text).toBe('● find')
    expect(await field(ui)).toBeDefined()
    keys.push((await field(ui))!)

    // Each key alone filters nothing: the timeline waits for a pause.
    await type(ui, 'z', 'change')
    await type(ui, 'zebra', 'change')
    expect(await rows(ui)).toHaveLength(3)

    await clock.advance(150)
    // Its place in the timeline, then the words just before the match: the
    // text has 20 columns here, the match a third of the way along.
    expect(await rows(ui)).toEqual(['2  …er the zebracorn b…'])
    expect((await ui.find({ type: 'Text', text: 'zebra' }))?.props).toEqual(expect.objectContaining({ color: 'warning' }))
    expect(await ui.find({ type: 'Text', text: '1 of 3' })).toBeDefined()

    // Every word must match, in any case and order.
    await type(ui, 'THE pane', 'change')
    await clock.advance(150)
    expect(await rows(ui)).toHaveLength(1)

    await type(ui, 'the', 'change')
    await clock.advance(150)
    // Newest first.
    expect((await rows(ui)).map(text => text.slice(0, 1))).toEqual(['3', '2', '1'])

    // Enter searches at once.
    await type(ui, 'nothing like it')
    expect(await ui.find({ type: 'Text', text: /No prompt holds that/ })).toBeDefined()

    await ui.press({ key: 'search-toggle' })
    expect(await field(ui)).toBeUndefined()
    expect(await rows(ui)).toHaveLength(3)

    // Opened again, the field is a new one: the surface keeps a field's text
    // by its key, and none of the last search's carries over.
    const last = keys.at(-1)
    await ui.press({ key: 'search-toggle' })
    keys.push((await field(ui))!)
    expect(keys.at(-1)).not.toBe(last)
    await ui.press({ key: 'search-toggle' })
    await ui.unmount()
  }
})

test('a press on a match still picks its prompt', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append(prompt('u1', 'alpha'))
  await $.session.append(prompt('u2', 'beta'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'search-toggle' })
  await type(ui, 'alp', 'change')
  await clock.advance(150)
  await ui.press({ key: 'u1' })
  expect((await ui.find({ type: 'Text', text: /^ha$/ }))?.props).toEqual({ color: 'claude' })
  await ui.unmount()
})

test('a prompt sent while searching joins the matches', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append(prompt('u1', 'deploy the worker'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'search-toggle' })
  await type(ui, 'worker', 'change')
  await clock.advance(150)
  expect(await rows(ui)).toHaveLength(1)

  await $.session.append(prompt('u2', 'the worker crashed'))
  await $.session.append(prompt('u3', 'unrelated'))
  expect(await rows(ui)).toHaveLength(2)
  await ui.unmount()
})

test('a query matching more than a hundred prompts draws the newest hundred', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 1; i <= 130; i++) await $.session.append(prompt(`u${i}`, `step ${i} of the plan`))

  // Wide enough for the count of matches beside the header's controls.
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 52 }, surface: 'terminal' })
  await ui.press({ key: 'search-toggle' })
  await type(ui, 'plan')
  await clock.settle()
  const shown = await rows(ui)
  expect(shown).toHaveLength(100)
  expect(shown[0]).toMatch(/^130 /)
  expect(await ui.find({ type: 'Text', text: /30 older matches: add a word to narrow/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '130 of 130' })).toBeDefined()
  await ui.unmount()
})

test("an earlier prompt is searched by its whole text, as the transcript holds it", async ($, on) => {
  const { clock } = engine(on, { HOME: '/home/me' })
  const long = `${'lorem ipsum '.repeat(40)}the needle\\nis here`
  const scan = ['P\t3\th1\t2026-10-20T13:00:00Z\tshort one"', `P\t9\th2\t2026-10-20T13:05:00Z\t${long}"`]
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: true }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: scan.join('\n'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'search-toggle' })
  await type(ui, 'needle is', 'change')
  await clock.advance(150)
  const shown = (await ui.findAll({ type: 'Button' })).filter(button => /^h\d$/.test(String(button.key)))
  expect(shown.map(button => button.text)).toEqual(['2  …m the needle is he…'])
  await ui.unmount()
})

test('the header gives way as the dock narrows', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append(prompt('u1', 'one'))

  const at = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
    await ui.unmount()

    return { isNamed: texts.includes('Timeline'), isCounted: texts.includes('1 prompt') }
  }
  expect(await at(50)).toEqual({ isNamed: true, isCounted: true })
  expect(await at(42)).toEqual({ isNamed: false, isCounted: true })
  expect(await at(40)).toEqual({ isNamed: false, isCounted: false })
})
