import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ImageGroup, SessionImage } from '../types'

const PANE = 'session-images'
const TITLE = 'Images'
const EXPLORER = '/mnt/c/Windows/explorer.exe'
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?|ico|heic)$/i
// The engine stores each pasted image as a file and records its path in the
// conversation as this line.
const PASTED_SOURCE = /\[Image: source: ([^\]\n]+)\]/g
// A tool call's text is searched up to this length, for this many paths.
const MAX_TEXT = 200_000
const MAX_PATHS = 100
// Headers are read from files up to this size, in their first 256 KiB.
const MAX_HEADER_FILE = 32 * 1024 * 1024
const HEADER_BASE64 = 349_524
// Rows a group shows before "Show more".
const LIMIT = 8
const OPEN = 'Open'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Change the tag when SessionImage's fields change: it declines what an
// earlier version stored, which outlives a reload.
const images = atom({ plugin: 'session-images', key: 'images' } as const, [], {
  shape: 'images-2',
})
const hasAutoOpened = atom(
  { plugin: 'session-images', key: 'hasAutoOpened' } as const,
  false,
)
const showAll = atom({ plugin: 'session-images', key: 'showAll' } as const, {
  user: false,
  claude: false,
})

type Found = { path: string; source: ImageGroup }
type Block = { type: string; [field: string]: unknown }

function basename(path: string) {
  return path.slice(path.lastIndexOf('/') + 1)
}

