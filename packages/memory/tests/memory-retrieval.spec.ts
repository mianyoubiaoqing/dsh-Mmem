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
})
