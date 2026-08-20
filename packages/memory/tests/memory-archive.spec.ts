import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  openMemoryArchive as openRawMemoryArchive,
  type CompanionMemoryArchive,
  type ExplicitMemoryObservation,
  type MemoryCandidateDecision,
  type MemoryCandidateList,
  type MemoryCandidateProposal,
  type MemoryForget,
  type MemoryList,
  type MemoryRecall,
  type MemoryReplace,
  type OpenMemoryArchiveOptions,
} from '../src/index.js'

const access = {
  version: 1,
  ownerId: 'owner-fixture',
  authority: 'local-dsh-host-rpc',
  scope: { version: 1, kind: 'companion-reality' },
  channelDisclosure: 'owner-confidential',
  requestIntent: 'explicit-confidential-recall',
} as const

type WithoutContext<T extends { context: unknown }> = Omit<T, 'context'>

function withTestAccess(archive: CompanionMemoryArchive) {
  return {
    inspection: () => archive.inspection(),
    dispose: () => archive.dispose(),
    observeExplicit: (input: Omit<WithoutContext<ExplicitMemoryObservation>, 'memoryKind'>) =>
      archive.observeExplicit({ ...input, context: access, memoryKind: 'summary' }),
    recall: (input: WithoutContext<MemoryRecall>) => archive.recall({ ...input, context: access }),
    list: (input: WithoutContext<MemoryList> = {}) => archive.list({ ...input, context: access }),
    forget: (input: WithoutContext<MemoryForget>) => archive.forget({ ...input, context: access }),
    replace: (input: WithoutContext<MemoryReplace>) => archive.replace({ ...input, context: access }),
    propose: (input: Omit<WithoutContext<MemoryCandidateProposal>, 'memoryKind'>) =>
      archive.propose({ ...input, context: access, memoryKind: 'summary' }),
    listCandidates: (input: WithoutContext<MemoryCandidateList> = {}) =>
      archive.listCandidates({ ...input, context: access }),
    approveCandidate: (input: WithoutContext<MemoryCandidateDecision>) =>
      archive.approveCandidate({ ...input, context: access }),
    rejectCandidate: (input: WithoutContext<MemoryCandidateDecision>) =>
      archive.rejectCandidate({ ...input, context: access }),
  }
}

async function openMemoryArchive(options: OpenMemoryArchiveOptions) {
  return withTestAccess(await openRawMemoryArchive(options))
}

