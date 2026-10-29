export type SessionImage = {
  path: string
  source: 'user' | 'claude'
  /** When the file was last written, milliseconds since the epoch. */
  modifiedAt: number
}

export type ImageGroup = SessionImage['source']

export type SessionArtifact = {
  /** The claude.ai link the Artifact is published at. */
  url: string
  /** Its id in the other form of link, `claude.ai/code/artifact/<id>`, where known. */
  id?: string
  title: string
  /**
   * The Artifact type's name (`design`, `doc`, `slides`, ...), `page` for
   * Claude's own HTML, or `other` for a type not yet named.
   */
  kind: string
  /** The link of the Artifact type it was made from. */
  typeUrl?: string
  version: number
  /** When Claude last published it, milliseconds since the epoch. */
  publishedAt: number
  /** The local files its publishes sent, as real paths. */
  sources: string[]
  /** The folder a typed Artifact's files are kept in, as a real path. */
  root?: string
}

export type SessionFile = {
  path: string
  /** When the file was last written, milliseconds since the epoch. */
  modifiedAt: number
  /** Bytes. */
  size: number
  /** Lines, for a text file. */
  lines?: number
}

export type Group = 'artifacts' | 'files' | 'images'

declare module 'claude-code' {
  interface PluginState {
    'session-outputs': {
      images: Shaped<SessionImage[]>
      artifacts: Shaped<SessionArtifact[]>
      files: Shaped<SessionFile[]>
      /** Each Artifact type's name the session has seen, by the type's link. */
      typeNames: Record<string, string>
      hasAutoOpened: boolean
      showAll: Shaped<Record<Group, boolean>>
      /** The key of the row last focused or opened. */
      selected: string
      /** The key of the element the pane's focus ring is on, '' for none. */
      ring: string
    }
  }
}
