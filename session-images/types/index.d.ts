export type SessionImage = {
  path: string
  source: 'user' | 'claude'
  /** When the file was last written, milliseconds since the epoch. */
  modifiedAt: number
  /** Pixel size, read from a PNG, GIF or JPEG header. */
  width?: number
  height?: number
}

export type ImageGroup = SessionImage['source']

declare module 'claude-code' {
  interface PluginState {
    'session-images': {
      images: Shaped<SessionImage[]>
      hasAutoOpened: boolean
      showAll: Record<ImageGroup, boolean>
    }
  }
}
