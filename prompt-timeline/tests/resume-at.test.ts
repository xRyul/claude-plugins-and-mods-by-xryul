import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PROJECTS = '/home/me/.claude/projects'
const SESSIONS = '/home/me/.claude/sessions'
const D_END = 'd9000000-0000-4000-8000-000000000000'
const F_END = 'f9000000-0000-4000-8000-000000000000'

// Each session's message ids, as `grep` finds them in its transcript.
const MESSAGES: Record<string, string[]> = {
  [`${PROJECTS}/-work/s1.jsonl`]: [D_END, F_END, 'd1000000-0000-4000-8000-000000000000'],
  [`${PROJECTS}/-other/s2.jsonl`]: [D_END, F_END],
}

// The tree scan's records: d's turn ends at D_END, f's at F_END.
const SCAN = [
  'H\tf',
  `T\td\tc\t2026-10-20T13:03:00Z\t${D_END}\tfourth"\tfourth reply"`,
  `T\tf\te\t2026-10-20T13:05:00Z\t${F_END}\tsixth"\tsixth reply"`,
]

// The engine beneath the plugin: transcripts for this session (s1) and one
// other (s2), a Claude Code process holding s2 open or not, a shell that
// appends, an awk that copies, and a `/resume` that takes or not.
const engine = (on: On, options: { holder?: number; resume?: () => Promise<unknown> } = {}) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T14:00:00Z') })
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  mock.session(on)
  const toasts: string[] = []
  const appended: { record: unknown; path: string }[] = []
  const copied: string[][] = []
  const commands: string[] = []
  const registered: string[] = []
  on('command.register', (_, e) => (registered.push(e.name), { value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value:
      e.path === PROJECTS
        ? [
            { name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
            { name: '-other', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
          ]
        : Object.keys(MESSAGES)
            .filter(path => path.startsWith(`${e.path}/`))
            .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', () => ({ value: JSON.stringify({ pid: options.holder ?? 0, sessionId: 's2', jobId: 'j1' }) }))
  on('process.run', (_, e) => {
    const [command, ...args] = e.argv
    let stdout = ''
    let exitCode = 0
    if (command === 'awk' && args[0] === '-v') copied.push([...args])
    else if (command === 'awk' && args[0]!.includes('last-prompt')) stdout = SCAN.join('\n')
    else if (command === 'grep' && args[0] === '-o') {
      const prefix = args[2]!.slice('"uuid":"'.length, -'[0-9a-f-]*"'.length)
      stdout = (MESSAGES[args[3]!] ?? [])
        .filter(id => id.startsWith(prefix))
        .map(id => `"uuid":"${id}"`)
        .join('\n')
    } else if (command === 'grep' && args[0] === '-l') {
      stdout = options.holder !== undefined && args[3] === '"sessionId":"s2"' ? `${SESSIONS}/${options.holder}.json` : ''
    } else if (command === 'kill') exitCode = args[1] === String(options.holder) ? 0 : 1
    else if (command === 'sh') appended.push({ record: JSON.parse(args[3]!), path: args[4]! })

    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', async (_, e) => {
    commands.push(`/${e.command} ${e.args}`)
    await options.resume?.()

    return {}
  })

  return { clock, toasts, appended, copied, commands, registered }
}

const resumed = (id: string) => ({ reason: 'resume' as const, sessionId: id, resume: { id } })

// `/resume-at <args>` as the person types it.
const typed = (args: string) => ({
  command: 'resume-at',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
})

// A session with no pane to open, so nothing outlives a test.
const START = { cwd: '/work', surface: 'terminal', isInteractive: false } as const

test('/resume-at is a command of its own', async ($, on) => {
  const { registered } = engine(on)
  await $.session.start(START)

  expect(registered).toContain('resume-at')
})

test('/resume-at in this session points it at the message and resumes it', async ($, on) => {
  const { clock, appended, commands, toasts } = engine(on, { resume: () => $.session.end(resumed('s1')) })
  await $.session.start(START)

  expect((await $.command.run(typed('d9'))).text).toBe('Opening session s1 at message d9000000.')
  // `/resume` runs once the command has answered.
  expect(commands).toEqual([])
  await clock.settle()
  expect(appended).toEqual([
    {
      path: `${PROJECTS}/-work/s1.jsonl`,
      record: { type: 'last-prompt', lastPrompt: 'fourth', leafUuid: D_END, explicit: true, sessionId: 's1' },
    },
  ])
  expect(commands).toEqual(['/resume s1'])
  expect(toasts).toEqual([])
})

test('another session no window holds is pointed in place, wherever its project is', async ($, on) => {
  const { clock, appended, copied, commands } = engine(on, { resume: () => $.session.end(resumed('s2')) })
  await $.session.start(START)

  await $.command.run(typed('s2:f9'))
  await clock.settle()
  expect(copied).toEqual([])
  expect(appended.map(one => one.path)).toEqual([`${PROJECTS}/-other/s2.jsonl`])
  expect(appended[0]!.record).toEqual(expect.objectContaining({ leafUuid: F_END, sessionId: 's2' }))
  expect(commands).toEqual(['/resume s2'])
})

test('a session another window holds is copied, every branch, and the copy opens', async ($, on) => {
  const { clock, appended, copied, commands, toasts } = engine(on, {
    holder: 77,
    resume: () => $.session.end(resumed('copy')),
  })
  await $.session.start(START)

  const said = (await $.command.run(typed('s2:f9'))).text
  await clock.settle()
  expect(copied).toHaveLength(1)
  const [, from, , to, , dst, , source] = copied[0]!
  const copyId = to!.slice('to="sessionId":"'.length, -1)
  expect(copyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect([from, dst, source]).toEqual([
    'from="sessionId":"s2"',
    `dst=${PROJECTS}/-other/${copyId}.jsonl`,
    `${PROJECTS}/-other/s2.jsonl`,
  ])
  // The original is never written to; the copy is pointed at the message.
  expect(appended).toEqual([
    {
      path: `${PROJECTS}/-other/${copyId}.jsonl`,
      record: { type: 'last-prompt', lastPrompt: 'sixth', leafUuid: F_END, explicit: true, sessionId: copyId },
    },
  ])
  expect(said).toBe(`Opening session ${copyId} at message f9000000, a copy of session s2.`)
  expect(commands).toEqual([`/resume ${copyId}`])
  expect(toasts).toEqual(['Session s2 is open in another window, so this is a copy of it. To open it there: claude attach j1'])
})

test('--copy copies a session no window holds', async ($, on) => {
  const { clock, appended, copied } = engine(on, { resume: () => $.session.end(resumed('copy')) })
  await $.session.start(START)

  await $.command.run(typed('--copy s2:d9'))
  await clock.settle()
  expect(copied).toHaveLength(1)
  expect(appended[0]!.path).not.toBe(`${PROJECTS}/-other/s2.jsonl`)
})

test('a resume that does not take says how to open the session', async ($, on) => {
  const { clock, appended, toasts } = engine(on)
  await $.session.start(START)

  await $.command.run(typed('s2:d9'))
  await clock.settle()
  expect(toasts).toEqual(['Session s2 is set to open at that message: run claude --resume s2 in its project folder.'])
  expect(appended).toHaveLength(1)
})

test('ids it cannot place are named, and nothing is written', async ($, on) => {
  const { appended, commands } = engine(on)
  await $.session.start(START)

  const run = async (args: string) => (await $.command.run(typed(args))).text
  expect(await run('')).toMatch(/^Usage: \/resume-at/)
  expect(await run('s2:not-hex!')).toMatch(/^Usage: \/resume-at/)
  expect(await run('99:d9')).toBe("No session's id starts with 99.")
  expect(await run('s2:ab')).toBe('No message in session s2 has an id starting with ab.')
  expect(await run('d')).toBe('2 messages in session s1 have ids starting with d: give more of the id.')
  expect(appended).toEqual([])
  expect(commands).toEqual([])
})
