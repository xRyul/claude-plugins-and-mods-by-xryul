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

test('the person\'s prompts are listed, and a press marks the one picked', async ($, on) => {
  // Nothing sits beneath the plugin: each hook here stands for the engine.
  // The kit does not answer `$.ui.scroll`: the press still marks its row and
  // says why the transcript did not move.
  const toasts: string[] = []
  mock.clock(on, { now: Date.parse('2026-10-20T14:00:00Z') })
  mock.store(on)
  mock.env(on, {})
  mock.session(on)
  on('command.register', () => ({ value: { command: 'timeline' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append(prompt('u1', 'fix the overlay\nand more'))
  await $.session.append({
    ...prompt('u2', 'a reminder'),
    message: { ...prompt('u2', '').message, isMeta: true },
  })
  await $.session.append(prompt('u3', 'now add the tests'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ key: 'u1' }))?.text).toBe('1  fix the overlay and…')
    expect(await ui.find({ key: 'u2' })).toBeUndefined()
    expect((await ui.find({ key: 'u3' }))?.text).toContain('now add the tests')
    expect(await ui.find({ type: 'Text', text: /just now/ })).toBeDefined()

    await ui.press({ key: 'u3' })
    const picked = await ui.find({ type: 'Text', text: /now add the tests/ })
    expect(picked?.props).toEqual(expect.objectContaining({ color: 'claude', bold: true }))
    await ui.unmount()
  }

  expect(toasts[0]).toContain("Couldn't scroll to that prompt")
})

// The engine beneath the plugin, as far as these tests reach it.
const engine = (on: On) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T14:00:00Z') })
  mock.store(on)
  mock.session(on)
  on('command.register', () => ({ value: { command: 'timeline' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return { clock }
}

test('a long prompt is cut to fit beside its context and age', async ($, on) => {
  engine(on)
  mock.env(on, {})
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append(prompt('u1', 'word '.repeat(40)))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // 40 columns less the padding: the number, the text, then 4 for the context
  // and 8 for the age, two spaces before each.
  expect((await ui.find({ key: 'u1' }))?.text).toBe('1  word word word word…')
  expect((await ui.find({ type: 'Text', text: /just now/ }))?.text).toBe('  just now')
  await ui.unmount()
})

test('the ctx button hides and shows the context column', async ($, on) => {
  engine(on)
  mock.env(on, {})
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append(prompt('u1', 'word '.repeat(40)))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'context' }))?.text).toBe('● ctx')

  await ui.press({ key: 'context' })
  expect((await ui.find({ key: 'context' }))?.text).toBe('○ ctx')
  // The text takes the column's room.
  expect((await ui.find({ key: 'u1' }))?.text).toBe('1  word word word word word…')
  expect((await ui.find({ type: 'Text', text: /just now/ }))?.text).toBe('just now')

  await ui.press({ key: 'context' })
  expect((await ui.find({ key: 'context' }))?.text).toBe('● ctx')
  await ui.unmount()
})

test("an earlier prompt's context is read from its first response in the transcript", async ($, on) => {
  const { clock } = engine(on)
  mock.env(on, { HOME: '/home/me' })
  // The scan's records: h1's response is 20,002 tokens into 200,000, h2's
  // 150,000; h3 has none. h2's text was cut mid-escape, h3's is an escape.
  const scan = [
    'P\t3\th1\t2026-10-20T13:00:00Z\tfirst\\nline"},"uuid":"h1"',
    'R\t5\t20002',
    'P\t9\th2\t2026-10-20T13:05:00Z\tsecond \\u00e9 cut here \\u00',
    'R\t12\t150000',
    'P\t20\th3\t2026-10-20T13:10:00Z\t\\"quoted\\""}',
  ]
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: true }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: e.argv[0] === 'awk' ? 0 : 2,
      stdout: scan.join('\n'),
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  // The scan runs unawaited at start.
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 }, surface: 'terminal' })
  expect((await ui.find({ key: 'h1' }))?.text).toBe('1  first line')
  expect((await ui.find({ key: 'h2' }))?.text).toBe('2  second é cut here…')
  expect((await ui.find({ key: 'h3' }))?.text).toBe('3  "quoted"')
  expect((await ui.find({ type: 'Text', text: /^ +10%$/ }))?.props).toEqual({ dimColor: true })
  expect((await ui.find({ type: 'Text', text: /^ +75%$/ }))?.props).toEqual({ color: 'warning' })
  await ui.unmount()
})

test("a live prompt's context is the usage of the first response that carried it", async ($, on) => {
  engine(on)
  mock.env(on, {})
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  const usage = { input_tokens: 2, cache_creation_input_tokens: 4998, cache_read_input_tokens: 445_000 }
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { ...usage, output_tokens: 10, model: 'm' },
    }
  })
  const step = async (agentId?: string) => {
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId })) {
      // The bottom streams nothing; the result is what counts.
    }
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append(prompt('u1', 'first'))
  // A subagent's step carries none of main's prompts.
  await step('agent-1')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()

  await step()
  expect((await ui.find({ type: 'Text', text: /%/ }))?.text).toBe(' 45%')

  // A later response leaves the figure where the first one set it.
  usage.cache_read_input_tokens = 900_000
  await step()
  expect((await ui.find({ type: 'Text', text: /%/ }))?.text).toBe(' 45%')
  await ui.unmount()
})
