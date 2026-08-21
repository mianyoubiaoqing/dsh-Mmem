import { describe, expect, it, vi } from 'vitest'
import type { MemoryCandidate, MemoryCandidateProposal } from '../src/contracts.js'
import type { MemoryRuntimeSettingsManagerV1 } from '../src/runtime-settings.js'
import type { TurnSummaryCompressorV1 } from '../src/turn-summary-dsh.js'
import { proposeCompletedTurnSummaryV1 } from '../src/turn-summary-runtime.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

const evidence = {
  schemaVersion: 1 as const,
  sessionId: 'source-session',
  turn: 3,
  userMessages: [{ messageId: 'user-visible', text: '讨论中性灰度发布。' }],
  assistantMessage: { messageId: 'assistant-visible', text: '保留回滚检查点。' },
}

const extraction = {
  schemaVersion: 1 as const,
  providerId: 'dsh-turn-summary',
  providerVersion: '1',
  receipt: {
    kind: 'dsh-session' as const,
    sessionId: 'compression-session',
    requestSeq: 2,
    responseSeq: 5,
  },
}

function settings(policies: Array<'model' | 'local'>): MemoryRuntimeSettingsManagerV1 {
  let index = 0
  return {
    configured: true,
    get: vi.fn(),
    updateApproval: vi.fn(),
    getTurnSummary: vi.fn(async () => {
      const mode = policies[Math.min(index++, policies.length - 1)]
      return mode === 'model'
        ? { schemaVersion: 1 as const, revision: 2, mode: 'dsh-model' as const }
        : { schemaVersion: 1 as const, revision: 3, mode: 'local-deterministic' as const }
    }),
    updateTurnSummary: vi.fn(),
  }
}

function target() {
  const propose = vi.fn(async (proposal: MemoryCandidateProposal) => proposal as unknown as MemoryCandidate)
  return { propose }
}

const request = {
  spaceId: 'space-project',
  context: PERSONAL_COMPANION_ACCESS,
  sourceMessageId: 'dsh-turn:source-session:3',
  dshWorkspaceCwd: 'D:\\workspaces\\project',
  evidence,
  signal: new AbortController().signal,
}

describe('completed turn summary runtime', () => {
  it('atomically proposes model content, evidence, and reconstructible extraction receipt', async () => {
    const memory = target()
    const compressor: TurnSummaryCompressorV1 = {
      compress: vi.fn(async () => ({
        content: '本轮摘要（未审核，模型压缩）：讨论灰度发布与回滚检查。',
        extraction,
      })),
    }

    await proposeCompletedTurnSummaryV1({
      ...request,
      target: memory,
      settings: settings(['model', 'model']),
      compressor,
    })

    expect(memory.propose).toHaveBeenCalledWith(expect.objectContaining({
      content: '本轮摘要（未审核，模型压缩）：讨论灰度发布与回滚检查。',
      memoryKind: 'summary',
      turnEvidence: evidence,
      extraction,
    }))
  })

  it('falls back locally when model compression fails', async () => {
    const memory = target()
    await proposeCompletedTurnSummaryV1({
      ...request,
      target: memory,
      settings: settings(['model']),
      compressor: { compress: async () => { throw new Error('fixture model unavailable') } },
    })

    expect(memory.propose).toHaveBeenCalledWith(expect.objectContaining({
      content: '本轮摘要（未审核）：用户：讨论中性灰度发布。；助手：保留回滚检查点。',
      turnEvidence: evidence,
    }))
    expect(memory.propose.mock.calls[0]?.[0]).not.toHaveProperty('extraction')
  })

  it('discards model output when the Space policy changes during inference', async () => {
    const memory = target()
    await proposeCompletedTurnSummaryV1({
      ...request,
      target: memory,
      settings: settings(['model', 'local']),
      compressor: { compress: async () => ({ content: 'stale model output', extraction }) },
    })

    expect(memory.propose.mock.calls[0]?.[0]).not.toHaveProperty('extraction')
    expect(memory.propose.mock.calls[0]?.[0].content).toContain('用户：讨论中性灰度发布。')
  })
})
