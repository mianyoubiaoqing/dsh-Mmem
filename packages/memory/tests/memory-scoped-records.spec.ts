import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openMemoryArchive, type MemoryAccessContextV1 } from '../src/index.js'

function context(
  ownerId: string,
  scope: MemoryAccessContextV1['scope'],
  channelDisclosure: MemoryAccessContextV1['channelDisclosure'] = 'personal-only',
  requestIntent: MemoryAccessContextV1['requestIntent'] = 'ordinary',
): MemoryAccessContextV1 {
  return {
    version: 1,
    ownerId,
    authority: 'local-dsh-host-rpc',
    scope,
    channelDisclosure,
    requestIntent,
  }
}

const companion = { version: 1, kind: 'companion-reality' } as const
const sceneA = { version: 1, kind: 'character-scene', sceneId: 'scene-a' } as const
const sceneB = { version: 1, kind: 'character-scene', sceneId: 'scene-b' } as const

describe('scoped memory archive', () => {
  it('commits each Observation and record atomically and isolates Owner and exact scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-scoped-'))
    const path = join(root, 'memory.jsonl')
    const archive = await openMemoryArchive({
      path,
      now: () => new Date('2026-08-20T12:00:00.000Z'),
    })
    const ownerCompanion = context('owner-a', companion)
    const ownerSceneA = context('owner-a', sceneA)
    const ownerSceneB = context('owner-a', sceneB)
    const otherOwner = context('owner-b', companion)

    const companionMemory = await archive.observeExplicit({
      context: ownerCompanion, sourceMessageId: 'same-source', text: '请记住：中性共同关键词，现实。', memoryKind: 'summary',
    })
    const sceneMemory = await archive.observeExplicit({
      context: ownerSceneA, sourceMessageId: 'same-source', text: '请记住：中性共同关键词，场景 A。', memoryKind: 'episode',
    })
    const otherMemory = await archive.observeExplicit({
      context: otherOwner, sourceMessageId: 'same-source', text: '请记住：中性共同关键词，另一 Owner。', memoryKind: 'summary',
    })

    expect(archive.recall({ context: ownerCompanion, query: '共同关键词' })).toEqual([companionMemory])
    expect(archive.recall({ context: ownerSceneA, query: '共同关键词' })).toEqual([sceneMemory])
    expect(archive.recall({ context: ownerSceneB, query: '共同关键词' })).toEqual([])
    expect(archive.recall({ context: otherOwner, query: '共同关键词' })).toEqual([otherMemory])

    const transactions = (await readFile(path, 'utf8')).trim().split(/\r?\n/u).slice(1).map(line => JSON.parse(line) as {
      events: Array<{ event?: string; schemaVersion: number; observationId?: string; id: string }>
    })
    expect(transactions).toHaveLength(3)
    for (const transaction of transactions) {
      expect(transaction.events).toHaveLength(2)
      expect(transaction.events[0]).toMatchObject({ schemaVersion: 1, event: 'observation' })
      expect(transaction.events[1]).toMatchObject({ schemaVersion: 2, observationId: transaction.events[0]?.id })
    }
  })

  it('hard-filters confidential before recall and enforces current validity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-confidential-'))
    const archive = await openMemoryArchive({
      path: join(root, 'memory.jsonl'),
      now: () => new Date('2026-08-20T12:00:00.000Z'),
    })
    const personalOnly = context('owner-a', companion)
    const explicitButBlocked = context('owner-a', companion, 'personal-only', 'explicit-confidential-recall')
    const channelOnly = context('owner-a', companion, 'owner-confidential', 'ordinary')
    const allowed = context('owner-a', companion, 'owner-confidential', 'explicit-confidential-recall')
    await archive.observeExplicit({
      context: personalOnly, sourceMessageId: 'personal', text: '请记住：中性检索词，公开偏好。', memoryKind: 'preference',
    })
    const confidential = await archive.observeExplicit({
      context: personalOnly, sourceMessageId: 'confidential', text: '请记住并保密：中性检索词，私密偏好。', memoryKind: 'preference',
    })
    await archive.propose({
      context: personalOnly,
      sourceMessageId: 'future',
      content: '中性检索词，未来状态。',
      visibility: 'personal',
      memoryKind: 'state',
      validFrom: '2026-08-21T00:00:00.000Z',
    }).then(candidate => archive.approveCandidate({
      context: personalOnly, candidateId: candidate.id, sourceMessageId: 'approve-future',
    }))

    expect(archive.recall({ context: personalOnly, query: '中性检索词' })).toHaveLength(1)
    expect(archive.recall({ context: explicitButBlocked, query: '中性检索词' })).toHaveLength(1)
    expect(archive.recall({ context: channelOnly, query: '中性检索词' })).toHaveLength(1)
    expect(archive.recall({ context: allowed, query: '中性检索词' })).toEqual(expect.arrayContaining([confidential]))
    expect(archive.recall({ context: allowed, query: '中性检索词' })).toHaveLength(2)
  })
})
