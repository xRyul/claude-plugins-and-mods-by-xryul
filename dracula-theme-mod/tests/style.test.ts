import type { On, SessionMessage } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'dracula-theme-mod'

// Ends a turn whose final reply is text, so a reply with that text draws at full strength
async function finishTurn($: Engine, on: On, text: string) {
  mock.clock(on, { now: 0 })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: text, durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
}

test('a call result stays hidden until its card is clicked, then shows inside the card', async $ => {
  const output = { stdout: 'file-a\nfile-b', stderr: '', interrupted: false }
  const row = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'call-1',
    props: {
      tool_use_id: 'call-1',
      tool: 'Bash',
      input: { command: 'ls -la\necho done' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output,
    },
  })
  const result = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'call-1',
    props: { tool_use_id: 'call-1', tool: 'Bash', output, isErrored: false },
  })

  expect((await row.find({ key: 'head' }))?.text).toContain('Bash ls -la (+1 lines)')
  expect(JSON.stringify(await row.drawn())).not.toContain('file-a')

  await row.press({ key: 'head' })
  expect(JSON.stringify(await row.drawn())).toContain('file-a\\nfile-b')
  // Claude Code's own result row stays empty: the card holds the result
  expect(JSON.stringify(await result.drawn())).not.toContain('file-a')

  await row.press({ key: 'head' })
  expect(JSON.stringify(await row.drawn())).not.toContain('file-a')
  await result.unmount()
  await row.unmount()
})

test('an opened edit shows its diff inside the card', async $ => {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'edit-2',
    props: {
      tool_use_id: 'edit-2',
      tool: 'Edit',
      input: { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' },
      output: {
        filePath: '/p/a.ts',
        oldString: 'a',
        newString: 'b',
        originalFile: 'a\n',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
        userModified: false,
        replaceAll: false,
      },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  })

  expect(JSON.stringify(await ui.drawn())).not.toContain('@@')
  await ui.press({ key: 'head' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('@@ -1,1 +1,1 @@\\n-a\\n+b')
  expect(drawn).toContain('"format":"diff"')
  await ui.unmount()
})

test('a finished group opens into its cards from its summary line', async ($, on) => {
  // Stands in for Claude Code drawing the group's rows
  on('ui.render', () => ({ type: 'engine', ref: 1 }) as never)
  const call = (id: string, tool: string, input: Record<string, unknown>) => ({
    tool_use_id: id,
    tool,
    input,
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
  })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      calls: [call('w1', 'Write', { file_path: '/p/routes.html', content: '' }), call('a1', 'Artifact', { action: 'quickstart' })],
      isActive: false,
      isExpanded: false,
    },
  })

  expect((await ui.find({ key: 'group' }))?.text).toBe('Wrote 1 file, used Artifact')
  expect(JSON.stringify(await ui.drawn())).not.toContain('"engine"')

  await ui.press({ key: 'group' })
  expect((await ui.find({ key: 'group' }))?.text).toBe('Wrote 1 file, used Artifact ▾')
  expect(JSON.stringify(await ui.drawn())).toContain('"engine"')
  await ui.unmount()
})

test('an edit from an earlier turn is one italic line that opens into its card', async $ => {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'edit-1',
    props: {
      tool_use_id: 'edit-1',
      tool: 'Edit',
      input: { file_path: '/home/me/project/tests/style.test.ts', old_string: 'a', new_string: 'b' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  })

  expect((await ui.find({ key: 'head' }))?.text).toBe('Edited style.test.ts')

  await ui.press({ key: 'head' })
  expect((await ui.find({ key: 'head' }))?.text).toBe('Edit /home/me/project/tests/style.test.ts')
  await ui.unmount()
})

test('back-to-back file changes fold into one line that opens into their closed cards', async ($, on) => {
  const edit = (id: string, file: string) => ({
    tool_use_id: id,
    tool: 'Edit',
    input: { file_path: file },
    output: {
      filePath: file,
      structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-old', '+new'] }],
    },
  })
  mock.clock(on, { now: 0 })
  on('turn.complete', () => ({ text: '' }))
  const messages: SessionMessage[] = [
    { role: 'user', text: 'go', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [edit('e1', '/p/index.d.ts')] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'e1', text: 'ok', isError: false }] },
    { role: 'assistant', text: '', toolUses: [edit('e2', '/p/register.tsx'), edit('e3', '/p/register.tsx')] },
    { role: 'assistant', text: 'Done.', toolUses: [] },
  ]
  on('session.messages', () => ({ value: messages }))
  await $.turn.complete({ answer: 'Done.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })

  const mountEdit = (id: string, file: string) =>
    $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolUse',
      requestId: id,
      props: { ...edit(id, file), isRunning: false, isErrored: false, isInterrupted: false },
    })
  const firstRow = await mountEdit('e1', '/p/index.d.ts')
  const secondRow = await mountEdit('e2', '/p/register.tsx')

  expect((await firstRow.find({ key: 'run' }))?.text).toBe('Edited index.d.ts, register.tsx (3 changes)')
  expect(JSON.stringify(await secondRow.drawn())).not.toContain('Edited')

  await firstRow.press({ key: 'run' })
  expect((await firstRow.find({ key: 'run' }))?.text).toBe('Edited index.d.ts, register.tsx (3 changes) ▾')
  // Each change is its own card, closed and set in under the summary
  expect((await firstRow.find({ key: 'head' }))?.text).toBe('Edit /p/index.d.ts')
  expect((await secondRow.find({ key: 'head' }))?.text).toBe('Edit /p/register.tsx')
  expect(JSON.stringify(await secondRow.drawn())).toContain('"paddingLeft":4')
  expect(JSON.stringify(await secondRow.drawn())).not.toContain('@@')

  await secondRow.press({ key: 'head' })
  expect(JSON.stringify(await secondRow.drawn())).toContain('@@ -3,1 +3,1 @@\\n-old\\n+new')
  await secondRow.unmount()
  await firstRow.unmount()
})

