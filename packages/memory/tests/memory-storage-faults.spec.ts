import { open, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  createFileArchiveLeaseAdapter,
  MemoryArchiveError,
  MemoryArchiveStorage,
  type ArchiveCommitWriter,
  type ArchiveCheckpointWriter,
  type ArchiveLeaseAcquire,
  type MemoryDomainEvent,
  writeArchiveCheckpoint,
} from '../src/storage/index.js'

function confirmed(id: string, sourceMessageId: string): MemoryDomainEvent[] {
  const observationId = `observation-${id}`
  return [{
    schemaVersion: 1, event: 'observation', id: observationId,
    ownerId: 'owner-fixture', authority: 'local-dsh-host-rpc',
    scope: { version: 1, kind: 'companion-reality' },
    source: { kind: 'dsh-message', id: sourceMessageId }, observedAt: '2026-08-18T00:00:00.000Z',
  }, {
    schemaVersion: 2,
    id, ownerId: 'owner-fixture', scope: { version: 1, kind: 'companion-reality' },
    observationId, memoryKind: 'summary', recordedAt: '2026-08-18T00:00:00.000Z',
    createdAt: '2026-08-18T00:00:00.000Z',
    content: `Neutral memory ${id}`,
    visibility: 'personal',
    sourceMessageId,
    status: 'confirmed',
  }]
}

