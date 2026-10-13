// The $.state contract of the doug-flow mod (the autopilot pane, hooks/register.tsx).
export type AutopilotLines = string[]

declare module 'claude-code' {
  interface PluginState {
    'doug-flow': { autopilot: AutopilotLines; 'autopilot-opened': string | null }
  }
}
