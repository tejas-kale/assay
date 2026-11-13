declare module 'claude-code' {
  interface PluginState {
    assay: { expansion: StateFamily<Record<string, boolean>> }
  }
}