function dirname(path: string) {
  return path.slice(0, path.lastIndexOf('/')) || '/'
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

function imageTokens(texts: readonly string[]) {
  const tokens = new Set<string>()
  for (const text of texts) {
    for (const raw of text.slice(0, MAX_TEXT).split(/[\s"'`<>()[\]{}|;,=]+/)) {
      const token = raw.replace(/[.:!?]+$/, '')
      if (IMAGE_EXTENSION.test(token) && !token.includes('://')) {
        tokens.add(token)
      }
    }
  }

  return [...tokens].slice(0, MAX_PATHS)
}

// The pixel size a PNG, GIF or JPEG header states.
function pixelSize(bytes: Uint8Array) {
  const at = (i: number) => bytes[i] ?? 0
  const u16 = (i: number) => (at(i) << 8) | at(i + 1)
  const u32 = (i: number) => ((u16(i) << 16) | u16(i + 2)) >>> 0

  if (at(0) === 0x89 && at(1) === 0x50) return { width: u32(16), height: u32(20) }
  if (at(0) === 0x47 && at(1) === 0x49) {
    return { width: at(6) | (at(7) << 8), height: at(8) | (at(9) << 8) }
  }
  if (at(0) === 0xff && at(1) === 0xd8) {
    // Walk the segments to the frame header (SOF0 to SOF15, less DHT, JPG, DAC).
    for (let i = 2; i + 9 < bytes.length && at(i) === 0xff; i += 2 + u16(i + 2)) {
      const marker = at(i + 1)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: u16(i + 7), height: u16(i + 5) }
      }
    }
  }

  return {}
}

async function describe($: EngineInterface, found: Found) {
  const stat = await $.fs.stat(found.path).catch(() => undefined)
  if (stat?.kind !== 'file') return undefined

  let size = {}
  if (stat.size <= MAX_HEADER_FILE) {
    const bytes = await $.fs.read(found.path, { as: 'bytes' }).catch(() => undefined)
    if (bytes) {
      const head = atob(bytes.base64.slice(0, HEADER_BASE64))
      size = pixelSize(Uint8Array.from(head, char => char.charCodeAt(0)))
    }
  }

  return { ...found, modifiedAt: stat.mtimeMs, ...size }
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

// The image files the texts name that were written at or after `since`.
async function findCreated(
  $: EngineInterface,
  texts: readonly string[],
  since: number,
) {
  const tokens = imageTokens(texts)
  if (tokens.length === 0) return []

  const home = (await $.env.get('HOME')) ?? ''
  const cwd = await $.session.cwd()
  const found: string[] = []
  for (const token of tokens) {
    const path = token.startsWith('~/')
      ? home + token.slice(1)
      : token.startsWith('/')
        ? token
        : `${cwd}/${token}`
    const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
    if (stat?.kind === 'file' && stat.mtimeMs >= since) {
      found.push(stat.realPath ?? path)
    }
  }

  return found
}

async function addImages($: EngineInterface, found: readonly Found[]) {
  const known = new Set((await read($, images)).map(image => image.path))
  const fresh = found.filter(image => {
    if (known.has(image.path)) return false
    known.add(image.path)

    return true
  })
  if (fresh.length === 0) return

  const described = await Promise.all(fresh.map(image => describe($, image)))
  const added = described.filter(image => image !== undefined)
  await update($, images, list => {
    const stored = new Set(list.map(image => image.path))

    return [...list, ...added.filter(image => !stored.has(image.path))]
  })

  if (!(await read($, hasAutoOpened))) {
    await update($, hasAutoOpened, () => true)
    void $.ui.open({ id: PANE, title: TITLE })
  }
}

// What the conversation already holds, for a session the mod joins midway.
async function backfill($: EngineInterface) {
  const messages = await $.session.messages({ as: 'api' })
  if (!Array.isArray(messages)) return

  const userTexts: string[] = []
  const toolTexts: string[] = []
  for (const message of messages) {
    if (message.role === 'user') userTexts.push(...textsOf(message.content))
    for (const block of message.content) {
      if (block.type === 'tool_use') stringsIn(block.input, toolTexts)
      if (block.type === 'tool_result') stringsIn(block.content, toolTexts)
    }
  }

  const { startedAt } = await $.session.usage()
  const pasted = await findPasted($, userTexts)
  const created = await findCreated($, toolTexts, startedAt)
  await addImages($, [
    ...pasted.map(path => ({ path, source: 'user' as const })),
    ...created.map(path => ({ path, source: 'claude' as const })),
  ])
}

async function openImage($: EngineInterface, path: string) {
  const name = basename(path)
  try {
    if (!(await $.fs.exists(path))) {
      $.ui.toast(`${name} no longer exists`)

      return
    }
    if (await $.fs.exists(EXPLORER)) {
      const { stdout } = await $.process.run(['/usr/bin/wslpath', '-w', path])
      // explorer.exe exits 1 even when it opened the file.
      await $.process.run([EXPLORER, stdout.trim()], {
        cwd: '/mnt/c',
        timeoutMs: 15_000,
      })
    } else {
      await $.process.run(['xdg-open', path], { timeoutMs: 15_000 })
    }
    $.ui.toast(`Opened ${name}`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    $.ui.toast(`Could not open ${name}: ${reason}`)
  }
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

function truncateMiddle(text: string, width: number) {
  if (text.length <= width) return text
  const head = Math.ceil((width - 1) / 2)

  return `${text.slice(0, head)}…${text.slice(text.length - (width - 1 - head))}`
}

// A row's name and details, cut to `room` columns: the pixel size goes first,
// then the time, then the name loses its middle.
function fitRow(name: string, details: readonly string[], room: number) {
  const kept = [...details]
  const length = () => name.length + (kept.length ? 2 + kept.join('  ').length : 0)
  while (kept.length > 0 && length() > room) kept.pop()

  return {
    name: truncateMiddle(name, room),
    detail: kept.length ? `  ${kept.join('  ')}` : '',
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'images',
      description: 'Show the images of this session in a pane',
    })
    await backfill($)

    return next(e)
  })

  on('command.run', { command: 'images' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Images pane opened.' }
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
      const created = await findCreated($, [...stringsIn(e), ran.text ?? ''], since)
      await addImages(
        $,
        created.map(path => ({ path, source: 'claude' as const })),
      )
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, images)
    const expanded = await read($, showAll)
    const now = await $.clock.now()
    // One column spare, so a full row never wraps at the frame's edge.
    const width = Math.max(20, e.props.bodyColumns - 1)

    const pasted = list
      .filter(image => image.source === 'user')
      .sort((a, b) => pastedNumber(b) - pastedNumber(a) || b.modifiedAt - a.modifiedAt)
    const created = list
      .filter(image => image.source === 'claude')
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
    const createdNames = created.map(image => basename(image.path))

    const labelOf = (image: SessionImage) => {
      if (image.source === 'user') {
        const number = pastedNumber(image)

        return number ? `Image #${number}` : basename(image.path)
      }
      const name = basename(image.path)
      const isShared = createdNames.filter(other => other === name).length > 1

      return isShared ? `${basename(dirname(image.path))}/${name}` : name
    }

    const row = (image: SessionImage) => {
      const details = [shortTime(image.modifiedAt, now)]
      if (image.width && image.height) details.push(`${image.width}×${image.height}`)
      const room = width - OPEN.length - 1
      const { name, detail } = fitRow(labelOf(image), details, room)
      const gap = ' '.repeat(Math.max(1, width - OPEN.length - name.length - detail.length))

      // The keyed Box is what the pointer hovers, lighting the whole row.
      return (
        <Box key={`row:${image.path}`}>
          <Button
            key={`open:${image.path}`}
            plain
            hover={{ inverse: true }}
            onPress={() => openImage($, image.path)}
          >
            {name}
            <Text dimColor>{detail}</Text>
            {gap}
            <Text color="claude">{OPEN}</Text>
          </Button>
        </Box>
      )
    }

    const group = (
      key: ImageGroup,
      title: string,
      items: readonly SessionImage[],
      empty: string,
    ) => {
      const isOpen = expanded[key]
      const shown = isOpen ? items : items.slice(0, LIMIT)

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" width={width}>
            <Text bold>{title}</Text>
            <Text dimColor>{String(items.length)}</Text>
          </Box>
          {items.length === 0 && <Text dimColor>{empty}</Text>}
          {shown.map(row)}
          {items.length > LIMIT && (
            <Box key={`more-row:${key}`}>
              <Button
                key={`more:${key}`}
                plain
                hover={{ underline: true }}
                onPress={() =>
                  update($, showAll, state => ({ ...state, [key]: !state[key] }))
                }
              >
                <Text dimColor>
                  {isOpen ? 'Show fewer' : `Show ${items.length - LIMIT} more`}
                </Text>
              </Button>
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        {group(
          'user',
          'Added by you',
          pasted,
          'Paste an image into the prompt to list it here.',
        )}
        {group(
          'claude',
          'Created by Claude',
          created,
          'Image files Claude saves while working show up here.',
        )}
      </Box>
    )
  })
}
