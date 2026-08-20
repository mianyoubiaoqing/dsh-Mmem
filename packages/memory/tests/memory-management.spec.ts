import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openMemoryArchive } from '../src/index.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

describe('memory management service boundary', () => {
  it('searches governed records/candidates and exposes payload-free source metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-management-'))
    const archive = await openMemoryArchive({
      path: join(root, 'memory.jsonl'),
      now: () => new Date('2026-08-20T12:00:00.000Z'),
    })
    const record = await archive.observeExplicit({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'record-source',
      text: '请记住：中性管理检索记录。',
      memoryKind: 'preference',
    })
    if (record === undefined) throw new Error('fixture record missing')
    const candidate = await archive.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'candidate-source',
      content: '中性管理检索候选。',
      visibility: 'personal',
      memoryKind: 'summary',
    })

    expect(archive.manage({
      context: PERSONAL_COMPANION_ACCESS,
      query: '管理检索',
      recordStatus: 'all',
      candidateStatus: 'all',
    })).toMatchObject({ schemaVersion: 1, records: [record], candidates: [candidate], audit: [] })
    const source = archive.sourceView({
      context: PERSONAL_COMPANION_ACCESS,
      entity: 'candidate',
      id: candidate.id,
    })
    expect(source).toMatchObject({
      entity: 'candidate', id: candidate.id,
      observation: { sourceKind: 'governance-operation', sourceId: 'candidate-source' },
    })
    expect(JSON.stringify(source)).not.toContain(candidate.content)
  })

  it('returns explicit per-item batch outcomes and exact retries remain idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-management-batch-'))
    const archive = await openMemoryArchive({
      path: join(root, 'memory.jsonl'),
      now: () => new Date('2026-08-20T12:00:00.000Z'),
    })
    const approve = await archive.propose({
      context: PERSONAL_COMPANION_ACCESS, sourceMessageId: 'approve-source', content: '中性批准项。',
      visibility: 'personal', memoryKind: 'summary',
    })
    const reject = await archive.propose({
      context: PERSONAL_COMPANION_ACCESS, sourceMessageId: 'reject-source', content: '中性拒绝项。',
      visibility: 'personal', memoryKind: 'summary',
    })
    const input = {
      context: PERSONAL_COMPANION_ACCESS,
      requestId: 'batch-request',
      decisions: [
        { candidateId: approve.id, action: 'approve' as const },
        { candidateId: reject.id, action: 'reject' as const },
        { candidateId: 'missing-candidate', action: 'reject' as const },
      ],
    }
    const first = await archive.batchDecide(input)
    const retry = await archive.batchDecide(input)
    expect(first).toEqual({
      schemaVersion: 1,
      results: [
        { candidateId: approve.id, status: 'succeeded' },
        { candidateId: reject.id, status: 'succeeded' },
        { candidateId: 'missing-candidate', status: 'failed', code: 'MEMORY_SCOPE_MISMATCH' },
      ],
    })
    expect(retry).toEqual(first)
  })
})