test('a finished group folds into an italic summary', async $ => {
  const call = (id: string, isErrored: boolean) => ({
    tool_use_id: id,
    tool: 'Bash',
    input: { command: 'true' },
    isRunning: false,
    isErrored,
    isInterrupted: false,
  })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolGroup',
    props: { calls: [call('a', false), call('b', true), call('c', false)], isActive: false, isExpanded: false },
  })

  expect(JSON.stringify(await ui.drawn())).toContain('Ran 3 shell commands')
  expect(JSON.stringify(await ui.drawn())).toContain(' · 1 failed')
  await ui.unmount()
})

test('a reply draws inline code as a pill and hands other blocks to Markdown', async $ => {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AssistantMessage',
    props: {
      isFirstOfReply: true,
      text: [
        'The bar uses `userMessageBackground`, see **the theme** and https://claude.ai.',
        '',
        '- **Theme:** set `inactive`',
        '- plain item',
        '',
        '| a | b |',
        '| - | - |',
        '| `x` | y |',
        '',
        '```ts',
        'const a = 1',
        '```',
      ].join('\n'),
    },
  })

  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('\u00a0userMessageBackground\u00a0')
  expect(drawn).toContain('#363848')
  expect(drawn).toContain('const a = 1')
  await ui.unmount()
})

test('a reply draws each heading level in its own colour after a dim level mark', async ($, on) => {
  const text = ['# Transcript style mod', '', '## The `ToolGroup` hook', '', '### Files changed'].join('\n')
  await finishTurn($, on, text)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { isFirstOfReply: true, text },
  })

  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('# ')
  expect(drawn).toContain('### ')
  expect(drawn).toContain('Transcript style mod')
  expect(drawn).toContain('\u00a0ToolGroup\u00a0')
  expect(drawn).toContain('#ff79c6')
  expect(drawn).toContain('#bd93f9')
  expect(drawn).toContain('#f8f8f2')
  await ui.unmount()
})

test('a reply draws bold in orange, italic in yellow and tables with pills', async ($, on) => {
  const text = [
    'Customers in **Lithuania** pay by card. A failed *payment* retries, but \\*this\\* stays plain. ***Both*** at https://example.com.',
    '',
    '| Country | Method | Clears |',
    '| --- | :-: | --: |',
    '| Lithuania | **Card** | *instantly* |',
    '| Germany | `a|b` | in `2` days |',
  ].join('\n')
  await finishTurn($, on, text)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AssistantMessage',
    viewport: { columns: 120, rows: 40 },
    props: { isFirstOfReply: true, text },
  })

  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('#ffb86c')
  expect(drawn).toContain('#f1fa8c')
  expect(drawn).toContain('retries, but *this* stays plain.')
  expect(drawn).toContain('┌')
  expect(drawn).toContain('\u00a0a|b\u00a0')
  expect(drawn).toContain('"weight":"bold","italic":true,"color":"#ffb86c"},"children":["Both"]')
  expect(drawn).not.toContain('"Link"')
  expect(drawn).not.toContain('"Markdown"')
  await ui.unmount()

  // Wider than the pane: the mod wraps the cells to fit inside the final reply's frame
  const wrapped = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AssistantMessage',
    viewport: { columns: 30, rows: 40 },
    props: { isFirstOfReply: true, text },
  })
  const wrappedDrawn = JSON.stringify(await wrapped.drawn())
  expect(wrappedDrawn).toContain('┌')
  expect(wrappedDrawn).toContain('│ Lith │')
  expect(wrappedDrawn).not.toContain('"Markdown"')
  await wrapped.unmount()

  // Too narrow to give each column a few cells: the engine draws it
  const narrow = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AssistantMessage',
    viewport: { columns: 16, rows: 40 },
    props: { isFirstOfReply: true, text },
  })
  expect(JSON.stringify(await narrow.drawn())).toContain('"Markdown"')
  await narrow.unmount()
})