describe('companion memory archive', () => {
  it('serializes same-source writes across archive instances without corrupting restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-concurrent-source-'))
    const path = join(root, 'memory.jsonl')
    const first = await openMemoryArchive({
      path,
      createId: (() => { let sequence = 0; return () => `first-${sequence++}` })(),
      now: () => new Date('2026-08-18T10:00:00.000Z'),
    })
    const second = await openMemoryArchive({
      path,
      createId: (() => { let sequence = 0; return () => `second-${sequence++}` })(),
      now: () => new Date('2026-08-18T10:00:01.000Z'),
    })

    const results = await Promise.allSettled([
      first.observeExplicit({ sourceMessageId: 'message-shared', text: '请记住：今天整理了中性测试夹具。' }),
      second.observeExplicit({ sourceMessageId: 'message-shared', text: '请记住：今天复核了中性测试夹具。' }),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'MEMORY_SOURCE_CONFLICT' }) }),
    ])
    const reopened = await openMemoryArchive({ path })
    expect(reopened.list()).toHaveLength(1)
  })

  it('preserves one hundred concurrent mutations across archive instances', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-concurrent-batch-'))
    const path = join(root, 'memory.jsonl')
    const archives = await Promise.all(Array.from({ length: 10 }, async (_, archiveIndex) => {
      let sequence = 0
      return openMemoryArchive({
        path,
        createId: () => `memory-${archiveIndex}-${sequence++}`,
        now: () => new Date(`2026-08-18T10:${String(archiveIndex).padStart(2, '0')}:00.000Z`),
      })
    }))

    await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      await archives[index % archives.length]!.observeExplicit({
        sourceMessageId: `message-${index}`,
        text: `请记住：中性并发事实编号 ${index}。`,
      })
    }))

    const reopened = await openMemoryArchive({ path })
    expect(reopened.list({ limit: 200 })).toHaveLength(100)
    expect(reopened.inspection()).toMatchObject({ state: 'ready', transactionCount: 100, eventCount: 200 })
  })

  it('deduplicates explicit memories by source message and recalls them after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-'))
    const path = join(root, 'memory.jsonl')
    const first = await openMemoryArchive({
      path,
      createId: (() => { const ids = ['observation-1', 'memory-1']; return () => ids.shift() ?? 'unexpected-id' })(),
      now: () => new Date('2026-08-14T10:00:00.000Z'),
    })

    const remembered = await first.observeExplicit({
      sourceMessageId: 'message-1',
      text: '请记住：我喜欢凤凰单丛，暂时不要告诉别人。',
    })
    const duplicate = await first.observeExplicit({
      sourceMessageId: 'message-1',
      text: '请记住：我喜欢凤凰单丛，暂时不要告诉别人。',
    })

    expect(remembered).toMatchObject({
      id: 'memory-1',
      content: '我喜欢凤凰单丛，暂时不要告诉别人。',
      visibility: 'confidential',
      sourceMessageId: 'message-1',
      status: 'confirmed',
    })
    expect(duplicate).toEqual(remembered)

    const reopened = await openMemoryArchive({ path })
    expect(reopened.recall({ query: '喜欢什么茶', limit: 4 })).toEqual([remembered])
  })

  it('keeps forgotten memories out of recall while retaining an auditable record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-forget-'))
    const path = join(root, 'memory.jsonl')
    const archive = await openMemoryArchive({
      path,
      createId: (() => {
        const ids = ['observation-1', 'memory-1', 'observation-2', 'event-1']
        return () => ids.shift() ?? 'unexpected-id'
      })(),
      now: () => new Date('2026-08-14T10:00:00.000Z'),
    })
    await archive.observeExplicit({ sourceMessageId: 'message-1', text: '请记住：我喜欢凤凰单丛。' })

    const forgotten = await archive.forget({ memoryId: 'memory-1', sourceMessageId: 'tool-call-1' })

    expect(forgotten).toMatchObject({ id: 'memory-1', status: 'forgotten' })
    expect(archive.recall({ query: '凤凰单丛' })).toEqual([])
    expect(archive.list({ includeInactive: true })).toEqual([forgotten])
    const reopened = await openMemoryArchive({ path })
    expect(reopened.recall({ query: '凤凰单丛' })).toEqual([])
    expect(reopened.list({ includeInactive: true })).toEqual([forgotten])
  })

  it('replaces a memory atomically and recalls only the current value after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-replace-'))
    const path = join(root, 'memory.jsonl')
    const ids = ['observation-1', 'memory-1', 'observation-2', 'memory-2']
    const archive = await openMemoryArchive({
      path,
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-08-14T10:00:00.000Z'),
    })
    await archive.observeExplicit({ sourceMessageId: 'message-1', text: '请记住：我喜欢红茶。' })

    const replacement = await archive.replace({
      memoryId: 'memory-1',
      sourceMessageId: 'tool-call-2',
      content: '我现在更喜欢凤凰单丛。',
    })

    expect(replacement).toMatchObject({
      id: 'memory-2',
      content: '我现在更喜欢凤凰单丛。',
      status: 'confirmed',
      supersedesMemoryId: 'memory-1',
    })
    expect(archive.recall({ query: '红茶' })).toEqual([])
    expect(archive.recall({ query: '凤凰单丛' })).toEqual([replacement])
    expect(archive.list({ includeInactive: true })).toEqual([
      replacement,
      expect.objectContaining({ id: 'memory-1', status: 'superseded' }),
    ])
    const reopened = await openMemoryArchive({ path })
    expect(reopened.recall({ query: '凤凰单丛' })).toEqual([replacement])
    expect(reopened.list({ includeInactive: true })).toEqual(archive.list({ includeInactive: true }))
  })

  it('keeps proposed memories out of recall until the owner approves them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-candidate-'))
    const path = join(root, 'memory.jsonl')
    const ids = ['observation-1', 'candidate-1', 'observation-2', 'memory-1', 'event-1']
    const archive = await openMemoryArchive({
      path,
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-08-14T10:00:00.000Z'),
    })

    const candidate = await archive.propose({
      sourceMessageId: 'tool-propose-1',
      content: '主人通常在周末整理书桌。',
      visibility: 'personal',
    })

    expect(candidate).toMatchObject({ id: 'candidate-1', status: 'pending' })
    expect(archive.recall({ query: '周末' })).toEqual([])
    expect(archive.listCandidates()).toEqual([candidate])

    const memory = await archive.approveCandidate({
      candidateId: candidate.id,
      sourceMessageId: 'tool-approve-1',
    })

    expect(memory).toMatchObject({
      id: 'memory-1',
      content: '主人通常在周末整理书桌。',
      sourceCandidateId: 'candidate-1',
      status: 'confirmed',
    })
    expect(candidate.status).toBe('approved')
    expect(archive.listCandidates()).toEqual([])
    expect(archive.recall({ query: '周末' })).toEqual([memory])

    const reopened = await openMemoryArchive({ path })
    expect(reopened.listCandidates({ includeResolved: true })).toEqual([candidate])
    expect(reopened.recall({ query: '周末' })).toEqual([memory])
  })

  it('quarantines a partial approval transaction without applying any approval event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-partial-approval-'))
    const path = join(root, 'memory.jsonl')
    const ids = ['observation-1', 'candidate-1', 'observation-2', 'memory-1', 'resolution-1']
    const archive = await openMemoryArchive({
      path,
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-08-18T11:00:00.000Z'),
    })
    const candidate = await archive.propose({
      sourceMessageId: 'proposal-1',
      content: 'Owner 使用中性样例验证事务边界。',
      visibility: 'personal',
    })
    await archive.approveCandidate({ candidateId: candidate.id, sourceMessageId: 'approval-1' })
    const bytes = await readFile(path)
    const lastLineStart = bytes.lastIndexOf(0x0a, bytes.length - 2) + 1
    await writeFile(path, bytes.subarray(0, lastLineStart + Math.floor((bytes.length - lastLineStart) / 2)))

    const reopened = await openMemoryArchive({ path })

    expect(reopened.inspection()).toMatchObject({
      state: 'quarantined',
      issues: [{ code: 'trailing-partial-transaction' }],
    })
    expect(reopened.recall({ query: '事务边界' })).toEqual([])
    expect(() => reopened.listCandidates({ includeResolved: true })).not.toThrow()
    await expect(reopened.approveCandidate({ candidateId: candidate.id, sourceMessageId: 'approval-retry' }))
      .rejects.toMatchObject({ code: 'MEMORY_ARCHIVE_QUARANTINED' })
  })

  it('classifies trailing and interior corruption without exposing archive content', async () => {
    const cases = [
      { suffix: 'trailing', damagedBytes: '{"transaction":', issue: 'trailing-partial-transaction' },
      { suffix: 'interior', damagedBytes: '{not-json}\n', issue: 'interior-invalid-json' },
    ] as const

    for (const testCase of cases) {
      const root = await mkdtemp(join(tmpdir(), `mistymoon-memory-${testCase.suffix}-`))
      const path = join(root, 'memory.jsonl')
      const ids = ['observation-1', 'memory-1']
      const archive = await openMemoryArchive({
        path,
        createId: () => ids.shift() ?? 'unexpected-id',
        now: () => new Date('2026-08-18T12:00:00.000Z'),
      })
      await archive.observeExplicit({
        sourceMessageId: 'message-1',
        text: '请记住：这是不会出现在诊断中的中性正文。',
      })
      await appendFile(path, testCase.damagedBytes, 'utf8')

      const reopened = await openMemoryArchive({ path })
      const inspection = reopened.inspection()

      expect(inspection).toMatchObject({ state: 'quarantined', issues: [{ code: testCase.issue }] })
      expect(JSON.stringify(inspection)).not.toContain('不会出现在诊断中')
    }
  })

  it('detects removal of a complete trailing transaction through its durability checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-truncated-transaction-'))
    const path = join(root, 'memory.jsonl')
    const ids = ['observation-1', 'memory-1', 'observation-2', 'memory-2']
    const archive = await openMemoryArchive({
      path,
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-08-18T13:00:00.000Z'),
    })
    await archive.observeExplicit({ sourceMessageId: 'message-1', text: '请记住：中性事实一。' })
    await archive.observeExplicit({ sourceMessageId: 'message-2', text: '请记住：中性事实二。' })
    const lines = (await readFile(path, 'utf8')).trimEnd().split(/\r?\n/u)
    await writeFile(path, `${lines.slice(0, -1).join('\n')}\n`, 'utf8')

    const reopened = await openMemoryArchive({ path })

    expect(reopened.inspection()).toMatchObject({
      state: 'quarantined',
      issues: [{ code: 'checkpoint-mismatch' }],
    })
    expect(reopened.recall({ query: '中性事实' })).toEqual([])
  })

  it('rejects new mutations after bounded archive disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-dispose-'))
    const path = join(root, 'memory.jsonl')
    const archive = await openMemoryArchive({ path })

    await archive.dispose()

    await expect(archive.observeExplicit({ sourceMessageId: 'message-after-dispose', text: '请记住：不能写入。' }))
      .rejects.toMatchObject({ code: 'MEMORY_ARCHIVE_DISPOSED' })
  })

  it('retains rejected candidates for audit without making them recallable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-rejected-candidate-'))
    const path = join(root, 'memory.jsonl')
    const ids = ['observation-1', 'candidate-1', 'observation-2', 'event-1']
    const archive = await openMemoryArchive({
      path,
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-08-14T10:00:00.000Z'),
    })
    const candidate = await archive.propose({
      sourceMessageId: 'tool-propose-1',
      content: '主人每天凌晨四点起床。',
      visibility: 'personal',
    })

    const rejected = await archive.rejectCandidate({
      candidateId: candidate.id,
      sourceMessageId: 'tool-reject-1',
    })

    expect(rejected.status).toBe('rejected')
    expect(archive.listCandidates()).toEqual([])
    expect(archive.recall({ query: '凌晨四点' })).toEqual([])
    const reopened = await openMemoryArchive({ path })
    expect(reopened.listCandidates({ includeResolved: true })).toEqual([rejected])
  })
})
