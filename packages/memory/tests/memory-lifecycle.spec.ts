import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openMemoryArchive } from '../src/index.js'
import { DerivedMemoryViewRegistry } from '../src/lifecycle.js'
import { CONFIDENTIAL_COMPANION_ACCESS, PERSONAL_COMPANION_ACCESS } from './fixtures.js'

describe('governed memory lifecycle', () => {
  it('keeps consolidation as a no-op plan until the Owner confirms complete source lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-lifecycle-consolidate-'))
    const archive = await openMemoryArchive({ path: join(root, 'memory.jsonl') })
    const first = await archive.observeExplicit({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      sourceMessageId: 'consolidate-source-1',
      text: '请记住：中性共同经历的第一部分。',
      memoryKind: 'episode',
    })
    const second = await archive.observeExplicit({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      sourceMessageId: 'consolidate-source-2',
      text: '请记住并保密：中性共同经历的第二部分。',
      memoryKind: 'episode',
    })
    if (first === undefined || second === undefined) throw new Error('lifecycle fixtures missing')

    const plan = archive.planLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      action: {
        kind: 'consolidate',
        sourceMemoryIds: [first.id, second.id],
        content: '中性共同经历的完整摘要。',
      },
    })

    expect(archive.list({ context: CONFIDENTIAL_COMPANION_ACCESS, includeInactive: true })).toHaveLength(2)
    await expect(archive.applyLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      planId: plan.id,
      ownerConfirmed: false,
      sourceMessageId: 'consolidate-apply-denied',
    })).rejects.toThrow('Owner confirmation')

    const applied = await archive.applyLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      planId: plan.id,
      ownerConfirmed: true,
      sourceMessageId: 'consolidate-apply-confirmed',
    })

    expect(applied.createdMemory).toMatchObject({
      content: '中性共同经历的完整摘要。',
      memoryKind: 'summary',
      visibility: 'confidential',
      sourceMemoryIds: [first.id, second.id],
      status: 'confirmed',
    })
    expect(archive.list({ context: CONFIDENTIAL_COMPANION_ACCESS, includeInactive: true })).toHaveLength(3)
  })

  it('stops recalling a consolidated summary when any leaf source becomes invalid, including after replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-lifecycle-lineage-'))
    const path = join(root, 'memory.jsonl')
    const archive = await openMemoryArchive({ path })
    const first = await archive.observeExplicit({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      sourceMessageId: 'lineage-source-1',
      text: '请记住：谱系来源甲。',
      memoryKind: 'episode',
    })
    const second = await archive.observeExplicit({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      sourceMessageId: 'lineage-source-2',
      text: '请记住：谱系来源乙。',
      memoryKind: 'episode',
    })
    if (first === undefined || second === undefined) throw new Error('lineage fixtures missing')
    const plan = archive.planLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      action: {
        kind: 'consolidate',
        sourceMemoryIds: [first.id, second.id],
        content: '独有摘要检索词。',
      },
    })
    const applied = await archive.applyLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      planId: plan.id,
      ownerConfirmed: true,
      sourceMessageId: 'lineage-apply',
    })
    expect((await archive.retrieve({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      query: '独有摘要检索词',
    })).items.map(item => item.memory.id)).toContain(applied.createdMemory?.id)

    await archive.forget({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      memoryId: first.id,
      sourceMessageId: 'lineage-forget',
    })
    expect((await archive.retrieve({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      query: '独有摘要检索词',
    })).items.map(item => item.memory.id)).not.toContain(applied.createdMemory?.id)
    await archive.dispose()

    const reopened = await openMemoryArchive({ path })
    expect((await reopened.retrieve({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      query: '独有摘要检索词',
    })).items.map(item => item.memory.id)).not.toContain(applied.createdMemory?.id)
    expect(reopened.list({ context: CONFIDENTIAL_COMPANION_ACCESS, includeInactive: true }))
      .toContainEqual(expect.objectContaining({ id: applied.createdMemory?.id, status: 'confirmed' }))
  })

  it('decays only eligible kinds into a colder ranking tier without changing their facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-lifecycle-decay-'))
    let current = new Date('2025-01-01T00:00:00.000Z')
    const archive = await openMemoryArchive({ path: join(root, 'memory.jsonl'), now: () => current })
    const preference = await archive.observeExplicit({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      sourceMessageId: 'decay-preference',
      text: '请记住：中性衰减检索词偏好。',
      memoryKind: 'preference',
    })
    for (const [memoryKind, sourceMessageId] of [
      ['boundary', 'decay-boundary'],
      ['commitment', 'decay-commitment'],
      ['state', 'decay-state'],
    ] as const) {
      await archive.observeExplicit({
        context: CONFIDENTIAL_COMPANION_ACCESS,
        sourceMessageId,
        text: `请记住：中性 ${memoryKind} 保护条目。`,
        memoryKind,
      })
    }
    if (preference === undefined) throw new Error('decay fixture missing')
    const before = await archive.retrieve({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      query: '中性衰减检索词偏好',
    })
    current = new Date('2026-01-01T00:00:00.000Z')

    const plan = archive.planLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      action: { kind: 'decay', coldAfterDays: 30, minimumRankMultiplier: 0.25 },
    })

    expect(plan.action).toMatchObject({
      kind: 'decay',
      changes: [{ memoryId: preference.id, toTier: 'cold' }],
    })
    const applied = await archive.applyLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      planId: plan.id,
      ownerConfirmed: true,
      sourceMessageId: 'decay-apply',
    })
    const after = await archive.retrieve({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      query: '中性衰减检索词偏好',
    })
    const decayed = archive.list({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      includeInactive: true,
    }).find(memory => memory.id === preference.id)

    expect(applied.affectedMemoryIds).toEqual([preference.id])
    expect(decayed).toMatchObject({
      id: preference.id,
      content: preference.content,
      status: 'confirmed',
      visibility: preference.visibility,
      lifecycle: { tier: 'cold' },
    })
    expect(after.items[0]?.score).toBeLessThan(before.items[0]?.score ?? 0)
  })

  it('archives without deletion and restores recall through a new confirmed plan after replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-lifecycle-archive-'))
    const path = join(root, 'memory.jsonl')
    const archive = await openMemoryArchive({ path })
    const memory = await archive.observeExplicit({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      sourceMessageId: 'archive-source',
      text: '请记住：可恢复归档检索词。',
      memoryKind: 'episode',
    })
    if (memory === undefined) throw new Error('archive fixture missing')
    const archivePlan = archive.planLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      action: { kind: 'archive', memoryIds: [memory.id] },
    })
    await archive.applyLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      planId: archivePlan.id,
      ownerConfirmed: true,
      sourceMessageId: 'archive-apply',
    })
    expect((await archive.retrieve({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      query: '可恢复归档检索词',
    })).items).toEqual([])
    expect(archive.list({ context: CONFIDENTIAL_COMPANION_ACCESS, includeInactive: true }))
      .toContainEqual(expect.objectContaining({
        id: memory.id,
        content: memory.content,
        status: 'confirmed',
        lifecycle: expect.objectContaining({ tier: 'archived' }),
      }))
    await archive.dispose()

    const reopened = await openMemoryArchive({ path })
    expect((await reopened.retrieve({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      query: '可恢复归档检索词',
    })).items).toEqual([])
    const restorePlan = reopened.planLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      action: { kind: 'restore', memoryIds: [memory.id] },
    })
    await reopened.applyLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      planId: restorePlan.id,
      ownerConfirmed: true,
      sourceMessageId: 'restore-apply',
    })
    expect((await reopened.retrieve({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      query: '可恢复归档检索词',
    })).items.map(item => item.memory.id)).toEqual([memory.id])
  })

  it('does not let callers mutate the stored plan after it is presented for confirmation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-lifecycle-immutable-plan-'))
    const archive = await openMemoryArchive({ path: join(root, 'memory.jsonl') })
    const first = await archive.observeExplicit({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      sourceMessageId: 'immutable-source-1',
      text: '请记住：不可变计划条目甲。',
      memoryKind: 'episode',
    })
    const second = await archive.observeExplicit({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      sourceMessageId: 'immutable-source-2',
      text: '请记住：不可变计划条目乙。',
      memoryKind: 'episode',
    })
    if (first === undefined || second === undefined) throw new Error('immutable plan fixtures missing')
    const plan = archive.planLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      action: { kind: 'archive', memoryIds: [first.id] },
    })
    if (plan.action.kind !== 'archive') throw new Error('archive plan missing')
    ;(plan.action.memoryIds as string[]).push(second.id)

    const applied = await archive.applyLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      planId: plan.id,
      ownerConfirmed: true,
      sourceMessageId: 'immutable-apply',
    })

    expect(applied.affectedMemoryIds).toEqual([first.id])
    expect(archive.list({ context: CONFIDENTIAL_COMPANION_ACCESS, includeInactive: true })
      .find(memory => memory.id === second.id)?.lifecycle).toBeUndefined()
  })

  it('marks a failed ID-only derived-view invalidation stale without weakening Archive recall gates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-lifecycle-derived-view-'))
    const registry = new DerivedMemoryViewRegistry()
    let serializedRequest = ''
    registry.register({
      id: 'derived-fixture',
      version: '1.0.0',
      timeoutMs: 500,
      invalidate: async request => {
        serializedRequest = JSON.stringify(request)
        throw new Error('fixture deletion failure')
      },
    })
    const archive = await openMemoryArchive({
      path: join(root, 'memory.jsonl'),
      derivedViewInvalidator: registry,
    })
    const memory = await archive.observeExplicit({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      sourceMessageId: 'derived-source',
      text: '请记住：派生视图失效检索词。',
      memoryKind: 'episode',
    })
    if (memory === undefined) throw new Error('derived view fixture missing')
    const plan = archive.planLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      action: { kind: 'archive', memoryIds: [memory.id] },
    })

    const applied = await archive.applyLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      planId: plan.id,
      ownerConfirmed: true,
      sourceMessageId: 'derived-archive-apply',
    })

    expect(applied.derivedViews).toEqual([{
      providerId: 'derived-fixture',
      providerVersion: '1.0.0',
      status: 'stale',
      reason: 'failed',
    }])
    expect(serializedRequest).toBe(JSON.stringify({ schemaVersion: 1, memoryIds: [memory.id] }))
    expect(serializedRequest).not.toContain(memory.content)
    expect(serializedRequest).not.toContain('ownerId')
    expect(serializedRequest).not.toContain('scope')
    expect((await archive.retrieve({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      query: '派生视图失效检索词',
    })).items).toEqual([])
  })

  it('rejects a stale multi-target plan without partially applying another target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-lifecycle-stale-plan-'))
    const archive = await openMemoryArchive({ path: join(root, 'memory.jsonl') })
    const first = await archive.observeExplicit({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      sourceMessageId: 'stale-source-1',
      text: '请记住：陈旧计划条目甲。',
      memoryKind: 'episode',
    })
    const second = await archive.observeExplicit({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      sourceMessageId: 'stale-source-2',
      text: '请记住：陈旧计划条目乙。',
      memoryKind: 'episode',
    })
    if (first === undefined || second === undefined) throw new Error('stale plan fixtures missing')
    const plan = archive.planLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      action: { kind: 'archive', memoryIds: [first.id, second.id] },
    })
    await archive.forget({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      memoryId: first.id,
      sourceMessageId: 'stale-plan-drift',
    })

    await expect(archive.applyLifecycle({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      planId: plan.id,
      ownerConfirmed: true,
      sourceMessageId: 'stale-plan-apply',
    })).rejects.toThrow('stale')
    expect(archive.list({ context: CONFIDENTIAL_COMPANION_ACCESS, includeInactive: true })
      .find(memory => memory.id === second.id)?.lifecycle).toBeUndefined()
  })

  it('bounds derived-view invalidation and reports a timeout as stale', async () => {
    const registry = new DerivedMemoryViewRegistry()
    let providerSawAbort = false
    registry.register({
      id: 'derived-timeout',
      version: '1.0.0',
      timeoutMs: 10,
      invalidate: (_request, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          providerSawAbort = true
          reject(signal.reason)
        }, { once: true })
      }),
    })

    await expect(registry.invalidate(['memory-fixture'])).resolves.toEqual([{
      providerId: 'derived-timeout',
      providerVersion: '1.0.0',
      status: 'stale',
      reason: 'timed-out',
    }])
    expect(providerSawAbort).toBe(true)
  })

  it('applies the confidential disclosure gate before an automatic decay plan exposes IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-lifecycle-confidential-plan-'))
    let current = new Date('2025-01-01T00:00:00.000Z')
    const archive = await openMemoryArchive({ path: join(root, 'memory.jsonl'), now: () => current })
    await archive.observeExplicit({
      context: CONFIDENTIAL_COMPANION_ACCESS,
      sourceMessageId: 'confidential-decay-source',
      text: '请记住并保密：私密计划隔离条目。',
      memoryKind: 'episode',
    })
    current = new Date('2026-01-01T00:00:00.000Z')

    const plan = archive.planLifecycle({
      context: PERSONAL_COMPANION_ACCESS,
      action: { kind: 'decay', coldAfterDays: 30, minimumRankMultiplier: 0.25 },
    })

    expect(plan.action).toEqual({ kind: 'decay', changes: [] })
  })

  it('isolates the ID-only invalidation request between untrusted derived-view Providers', async () => {
    const registry = new DerivedMemoryViewRegistry()
    registry.register({
      id: 'mutating-derived-view',
      version: '1.0.0',
      timeoutMs: 500,
      invalidate: request => {
        ;(request.memoryIds as string[]).push('injected-id')
      },
    })
    let secondProviderIds: readonly string[] = []
    registry.register({
      id: 'observing-derived-view',
      version: '1.0.0',
      timeoutMs: 500,
      invalidate: request => {
        secondProviderIds = [...request.memoryIds]
      },
    })

    await registry.invalidate(['authoritative-id'])

    expect(secondProviderIds).toEqual(['authoritative-id'])
  })
})