test('a table with symbols is the mod\'s, and one with emoji is the engine\'s', async $ => {
  const mountTable = async (rows: string[]) => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AssistantMessage',
      viewport: { columns: 120, rows: 40 },
      props: { isFirstOfReply: true, text: ['| Rule | Result |', '| --- | --- |', ...rows].join('\n') },
    })
    const drawn = JSON.stringify(await ui.drawn())
    await ui.unmount()
    return drawn
  }

  const symbols = await mountTable(['| `new` ≠ 1 → redirect… | £5 · 10° ± 2 |'])
  expect(symbols).toContain('┌')
  expect(symbols).not.toContain('"Markdown"')

  expect(await mountTable(['| ✅ | **done** |'])).toContain('"Markdown"')
  expect(await mountTable(['| 结账 | done |'])).toContain('"Markdown"')
})

test('the turn line shows when the turn finished', async ($, on) => {
  // 1:14 PM on 17 October 2026 in a UTC+1 time zone
  mock.clock(on, { now: Date.UTC(2026, 9, 17, 12, 14) })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 36000, isAborted: false, turnId: 't1', reason: 'answer' })

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'TurnDuration',
    props: { word: 'Cooked', durationMs: 36000 },
  })

  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Cooked for 36s · done 1:14 PM')
  // Dimmed orange
  expect(drawn).toContain('#947151')
  await ui.unmount()
})

async function mountReply($: Engine, text: string) {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AssistantMessage',
    viewport: { columns: 120, rows: 40 },
    props: { isFirstOfReply: true, text },
  })
  const drawn = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return drawn
}

test('a turn\'s final reply is drawn in a faint frame, and text between tool calls is not', async ($, on) => {
  await finishTurn($, on, 'All done.\n')

  const final = await mountReply($, 'All done.')
  expect(final).toContain('"borderStyle":"round"')
  expect(final).toContain('#44475a')
  expect(await mountReply($, 'Now checking the types.')).not.toContain('borderStyle')
})

test('replies before the final one are dimmed, keeping their colours\' hue', async ($, on) => {
  await finishTurn($, on, 'Done: **types** in `a.ts`.')

  // Halfway to the background: #f8f8f2 text, #ffb86c bold and #ec7e7e code
  const interim = await mountReply($, 'Checking **types** in `a.ts`.')
  expect(interim).toContain('#909194')
  expect(interim).toContain('#947151')
  expect(interim).toContain('#8a545a')

  const final = await mountReply($, 'Done: **types** in `a.ts`.')
  expect(final).toContain('#ffb86c')
  expect(final).toContain('#ec7e7e')
  expect(final).not.toContain('#909194')

  // A summary of the text between tool calls is drawn by the mod, dimmed, not by Claude Code
  const summary = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { isFirstOfReply: false, isSummary: true, text: 'Checked the types.' },
  })
  expect(JSON.stringify(await summary.drawn())).toContain('#909194')
  await summary.unmount()
})

test('a tool row\'s name is dimmed', async $ => {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'grep-1',
    props: { tool_use_id: 'grep-1', tool: 'Grep', input: { pattern: 'x' }, isRunning: false, isErrored: false, isInterrupted: false },
  })
  expect(JSON.stringify(await ui.drawn())).toContain('#94527e')
  await ui.unmount()
})

test('a resumed session frames the final reply of each earlier turn', async ($, on) => {
  const messages: SessionMessage[] = [
    { role: 'user', text: 'first', toolUses: [] },
    { role: 'assistant', text: 'Looking.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/p/a.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: 'ok', isError: false }] },
    { role: 'assistant', text: 'First answer.', toolUses: [] },
    { role: 'user', text: 'second', toolUses: [] },
    { role: 'assistant', text: 'Second answer.', toolUses: [] },
  ]
  on('session.messages', () => ({ value: messages }))
  on('session.start', () => ({ cwd: '/p' }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  expect(await mountReply($, 'First answer.')).toContain('"borderStyle":"round"')
  expect(await mountReply($, 'Second answer.')).toContain('"borderStyle":"round"')
  expect(await mountReply($, 'Looking.')).not.toContain('borderStyle')
})

test('a session resumed in place, as the timeline jumps, frames its final replies', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  let messages: SessionMessage[] = [
    { role: 'user', text: 'first', toolUses: [] },
    { role: 'assistant', text: 'Answer before the jump.', toolUses: [] },
  ]
  on('session.messages', () => ({ value: messages }))
  on('session.start', () => ({ cwd: '/p' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  // No session.start follows a resume, and the new transcript lands a moment after it ends
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(250)
  messages = [
    { role: 'user', text: 'other', toolUses: [] },
    { role: 'assistant', text: 'Checking.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/p/a.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: 'ok', isError: false }] },
    { role: 'assistant', text: 'Answer on the other branch.', toolUses: [] },
  ]
  await clock.advance(250)

  expect(await mountReply($, 'Answer on the other branch.')).toContain('"borderStyle":"round"')
  expect(await mountReply($, 'Checking.')).not.toContain('borderStyle')
  expect(await mountReply($, 'Answer before the jump.')).not.toContain('borderStyle')
})
