import { vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'

export function mockWorkerPromptExecution(runtime: OrcaRuntimeService, handle: string): void {
  vi.spyOn(runtime, 'getTerminalAgentStatus').mockResolvedValue({
    handle,
    isRunningAgent: true,
    status: 'working'
  })
  vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
    handle,
    accepted: true,
    bytesWritten: 1
  })
}
