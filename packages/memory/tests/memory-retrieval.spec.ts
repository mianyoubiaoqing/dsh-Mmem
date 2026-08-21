import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MemoryRetrievalEngine,
  type RecallIndexProvider,
} from '../src/retrieval.js'
import { openMemoryArchive } from '../src/index.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

describe('governed BM25 retrieval', () => {
  it('recalls an unexpired pending Candidate only as provisional memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-provisional-retrieval-'))
    const archive = await openMemoryArchive({
      path: join(root, 'memory.jsonl'),
      now: () => new Date('2026-08-20T12:00:00.000Z'),
    })
    const candidate = await archive.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'pending-tea-source',
      content: 'Owner 可能偏好凤凰单丛乌龙茶。',
      visibility: 'personal',
      memoryKind: 'preference',
    })

    const snapshot = await archive.retrieve({
      context: PERSONAL_COMPANION_ACCESS,
      query: '乌龙茶',
      limit: 3,
      maxCharacters: 500,
    })

    expect(snapshot.items).toEqual([])
    expect(snapshot.provisionalItems).toEqual([{
      candidate,
      score: expect.any(Number),
      reasons: [expect.objectContaining({
        providerId: 'mistymoon-provisional-bm25',
        reason: 'bm25-term-match',
      })],
    }])
    expect(candidate).toMatchObject({
      status: 'pending',
      expiresAt: '2026-08-21T12:00:00.000Z',
    })
  })

  it('projects an overdue Candidate as expired instead of pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-expired-candidate-'))
    let now = new Date('2026-08-20T12:00:00.000Z')
    const archive = await openMemoryArchive({
      path: join(root, 'memory.jsonl'),
      now: () => now,
    })
    const candidate = await archive.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'expiring-source',
      content: 'Owner 可能偏好中性的过期示例。',
      visibility: 'personal',
      memoryKind: 'preference',
    })
    now = new Date('2026-08-21T12:00:00.001Z')

    expect(archive.listCandidates({ context: PERSONAL_COMPANION_ACCESS })).toEqual([])
    expect(archive.listCandidates({
      context: PERSONAL_COMPANION_ACCESS,
      includeResolved: true,
    })).toEqual([{
      ...candidate,
      status: 'expired',
      content: '',
    }])
    await expect(archive.approveCandidate({
      context: PERSONAL_COMPANION_ACCESS,
      candidateId: candidate.id,
      sourceMessageId: 'late-approval',
    })).rejects.toThrow('expired')
  })

  it('expands user-visible Turn Evidence for an unexpired pending Candidate with pagination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-turn-evidence-expand-'))
    const path = join(root, 'memory.jsonl')
    const archive = await openMemoryArchive({
      path,
      now: () => new Date('2026-08-20T12:00:00.000Z'),
    })
    const candidate = await archive.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'dsh-turn:session-expand:2',
      content: '本轮摘要（未审核）：讨论中性部署方案。',
      visibility: 'personal',
      memoryKind: 'summary',
      turnEvidence: {
        schemaVersion: 1,
        sessionId: 'session-expand',
        turn: 2,
        userMessages: [{ messageId: 'user-expand', text: '请比较蓝绿部署与滚动部署。' }],
        assistantMessage: { messageId: 'assistant-expand', text: '蓝绿部署便于快速回滚；滚动部署资源开销较低。' },
      },
    })
    await archive.dispose()
    const reopened = await openMemoryArchive({
      path,
      now: () => new Date('2026-08-20T12:01:00.000Z'),
    })

    const first = reopened.expandTurnEvidence({
      context: PERSONAL_COMPANION_ACCESS,
      candidateId: candidate.id,
      cursor: 0,
      maxCharacters: 30,
    })
    expect(first).toMatchObject({
      schemaVersion: 1,
      candidateId: candidate.id,
      expiresAt: candidate.expiresAt,
      cursor: 0,
      content: expect.any(String),
      nextCursor: 30,
    })
    const second = reopened.expandTurnEvidence({
      context: PERSONAL_COMPANION_ACCESS,
      candidateId: candidate.id,
      cursor: first.nextCursor,
      maxCharacters: 10_000,
    })
    expect(second).toMatchObject({
      candidateId: candidate.id,
      cursor: 30,
    })
    expect(second).not.toHaveProperty('nextCursor')
  })

  it('persists model summary provenance beside temporary Turn Evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-turn-summary-provenance-'))
    const path = join(root, 'memory.jsonl')
    const archive = await openMemoryArchive({ path })
    const candidate = await archive.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'dsh-turn:summary-provenance:1',
      content: '本轮摘要（未审核，模型压缩）：中性摘要。',
      visibility: 'personal',
      memoryKind: 'summary',
      extraction: {
        schemaVersion: 1,
        providerId: 'dsh-turn-summary',
        providerVersion: '1',
        receipt: {
          kind: 'dsh-session',
          sessionId: 'summary-model-session',
          requestSeq: 2,
          responseSeq: 5,
        },
      },
      turnEvidence: {
        schemaVersion: 1,
        sessionId: 'summary-provenance',
        turn: 1,
        userMessages: [{ messageId: 'summary-user', text: '中性输入。' }],
        assistantMessage: { messageId: 'summary-assistant', text: '中性输出。' },
      },
    })
    await archive.dispose()

    const reopened = await openMemoryArchive({ path })
    expect(reopened.listCandidates({ context: PERSONAL_COMPANION_ACCESS })).toContainEqual(expect.objectContaining({
      id: candidate.id,
      turnEvidenceAvailable: true,
      extraction: expect.objectContaining({
        providerId: 'dsh-turn-summary',
        receipt: expect.objectContaining({ sessionId: 'summary-model-session' }),
      }),
    }))
  })

  it('returns an explained authoritative snapshot and drops unknown Provider IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-retrieval-'))
    const provider: RecallIndexProvider = {
      id: 'fixture-index',
      version: '1.0.0',
      query: async () => [
        { memoryId: 'unknown-memory', score: 100, reason: 'fixture-hit' },
      ],
    }
    const engine = new MemoryRetrievalEngine({ additionalProviders: [provider] })
    const archive = await openMemoryArchive({
      path: join(root, 'memory.jsonl'),
      now: () => new Date('2026-08-20T12:00:00.000Z'),
      retrievalEngine: engine,
    })
    const expected = await archive.observeExplicit({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'tea-source',
      text: '请记住：Owner 喜欢凤凰单丛乌龙茶。',
      memoryKind: 'preference',
    })
    await archive.observeExplicit({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'book-source',
      text: '请记住：Owner 喜欢中性装帧设计。',
      memoryKind: 'preference',
    })

    const snapshot = await archive.retrieve({
      context: PERSONAL_COMPANION_ACCESS,
      query: '乌龙茶',
      limit: 3,
      maxCharacters: 500,
    })
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      query: '乌龙茶',
      items: [{
        memory: expected,
        reasons: [expect.objectContaining({ providerId: 'mistymoon-bm25', reason: 'bm25-term-match' })],
      }],
    })
    expect(snapshot.items.some(item => item.memory.id === 'unknown-memory')).toBe(false)
  })

  it('enforces final character budget without truncating an authoritative record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-retrieval-budget-'))
    const archive = await openMemoryArchive({ path: join(root, 'memory.jsonl') })
    await archive.observeExplicit({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'long-source',
      text: `请记住：${'中性预算内容'.repeat(20)}`,
      memoryKind: 'summary',
    })
    const snapshot = await archive.retrieve({
      context: PERSONAL_COMPANION_ACCESS,
      query: '中性预算',
      maxCharacters: 20,
    })
    expect(snapshot.items).toEqual([])
  })

  it('validates trusted-host retrieval filters even when the Archive is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-retrieval-filter-validation-'))
    const archive = await openMemoryArchive({ path: join(root, 'memory.jsonl') })

    await expect(archive.retrieve({
      context: PERSONAL_COMPANION_ACCESS,
      query: 'fixture',
      memoryKinds: ['not-a-memory-kind' as 'summary'],
    })).rejects.toThrow('memory kind is unsupported')
  })
})
