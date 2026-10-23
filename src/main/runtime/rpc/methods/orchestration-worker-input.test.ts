import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendWorkerPrompt } from './orchestration-worker-input'
import type { OrcaRuntimeService } from '../../orca-runtime'

function harness() {
  const runtime = {
    getTerminalPaneKey: vi.fn(() => 'pane'),
    getTerminalProcessIncarnation: vi.fn(() => 'process'),
    showTerminal: vi.fn(async () => ({
      connected: true,
      writable: true,
      title: 'Codex',
      preview: '› [Pasted Content 2400 chars]',
      lastOutputAt: Date.now()
    })),
    getTerminalAgentStatus: vi.fn(async () => ({ isRunningAgent: true, status: 'idle' })),
    sendTerminalAgentPrompt: vi.fn(async () => ({ accepted: true })),
    sendTerminal: vi.fn(async (_handle, _action, options) => {
      await options.beforeWrite('pty')
      return { accepted: true }
    })
  }
  const send = () =>
    sendWorkerPrompt(runtime as unknown as OrcaRuntimeService, 'worker', 'task\nsecond line', {
      agent: 'codex',
      timeoutMs: 3000
    })
  return { runtime, send }
}

afterEach(() => vi.useRealTimers())

describe('Codex worker input consumption', () => {
  it('waits for execution after paste submission', async () => {
    vi.useFakeTimers()
    const { runtime, send } = harness()
    runtime.getTerminalAgentStatus.mockResolvedValue({ isRunningAgent: true, status: 'working' })
    await send()
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('retries only Enter for a pending composer, including slow startup', async () => {
    vi.useFakeTimers()
    const { runtime, send } = harness()
    runtime.sendTerminal.mockImplementation(async (_handle, _action, options) => {
      await options.beforeWrite('pty')
      runtime.getTerminalAgentStatus.mockResolvedValue({ isRunningAgent: true, status: 'working' })
      return { accepted: true }
    })
    const pending = send()
    await vi.runAllTimersAsync()
    await pending
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    expect(runtime.sendTerminal).toHaveBeenCalledOnce()
    expect(runtime.sendTerminal.mock.calls[0]?.[1]).toEqual({ enter: true })
  })

  it('times out without replaying task text or repeatedly pressing Enter', async () => {
    vi.useFakeTimers()
    const { runtime, send } = harness()
    const pending = expect(send()).rejects.toThrow('worker_input_unconfirmed')
    await vi.runAllTimersAsync()
    await pending
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    expect(runtime.sendTerminal).toHaveBeenCalledOnce()
  })

  it('does not press Enter merely because a worker is idle', async () => {
    vi.useFakeTimers()
    const { runtime, send } = harness()
    runtime.showTerminal.mockResolvedValue({
      connected: true,
      writable: true,
      title: 'Codex',
      preview: '›',
      lastOutputAt: 0
    })
    const pending = expect(send()).rejects.toThrow('worker_input_unconfirmed')
    await vi.runAllTimersAsync()
    await pending
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('does not use historical pasted text as pending input', async () => {
    vi.useFakeTimers()
    const { runtime, send } = harness()
    runtime.showTerminal.mockResolvedValue({
      connected: true,
      writable: true,
      title: 'Codex',
      preview: '› [Pasted Content 2400 chars]',
      lastOutputAt: 0
    })
    const pending = expect(send()).rejects.toThrow('worker_input_unconfirmed')
    await vi.runAllTimersAsync()
    await pending
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('fails on permissions without sending another Enter', async () => {
    const { runtime, send } = harness()
    runtime.getTerminalAgentStatus.mockResolvedValue({ isRunningAgent: true, status: 'permission' })
    await expect(send()).rejects.toThrow('worker_input_permission')
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('fences a replaced worker process before any recovery write', async () => {
    const { runtime, send } = harness()
    runtime.sendTerminalAgentPrompt.mockImplementation(async () => {
      runtime.getTerminalProcessIncarnation.mockReturnValue('replacement')
      return { accepted: true }
    })
    await expect(send()).rejects.toThrow('worker_input_identity_changed')
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('preserves non-Codex prompt transport', async () => {
    const { runtime } = harness()
    await sendWorkerPrompt(runtime as unknown as OrcaRuntimeService, 'worker', 'task', {
      agent: 'claude'
    })
    expect(runtime.getTerminalAgentStatus).not.toHaveBeenCalled()
  })
})