function deferred(): { promise: Promise<void>, resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function appendBytes(path: string, bytes: Buffer, sync: boolean): Promise<void> {
  const handle = await open(path, 'a')
  try {
    await handle.writeFile(bytes)
    if (sync) await handle.sync()
  } finally {
    await handle.close()
  }
}

describe('memory storage failure boundaries', () => {
  it.each([
    {
      name: 'append failure',
      writer: {
        appendAndFlush: async () => { throw new Error('injected append failure') },
      } satisfies ArchiveCommitWriter,
      reopenedState: 'ready',
    },
    {
      name: 'partial write',
      writer: {
        appendAndFlush: async (path: string, bytes: Buffer) => {
          await appendBytes(path, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))), true)
          throw new Error('injected partial write')
        },
      } satisfies ArchiveCommitWriter,
      reopenedState: 'quarantined',
    },
    {
      name: 'flush failure',
      writer: {
        appendAndFlush: async (path: string, bytes: Buffer) => {
          await appendBytes(path, bytes, false)
          throw new Error('injected flush failure')
        },
      } satisfies ArchiveCommitWriter,
      reopenedState: 'quarantined',
    },
  ])('does not publish a snapshot after $name', async ({ writer, reopenedState }) => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-storage-fault-'))
    const path = join(root, 'memories.jsonl')
    const storage = await MemoryArchiveStorage.open({ path, commitWriter: writer })
    const before = storage.snapshot()

    await expect(storage.transact(() => ({
      events: confirmed('memory-fault', 'source-fault'),
      result: 'committed',
    }))).rejects.toThrow('injected')

    expect(storage.snapshot()).toEqual(before)
    const reopened = await MemoryArchiveStorage.open({ path })
    expect(reopened.inspection().state).toBe(reopenedState)
    expect(reopened.snapshot()?.records ?? []).toHaveLength(0)
  })

  it('maps timeout, compromise, and release failures to stable lease errors', async () => {
    const timeoutAcquire: ArchiveLeaseAcquire = async () => {
      throw Object.assign(new Error('locked'), { code: 'ELOCKED' })
    }
    await expect(createFileArchiveLeaseAdapter(timeoutAcquire).withExclusiveLease(
      'neutral-timeout.jsonl',
      100,
      async () => undefined,
    )).rejects.toMatchObject({ code: 'MEMORY_LEASE_TIMEOUT' })

    let compromise: ((error: Error) => void) | undefined
    const compromiseAcquire: ArchiveLeaseAcquire = async (_path, options) => {
      compromise = options.onCompromised
      return async () => undefined
    }
    await expect(createFileArchiveLeaseAdapter(compromiseAcquire).withExclusiveLease(
      'neutral-compromise.jsonl',
      100,
      async lease => {
        compromise?.(new Error('injected compromise'))
        lease.assertHeld()
      },
    )).rejects.toMatchObject({ code: 'MEMORY_LEASE_COMPROMISED' })

    const releaseAcquire: ArchiveLeaseAcquire = async () => async () => {
      throw new Error('injected release failure')
    }
    await expect(createFileArchiveLeaseAdapter(releaseAcquire).withExclusiveLease(
      'neutral-release.jsonl',
      100,
      async () => 'durable-result',
    )).rejects.toMatchObject({ code: 'MEMORY_LEASE_RELEASE_FAILED' })
  })

  it.each(['append', 'partial', 'flush', 'checkpoint'] as const)(
    'keeps a two-event candidate approval atomic across the %s boundary',
    async fault => {
      const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-approval-fault-'))
      const path = join(root, 'memories.jsonl')
      let appendCount = 0
      const commitWriter: ArchiveCommitWriter = {
        appendAndFlush: async (target, bytes) => {
          appendCount += 1
          if (appendCount === 1 || fault === 'checkpoint') return appendBytes(target, bytes, true)
          if (fault === 'append') throw new Error('injected approval append failure')
          if (fault === 'partial') {
            await appendBytes(target, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))), true)
            throw new Error('injected approval partial write')
          }
          await appendBytes(target, bytes, false)
          throw new Error('injected approval flush failure')
        },
      }
      let checkpointCount = 0
      const checkpointWriter: ArchiveCheckpointWriter = {
        write: async (target, parsed) => {
          checkpointCount += 1
          if (fault === 'checkpoint' && checkpointCount === 2) {
            throw new Error('injected approval checkpoint failure')
          }
          await writeArchiveCheckpoint(target, parsed)
        },
      }
      const transactionIds = ['candidate-transaction', 'approval-transaction']
      const storage = await MemoryArchiveStorage.open({
        path,
        commitWriter,
        checkpointWriter,
        createTransactionId: () => transactionIds.shift() ?? 'unexpected-transaction',
      })
      const candidateObservation: MemoryDomainEvent = {
        schemaVersion: 1, event: 'observation', id: 'candidate-observation', ownerId: 'owner-fixture',
        authority: 'local-dsh-host-rpc', scope: { version: 1, kind: 'companion-reality' },
        source: { kind: 'governance-operation', id: 'proposal-source' }, observedAt: '2026-08-18T00:00:00.000Z',
      }
      const candidate: MemoryDomainEvent = {
        schemaVersion: 2,
        event: 'candidate',
        id: 'candidate-1',
        ownerId: 'owner-fixture', scope: { version: 1, kind: 'companion-reality' },
        observationId: 'candidate-observation', memoryKind: 'summary', recordedAt: '2026-08-18T00:00:00.000Z',
        createdAt: '2026-08-18T00:00:00.000Z',
        content: 'Neutral approval candidate',
        visibility: 'personal',
        sourceMessageId: 'proposal-source',
        status: 'pending',
      }
      await storage.transact(() => ({ events: [candidateObservation, candidate], result: undefined }))
      const approvalObservation: MemoryDomainEvent = {
        schemaVersion: 1, event: 'observation', id: 'approval-observation', ownerId: 'owner-fixture',
        authority: 'local-dsh-host-rpc', scope: { version: 1, kind: 'companion-reality' },
        source: { kind: 'governance-operation', id: 'approval-source' }, observedAt: '2026-08-18T00:00:00.000Z',
      }
      const approvedMemory: MemoryDomainEvent = {
        schemaVersion: 2,
        id: 'memory-approved',
        ownerId: 'owner-fixture', scope: { version: 1, kind: 'companion-reality' },
        observationId: 'approval-observation', memoryKind: 'summary', recordedAt: '2026-08-18T00:00:00.000Z',
        createdAt: '2026-08-18T00:00:00.000Z',
        content: 'Neutral approved memory',
        visibility: 'personal',
        sourceMessageId: 'approval-source',
        status: 'confirmed',
        sourceCandidateId: 'candidate-1',
      }
      const resolution: MemoryDomainEvent = {
        schemaVersion: 2,
        event: 'candidate-resolution',
        id: 'resolution-1',
        ownerId: 'owner-fixture', scope: { version: 1, kind: 'companion-reality' },
        observationId: 'approval-observation',
        createdAt: '2026-08-18T00:00:00.000Z',
        candidateId: 'candidate-1',
        decision: 'approved',
        sourceMessageId: 'approval-source',
        memoryId: 'memory-approved',
      }

      await expect(storage.transact(() => ({
        events: [approvalObservation, approvedMemory, resolution],
        result: undefined,
      }))).rejects.toThrow('injected approval')

      expect(storage.snapshot()).toMatchObject({
        records: [],
        candidates: [{ id: 'candidate-1', status: 'pending' }],
      })
      const reopened = await MemoryArchiveStorage.open({ path })
      expect([2, 5]).toContain(reopened.inspection().eventCount)
      expect(reopened.inspection().eventCount).not.toBe(3)
      if (reopened.inspection().state === 'ready') {
        expect(reopened.snapshot()?.records).toHaveLength(0)
        expect(reopened.snapshot()?.candidates).toEqual([expect.objectContaining({ status: 'pending' })])
      }
    },
  )

  it('does not append when the mutation aborts before commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-storage-abort-'))
    const path = join(root, 'memories.jsonl')
    const storage = await MemoryArchiveStorage.open({ path })
    const before = await readFile(path)

    await expect(storage.transact(() => { throw new Error('injected abort') })).rejects.toThrow('injected abort')

    expect(await readFile(path)).toEqual(before)
    expect(storage.snapshot()?.records).toHaveLength(0)
  })

  it('waits for an in-flight commit during bounded dispose and rejects later mutations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-storage-dispose-'))
    const path = join(root, 'memories.jsonl')
    const entered = deferred()
    const resume = deferred()
    const writer: ArchiveCommitWriter = {
      appendAndFlush: async (target, bytes) => {
        entered.resolve()
        await resume.promise
        await appendBytes(target, bytes, true)
      },
    }
    const storage = await MemoryArchiveStorage.open({ path, commitWriter: writer, disposeTimeoutMs: 1_000 })
    const commit = storage.transact(() => ({
      events: confirmed('memory-dispose', 'source-dispose'),
      result: 'committed',
    }))
    await entered.promise

    const disposing = storage.dispose()
    resume.resolve()
    await expect(commit).resolves.toBe('committed')
    await expect(disposing).resolves.toBeUndefined()
    await expect(storage.transact(() => ({ events: [], result: undefined })))
      .rejects.toMatchObject({ code: 'MEMORY_ARCHIVE_DISPOSED' })
  })

  it('serializes the same path while allowing a different archive path to proceed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-storage-lease-'))
    const firstPath = join(root, 'first.jsonl')
    const secondPath = join(root, 'second.jsonl')
    await MemoryArchiveStorage.open({ path: firstPath })
    await MemoryArchiveStorage.open({ path: secondPath })
    const entered = deferred()
    const resume = deferred()

    const holding = MemoryArchiveStorage.withExclusiveLease(firstPath, 1_000, async () => {
      entered.resolve()
      await resume.promise
    })
    await entered.promise

    await expect(MemoryArchiveStorage.withExclusiveLease(secondPath, 1_000, async () => 'second'))
      .resolves.toBe('second')
    await expect(MemoryArchiveStorage.withExclusiveLease(firstPath, 100, async () => 'unexpected'))
      .rejects.toMatchObject({ code: 'MEMORY_LEASE_TIMEOUT' })
    resume.resolve()
    await holding
  })
})
