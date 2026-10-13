// The live autopilot pane (card autopilot-live-queue). It opens itself when a run starts (card autopilot-pane-auto-open); /doug-autopilot reopens it. It polls
// .doug/.state/autopilot.json (written by scripts/autopilot.mjs) and shows the same lines the board's panel shows.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { AUTOPILOT_FILE, autopilotLines, autopilotView, parseAutopilot, shouldOpenPane } from '../lib/autopilot-core.mjs'

const PANE = 'doug-autopilot'
const POLL_MS = 5000
const lines = atom({ plugin: 'doug-flow', key: 'autopilot' } as const, [] as string[])
// The startedAt of the run the pane was last opened for, so a pane the user closed stays closed for that run.
const opened = atom({ plugin: 'doug-flow', key: 'autopilot-opened' } as const, null as string | null)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'doug-autopilot',
      description: 'Show the autopilot queue live in a pane',
    })

    const poll = async () => {
      try {
        const root = await $.session.root()
        let text = ''
        try {
          text = await $.fs.read(`${root}/${AUTOPILOT_FILE}`)
        } catch {
          // no file: no run
        }
        const state = parseAutopilot(text)
        const fresh = autopilotLines(autopilotView(state, new Date()))
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
    // A -p run or the SDK has nobody at the prompt: register the command, start no poll.
    if (e.isInteractive) {
      await poll()
      $.clock.every(POLL_MS, poll)
    }

    return next(e)
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
