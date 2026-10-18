// The live autopilot pane (card autopilot-live-queue). It opens itself when a run starts (card autopilot-pane-auto-open); /doug-autopilot reopens it. It polls
// .doug/.state/autopilot.json (written by scripts/autopilot.mjs) and shows the same lines the board's panel shows.
// It also refreshes on prompt submit, turn end, and after a Bash call, because a reload drops the session.start timer (card autopilot-pane-current).
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { AUTOPILOT_FILE, autopilotLines, autopilotView, parseAutopilot, shouldOpenPane, startedFromList } from '../lib/autopilot-core.mjs'

const PANE = 'doug-autopilot'
const POLL_MS = 5000
const lines = atom({ plugin: 'doug-flow', key: 'autopilot' } as const, [] as string[])
// The startedAt of the run the pane was last opened for, so a pane the user closed stays closed for that run.
const opened = atom({ plugin: 'doug-flow', key: 'autopilot-opened' } as const, null as string | null)

const refresh = async ($: any) => {
  try {
    const root = await $.session.root()
    let text = ''
    try {
      text = await $.fs.read(`${root}/${AUTOPILOT_FILE}`)
    } catch {
      // no file: no run
    }
    const state = parseAutopilot(text)
    // A running queen card's seats come from its journal and the seat start times beside it; a read that fails adds none.
    const run: Record<string, { journals: string[]; startedMs: Record<string, number> }> = {}
    for (const c of Array.isArray(state?.cards) ? state.cards : []) {
      if (!c || c.state !== 'running' || !Array.isArray(c.journals)) continue
      const journals: string[] = []
      let startedMs: Record<string, number> = {}
      for (const j of c.journals as string[]) {
        try {
          journals.push(await $.fs.read(j))
          startedMs = { ...startedMs, ...startedFromList(await $.fs.list(j.slice(0, j.lastIndexOf('/')))) }
        } catch {
          // an unreadable journal adds no seats
        }
      }
      if (journals.length) run[c.id] = { journals, startedMs }
    }
    const fresh = autopilotLines(autopilotView(state, new Date(), run))
    await update($, lines, old => (JSON.stringify(old) === JSON.stringify(fresh) ? old : fresh))
    // Only `autopilot.autoOpenPane: false` in .doug/config.json turns the auto-open off.
    let autoOpen = true
    try {
      autoOpen = JSON.parse(await $.fs.read(`${root}/.doug/config.json`))?.autopilot?.autoOpenPane !== false
    } catch {
      // missing or unparsable config: flag on
    }
    const last = await read($, opened)
    if (state && shouldOpenPane(state, last, autoOpen, new Date())) {
      await update($, opened, () => state.startedAt as string)
      await $.ui.open({ id: PANE, title: 'Autopilot' })
    }
  } catch {
    // a failed poll keeps the last drawing
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'doug-autopilot',
      description: 'Show the autopilot queue live in a pane',
    })

    // The timer starts only in an interactive session; the event hooks run in any session (two small reads per prompt, turn end, and Bash call).
    if (e.isInteractive) {
      await refresh($)
      $.clock.every(POLL_MS, () => refresh($))
    }

    return next(e)
  })

  // A reload drops the session.start timer, so these hooks also refresh the pane (card autopilot-pane-current).
  on('prompt.submit', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    await refresh($)
    return ran
  })

  on('command.run', { command: 'doug-autopilot' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Autopilot' })
    return { text: 'Autopilot pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const shown = await read($, lines)
    return (
      <Box flexDirection="column">
        {shown.length === 0 && <Text dimColor>No autopilot run.</Text>}
        {shown.map(line => (
          <Text>{line}</Text>
        ))}
      </Box>
    )
  })
}
