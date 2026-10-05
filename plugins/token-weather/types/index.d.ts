export type Reading = { tokens: number; window: number }

declare module 'claude-code' {
  interface PluginState {
    'token-weather': { history: Reading[] }
  }
}
