import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AdvancedRetrievalRegistry,
  GraphRelationshipRecallAdapter,
  PageIndexRecallAdapter,
} from '../src/advanced-retrieval.js'
import { MemoryRetrievalEngine } from '../src/retrieval.js'
import { openMemoryArchive } from '../src/index.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

describe('advanced retrieval policy', () => {
  it('keeps new adapters disabled, then runs local shadow without changing BM25 items', async () => {
    const registry = new AdvancedRetrievalRegistry()
    let calls = 0
    const adapter = new PageIndexRecallAdapter({
      id: 'page-fixture',
      version: '1.0.0',
      dataBoundary: 'local-process',
      search: async (request) => {
        calls += 1
        return request.pages.flatMap(page => page.memoryIds.slice(0, 1).map(memoryId => ({
          memoryId, score: 10, reason: 'page-fixture-hit',
        })))
      },
    })
    registry.register(adapter)
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-advanced-shadow-'))
    const archive = await openMemoryArchive({
      path: join(root, 'memory.jsonl'),
      retrievalEngine: new MemoryRetrievalEngine({ advancedProviderSource: registry }),
    })
    const memory = await archive.observeExplicit({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'shadow-source',
      text: '请记住：高级召回中性关键词。',
      memoryKind: 'summary',
    })
    if (memory === undefined) throw new Error('shadow fixture missing')

    const disabled = await archive.retrieve({ context: PERSONAL_COMPANION_ACCESS, query: '高级召回' })
    expect(calls).toBe(0)
    registry.configure('page-fixture', { mode: 'shadow', ownerConfirmed: true, timeoutMs: 500, weight: 1 })
    const shadow = await archive.retrieve({ context: PERSONAL_COMPANION_ACCESS, query: '高级召回' })
    expect(calls).toBe(1)
    expect(shadow.items.map(item => item.memory.id)).toEqual(disabled.items.map(item => item.memory.id))
    expect(shadow.shadowComparisons).toEqual([
      expect.objectContaining({ providerId: 'page-fixture', capability: 'page-index', status: 'completed' }),
    ])
    expect(JSON.stringify(shadow.shadowComparisons)).not.toContain(memory.content)
  })

  it('requires Owner confirmation for opt-in and forbids remote projection in RC.6', () => {
    const registry = new AdvancedRetrievalRegistry()
    registry.register(new GraphRelationshipRecallAdapter({
      id: 'graph-fixture', version: '1.0.0', dataBoundary: 'local-process', search: async () => [],
    }))
    expect(() => registry.configure('graph-fixture', {
      mode: 'opt-in', ownerConfirmed: false, timeoutMs: 500, weight: 1,
    })).toThrow('Owner confirmation')

    registry.register(new PageIndexRecallAdapter({
      id: 'remote-fixture', version: '1.0.0', dataBoundary: 'remote', search: async () => [],
    }))
    expect(() => registry.configure('remote-fixture', {
      mode: 'shadow', ownerConfirmed: true, timeoutMs: 500, weight: 1,
    })).toThrow('remote advanced retrieval is disabled')
  })

  it('does not let a stale disposer remove a replacement registration', () => {
    const registry = new AdvancedRetrievalRegistry()
    const first = new PageIndexRecallAdapter({
      id: 'replaceable-page', version: '1.0.0', dataBoundary: 'local-process', search: async () => [],
    })
    const disposeFirst = registry.register(first)
    disposeFirst()
    registry.register(new PageIndexRecallAdapter({
      id: 'replaceable-page', version: '2.0.0', dataBoundary: 'local-process', search: async () => [],
    }))
    disposeFirst()
    registry.configure('replaceable-page', {
      mode: 'shadow', ownerConfirmed: true, timeoutMs: 500, weight: 1,
    })

    expect(registry.plans()).toEqual([
      expect.objectContaining({ provider: expect.objectContaining({ version: '2.0.0' }) }),
    ])
  })

  it('contains timeout failure and keeps the baseline result', async () => {
    const registry = new AdvancedRetrievalRegistry()
    registry.register(new GraphRelationshipRecallAdapter({
      id: 'slow-graph',
      version: '1.0.0',
      dataBoundary: 'local-process',
      search: (_request, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    }))
    registry.configure('slow-graph', { mode: 'shadow', ownerConfirmed: true, timeoutMs: 10, weight: 1 })
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-advanced-timeout-'))
    const archive = await openMemoryArchive({
      path: join(root, 'memory.jsonl'),
      retrievalEngine: new MemoryRetrievalEngine({ advancedProviderSource: registry }),
    })
    const memory = await archive.observeExplicit({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'timeout-source',
      text: '请记住：超时降级中性关键词。',
      memoryKind: 'summary',
    })
    const snapshot = await archive.retrieve({ context: PERSONAL_COMPANION_ACCESS, query: '超时降级' })
    expect(snapshot.items[0]?.memory.id).toBe(memory?.id)
    expect(snapshot.shadowComparisons).toEqual([
      expect.objectContaining({ providerId: 'slow-graph', status: 'timed-out' }),
    ])
  })

  it('propagates a request that was already cancelled before provider dispatch', async () => {
    const registry = new AdvancedRetrievalRegistry()
    let receivedAborted = false
    registry.register(new PageIndexRecallAdapter({
      id: 'cancelled-page',
      version: '1.0.0',
      dataBoundary: 'local-process',
      search: async (_request, signal) => {
        receivedAborted = signal.aborted
        return []
      },
    }))
    registry.configure('cancelled-page', { mode: 'shadow', ownerConfirmed: true, timeoutMs: 500, weight: 1 })
    const controller = new AbortController()
    controller.abort(new Error('fixture cancellation'))

    await new MemoryRetrievalEngine({ advancedProviderSource: registry }).retrieve([], {
      context: PERSONAL_COMPANION_ACCESS,
      query: '取消传播',
    }, '2026-08-20T00:00:00.000Z', controller.signal)

    expect(receivedAborted).toBe(true)
  })

  it('opt-in fuses only Archive-allowed IDs from the filtered projection', async () => {
    const registry = new AdvancedRetrievalRegistry()
    let serializedRequest = ''
    registry.register(new PageIndexRecallAdapter({
      id: 'opt-in-page',
      version: '1.0.0',
      dataBoundary: 'local-process',
      search: async request => {
        serializedRequest = JSON.stringify(request)
        return [
          { memoryId: request.pages[0]?.memoryIds[0], score: 20, reason: 'page-opt-in-hit' },
          { memoryId: 'unknown-memory', score: 100, reason: 'unknown-id' },
        ]
      },
    }))
    registry.configure('opt-in-page', { mode: 'opt-in', ownerConfirmed: true, timeoutMs: 500, weight: 2 })
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-advanced-opt-in-'))
    const archive = await openMemoryArchive({
      path: join(root, 'memory.jsonl'),
      retrievalEngine: new MemoryRetrievalEngine({ advancedProviderSource: registry }),
    })
    const visible = await archive.observeExplicit({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'opt-in-visible',
      text: '请记住：可投影的中性条目。',
      memoryKind: 'summary',
    })
    await archive.observeExplicit({
      context: { ...PERSONAL_COMPANION_ACCESS, ownerId: 'other-owner' },
      sourceMessageId: 'opt-in-other-owner',
      text: '请记住：其他所有者的隔离条目。',
      memoryKind: 'summary',
    })

    const snapshot = await archive.retrieve({ context: PERSONAL_COMPANION_ACCESS, query: '可投影' })

    expect(snapshot.items.map(item => item.memory.id)).toEqual([visible?.id])
    expect(snapshot.items[0]?.reasons).toContainEqual(expect.objectContaining({
      providerId: 'opt-in-page', reason: 'page-opt-in-hit',
    }))
    expect(serializedRequest).not.toContain('other-owner')
    expect(serializedRequest).not.toContain('ownerId')
    expect(serializedRequest).not.toContain('scope')
    expect(serializedRequest).not.toContain('sourceMessageId')
  })

  it('isolates the filtered projection between untrusted advanced Providers', async () => {
    const registry = new AdvancedRetrievalRegistry()
    registry.register(new PageIndexRecallAdapter({
      id: 'mutating-page',
      version: '1.0.0',
      dataBoundary: 'local-process',
      search: request => {
        const entry = request.pages[0]?.entries[0]
        if (entry !== undefined) (entry as { content: string }).content = 'injected provider mutation'
        return []
      },
    }))
    let graphContent = ''
    registry.register(new GraphRelationshipRecallAdapter({
      id: 'observing-graph',
      version: '1.0.0',
      dataBoundary: 'local-process',
      search: request => {
        graphContent = request.nodes[0]?.content ?? ''
        return []
      },
    }))
    registry.configure('mutating-page', { mode: 'shadow', ownerConfirmed: true, timeoutMs: 500, weight: 1 })
    registry.configure('observing-graph', { mode: 'shadow', ownerConfirmed: true, timeoutMs: 500, weight: 1 })
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-advanced-isolation-'))
    const archive = await openMemoryArchive({
      path: join(root, 'memory.jsonl'),
      retrievalEngine: new MemoryRetrievalEngine({ advancedProviderSource: registry }),
    })
    await archive.observeExplicit({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'advanced-isolation-source',
      text: '请记住：Provider 隔离原始内容。',
      memoryKind: 'summary',
    })

    await archive.retrieve({ context: PERSONAL_COMPANION_ACCESS, query: 'Provider 隔离' })

    expect(graphContent).toBe('Provider 隔离原始内容。')
  })
})
