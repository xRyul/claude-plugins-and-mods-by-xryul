export type CardState = 'auto' | 'open' | 'closed'
export type RunState = 'folded' | 'open'
export type TurnTime = { durationMs: number; doneAt: number }
export type FileCall = { id: string; verb: string; file: string }

declare module 'claude-code' {
  interface PluginState {
    'dracula-theme-mod': {
      cardState: StateFamily<CardState>
      runState: StateFamily<RunState>
      groupState: StateFamily<RunState>
      turnTimes: TurnTime[]
      liveCalls: string[]
      fileRuns: FileCall[][]
      finalReplies: string[]
    }
  }
}
