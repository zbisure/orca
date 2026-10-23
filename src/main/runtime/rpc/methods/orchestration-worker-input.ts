import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../orca-runtime'

const CONFIRM_TIMEOUT_MS = 15_000
const RETRY_AFTER_MS = 1_500
const POLL_MS = 250

export async function sendWorkerPrompt(
  runtime: OrcaRuntimeService,
  handle: string,
  prompt: string,
  options: { agent?: string; timeoutMs?: number } = {}
): Promise<void> {
  const codex =
    options.agent === 'codex' ||
    (!options.agent && /\bcodex\b/i.test((await runtime.showTerminal(handle)).title ?? ''))
  const pane = runtime.getTerminalPaneKey(handle)
  const incarnation = runtime.getTerminalProcessIncarnation(handle)
  const assertIdentity = () => {
    if (
      !pane ||
      !incarnation ||
      runtime.getTerminalPaneKey(handle) !== pane ||
      runtime.getTerminalProcessIncarnation(handle) !== incarnation
    ) {
      throw new Error('worker_input_identity_changed')
    }
  }
  const started = Date.now()
  await runtime.sendTerminalAgentPrompt(handle, prompt)
  if (!codex) {
    return
  }

  try {
    const submitted = Date.now()
    const deadline =
      submitted + Math.min(options.timeoutMs ?? CONFIRM_TIMEOUT_MS, CONFIRM_TIMEOUT_MS)
    let retried = false
    while (Date.now() < deadline) {
      assertIdentity()
      const status = await runtime.getTerminalAgentStatus(handle)
      assertIdentity()
      if (status.isRunningAgent && status.status === 'working') {
        return
      }
      if (status.status === 'permission') {
        throw new Error('worker_input_permission')
      }
      const terminal = await runtime.showTerminal(handle)
      assertIdentity()
      if (!terminal.connected || !terminal.writable) {
        throw new Error('terminal_not_writable')
      }
      // Why: idle alone cannot distinguish an empty composer from an unsubmitted paste.
      const pendingPaste =
        (terminal.lastOutputAt ?? 0) > started &&
        /^\s*[›❯>]\s*\[Pasted (?:Content|text)[^\]\n]*\]\s*$/im.test(terminal.preview)
      if (
        !retried &&
        pendingPaste &&
        status.isRunningAgent &&
        status.status === 'idle' &&
        Date.now() - submitted >= RETRY_AFTER_MS
      ) {
        retried = true
        const alreadyStarted = new Error('worker_input_already_started')
        try {
          await runtime.sendTerminal(
            handle,
            { enter: true },
            {
              beforeWrite: async () => {
                assertIdentity()
                const current = await runtime.getTerminalAgentStatus(handle)
                assertIdentity()
                if (current.isRunningAgent && current.status === 'working') {
                  throw alreadyStarted
                }
                if (current.status === 'permission') {
                  throw new Error('worker_input_permission')
                }
              }
            }
          )
        } catch (error) {
          if (error === alreadyStarted) {
            return
          }
          throw error
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    throw new Error('worker_input_unconfirmed')
  } catch (error) {
    throw new OrchestrationError(
      'operation_unknown',
      error instanceof Error ? error.message : String(error)
    )
  }
}
