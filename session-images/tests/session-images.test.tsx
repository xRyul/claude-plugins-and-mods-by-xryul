import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'session-images',
  component: 'Pane',
  requestId: 'session-images',
  props: {
    title: 'Images',
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
function files(on: Parameters<TestBody>[1], mtimeMs: number, onOpen = () => {}) {
  on('ui.open', () => {
    onOpen()

    return { value: { isPlaced: true } }
  })
  on('clock.now', () => ({ value: 1_000_000 }))
  on('fs.stat', (_, e) => ({
    value: { kind: 'file', size: 24, mtimeMs, isLink: false, realPath: e.path },
  }))
  on('fs.read', () => ({ value: { base64: PNG_HEADER } }))
  on('env.get', () => ({ value: '/home/me' }))
  on('session.cwd', () => ({ value: '/work' }))
}

test('the pane lists pasted and created images, on every surface', async ($, on) => {
  let opened = 0
  files(on, 1_000_500, () => (opened += 1))
  // The pasted folder also holds an image whose line a compaction dropped.
  on('fs.list', (_, e) => ({
    value: e.path === FOLDER ? [entry('1.png'), entry('3.png'), entry('notes.txt')] : [],
  }))
  on('tool.call', () => ({ result: {}, text: 'Saved the chart to out/chart.png' }))

  await $.session.append(pastedRow(PASTED))
  await $.tool.call({ tool: 'Bash', command: 'python plot.py' })

  expect(opened).toBe(1)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    const rows = (await ui.findAll({ type: 'Button' })).map(button => button.text)
    // Newest first, each row its time and pixel size, Open at the right edge.
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatch(/^Image #3 {2}\d\d:\d\d {2}542×624 +Open$/)
    expect(rows[1]).toMatch(/^Image #1 /)
    expect(rows[2]).toMatch(/^chart\.png {2}\d\d:\d\d {2}542×624 +Open$/)
    expect(rows.every(text => text?.length === 39)).toBe(true)
    await ui.unmount()
  }
})

test('an image the call did not write is not listed as created', async ($, on) => {
  files(on, 5)
  on('tool.call', () => ({ result: {}, text: 'old.png' }))

  await $.tool.call({ tool: 'Read', file_path: '/work/old.png' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Claude saves/ }))?.text).toBe(
    'Image files Claude saves while working show up here.',
  )
  await ui.unmount()
})

test('a long group shows the newest eight until asked for more', async ($, on) => {
  files(on, 1_000_500)
  on('fs.list', () => ({ value: [] }))

  const paths = Array.from({ length: 10 }, (_, i) => `${FOLDER}/${i + 1}.png`)
  await $.session.append(pastedRow(...paths))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const opens = async () => (await ui.findAll({ type: 'Button', text: /Open$/ })).length
  expect(await opens()).toBe(8)
  expect((await ui.find({ key: 'more:user' }))?.text).toBe('Show 2 more')

  await ui.press({ key: 'more:user' })
  expect(await opens()).toBe(10)
  expect((await ui.find({ key: 'more:user' }))?.text).toBe('Show fewer')
  await ui.unmount()
})

test('Open hands the Windows path to explorer.exe', async ($, on) => {
  const ran: (readonly string[])[] = []
  const toasts: string[] = []
  files(on, 1_000_500)
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_, e) => {
    ran.push(e.argv)
    const stdout = e.argv[0] === '/usr/bin/wslpath' ? `${WINDOWS_PATH}\n` : ''

    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  await $.session.append(pastedRow(PASTED))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `open:${PASTED}` })

  expect(ran).toEqual([
    ['/usr/bin/wslpath', '-w', PASTED],
    ['/mnt/c/Windows/explorer.exe', WINDOWS_PATH],
  ])
  expect(toasts).toEqual(['Opened 3.png'])
  await ui.unmount()
})
