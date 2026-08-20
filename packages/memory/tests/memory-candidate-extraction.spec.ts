import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CandidateExtractionRegistry,
  extractMemoryCandidates,
  parseCandidateExtractionResultV1,
  type CandidateExtractionProvider,
  type CandidateExtractionRequestV1,
} from '../src/candidate-extraction.js'
import { openMemoryArchive } from '../src/index.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

const request: CandidateExtractionRequestV1 = {
  schemaVersion: 1,
  sessionId: 'session-fixture',
  turn: 3,
  context: PERSONAL_COMPANION_ACCESS,
  evidence: [{ messageId: 'owner-message-1', text: '中性的偏好陈述。' }],
}

describe('candidate extraction provider boundary', () => {
  it('accepts a bounded strict result whose drafts cite selected Owner evidence', () => {
    expect(parseCandidateExtractionResultV1({
      schemaVersion: 1,
      receipt: { kind: 'local-deterministic', implementationVersion: 'fixture-v1' },
      drafts: [{
        sourceMessageId: 'owner-message-1',
        content: 'Owner 偏好中性示例 A。',
        visibility: 'personal',
        memoryKind: 'preference',
      }],
    }, request)).toEqual({
      schemaVersion: 1,
      receipt: { kind: 'local-deterministic', implementationVersion: 'fixture-v1' },
      drafts: [{
        sourceMessageId: 'owner-message-1',
        content: 'Owner 偏好中性示例 A。',
        visibility: 'personal',
        memoryKind: 'preference',
      }],
    })
  })

  it.each([
    { label: 'unknown result fields', value: { schemaVersion: 1, receipt: { kind: 'local-deterministic', implementationVersion: 'v1' }, drafts: [], extra: true } },
    { label: 'unselected source', value: { schemaVersion: 1, receipt: { kind: 'local-deterministic', implementationVersion: 'v1' }, drafts: [{ sourceMessageId: 'other', content: '中性内容', visibility: 'personal', memoryKind: 'summary' }] } },
    { label: 'model result without DSH receipt', value: { schemaVersion: 1, receipt: { kind: 'dsh-session', sessionId: '', requestSeq: 1, responseSeq: 2 }, drafts: [] } },
    { label: 'too many drafts', value: { schemaVersion: 1, receipt: { kind: 'local-deterministic', implementationVersion: 'v1' }, drafts: Array.from({ length: 9 }, (_, index) => ({ sourceMessageId: 'owner-message-1', content: `中性内容 ${index}`, visibility: 'personal', memoryKind: 'summary' })) } },
  ])('rejects $label', ({ value }) => {
    expect(() => parseCandidateExtractionResultV1(value, request)).toThrow()
  })

  it('atomically stores a source batch as pending and makes exact retries idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-extraction-batch-'))
    const path = join(root, 'memory.jsonl')
    let nextId = 0
    let nextTime = 0
    const archive = await openMemoryArchive({
      path,
      createId: () => `event-${++nextId}`,
      now: () => new Date(Date.parse('2026-08-20T12:00:00.000Z') + nextTime++ * 1_000),
    })
    const input = {
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'owner-message-1',
      providerId: 'fixture-extractor',
      providerVersion: '1.0.0',
      receipt: { kind: 'local-deterministic' as const, implementationVersion: 'fixture-v1' },
      drafts: [
        { content: 'Owner 偏好中性示例 A。', visibility: 'personal' as const, memoryKind: 'preference' as const },
        { content: 'Owner 记录中性事件 B。', visibility: 'personal' as const, memoryKind: 'episode' as const },
      ],
    }

    const first = await archive.proposeExtracted(input)
    const retry = await archive.proposeExtracted(input)
    expect(retry.map(item => item.id)).toEqual(first.map(item => item.id))
    expect(first).toHaveLength(2)
    expect(first.every(item => item.status === 'pending')).toBe(true)
    expect(first[0]?.extraction).toMatchObject({ providerId: 'fixture-extractor', providerVersion: '1.0.0' })
    expect(archive.recall({ context: PERSONAL_COMPANION_ACCESS, query: '中性' })).toEqual([])

    const lines = (await readFile(path, 'utf8')).trim().split(/\r?\n/u)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!) as { events: unknown[] }).toMatchObject({ events: [{ event: 'observation' }, { event: 'candidate' }, { event: 'candidate' }] })

    await expect(archive.proposeExtracted({
      ...input,
      drafts: [{ content: '漂移后的中性内容。', visibility: 'personal', memoryKind: 'summary' }],
    })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_CONFLICT' })
  })

  it('registers one Provider and validates before the Archive consumer writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-extraction-provider-'))
    const archive = await openMemoryArchive({ path: join(root, 'memory.jsonl') })
    const provider: CandidateExtractionProvider = {
      id: 'fixture-provider',
      version: '1.0.0',
      executionKind: 'local-deterministic',
      extract: async () => ({
        schemaVersion: 1,
        receipt: { kind: 'local-deterministic', implementationVersion: 'fixture-v1' },
        drafts: [{ sourceMessageId: 'owner-message-1', content: '中性自动候选。', visibility: 'personal', memoryKind: 'summary' }],
      }),
    }
    const registry = new CandidateExtractionRegistry()
    const dispose = registry.register(provider)
    expect(registry.current()).toBe(provider)
    const candidates = await extractMemoryCandidates(provider, request, archive, {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ status: 'pending', sourceMessageId: 'owner-message-1' })
    dispose()
    expect(registry.current()).toBeUndefined()
  })

  it('aborts and rejects a Provider that exceeds its bounded deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-extraction-timeout-'))
    const archive = await openMemoryArchive({ path: join(root, 'memory.jsonl') })
    let observedAbort = false
    const provider: CandidateExtractionProvider = {
      id: 'slow-fixture',
      version: '1.0.0',
      executionKind: 'local-deterministic',
      extract: (_input, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          observedAbort = true
          reject(signal.reason)
        }, { once: true })
      }),
    }
    await expect(extractMemoryCandidates(provider, request, archive, {
      signal: new AbortController().signal,
      timeoutMs: 5,
    })).rejects.toThrow('timed out')
    expect(observedAbort).toBe(true)
    expect(archive.listCandidates({ context: PERSONAL_COMPANION_ACCESS })).toEqual([])
  })
})
