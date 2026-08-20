import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  MemoryScheduledApprovalRunnerRegistryV1,
  createMemoryApprovalSchedulerV1,
} from '../src/approval-scheduler.js'
import {
  createMemoryRuntimeSettingsManager,
  updateMemoryApprovalPolicy,
} from '../src/runtime-settings.js'

async function fixture(now = new Date('2026-08-20T18:00:00.000Z')) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-scheduler-'))
  const settingsPath = join(root, 'settings.json')
  await updateMemoryApprovalPolicy(settingsPath, 8, {
    expectedRevision: 0,
    mode: 'scheduled-auto',
    timeZone: 'Asia/Shanghai',
    localTime: '03:30',
  })
  let clock = now
  const runners = new MemoryScheduledApprovalRunnerRegistryV1()
  const options = {
    settings: createMemoryRuntimeSettingsManager({ path: settingsPath, fallbackRecallLimit: 8 }),
    statePath: join(root, 'approval-scheduler.json'),
    runners,
    now: () => clock,
    leaseTimeoutMs: 2_000,
    leaseStaleMs: 10_000,
  }
  return {
    settingsPath,
    runners,
    options,
    setNow(value: string) { clock = new Date(value) },
  }
}

describe('Memory scheduled approval lifecycle', () => {
  it('arms the next local slot when first observing an enabled policy', async () => {
    const target = await fixture()
    const run = vi.fn()
    target.runners.register({ id: 'fixture', version: '1', run })

    await expect(createMemoryApprovalSchedulerV1(target.options).check()).resolves.toEqual({
      schemaVersion: 1,
      kind: 'armed',
      policyRevision: 1,
      slot: {
        localDate: '2026-08-21',
        dueAt: '2026-08-20T19:30:00.000Z',
      },
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('records one payload-free receipt and never repeats the same local-date run', async () => {
    const target = await fixture()
    const run = vi.fn(async () => ({
      schemaVersion: 1 as const,
      reviewedCandidates: 4,
      approvedCandidates: 2,
      rejectedCandidates: 1,
      deferredCandidates: 1,
      reviewReceipts: [],
    }))
    target.runners.register({ id: 'fixture', version: '1', run })
    const scheduler = createMemoryApprovalSchedulerV1(target.options)
    await scheduler.check()
    target.setNow('2026-08-20T19:31:00.000Z')

    await expect(scheduler.check()).resolves.toMatchObject({
      kind: 'completed',
      receipt: {
        runId: 'scheduled-auto:r1:2026-08-21',
        policyRevision: 1,
        localDate: '2026-08-21',
        outcome: 'completed',
        runnerId: 'fixture',
        runnerVersion: '1',
        reviewedCandidates: 4,
        approvedCandidates: 2,
        rejectedCandidates: 1,
        deferredCandidates: 1,
        reviewReceipts: [],
      },
    })
    await expect(createMemoryApprovalSchedulerV1(target.options).check()).resolves.toMatchObject({
      kind: 'waiting',
      slot: { localDate: '2026-08-22' },
    })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent processes through one lease', async () => {
    const target = await fixture()
    let releaseRun: (() => void) | undefined
    const run = vi.fn(async () => {
      await new Promise<void>(resolve => { releaseRun = resolve })
      return {
        schemaVersion: 1 as const,
        reviewedCandidates: 0,
        approvedCandidates: 0,
        rejectedCandidates: 0,
        deferredCandidates: 0,
        reviewReceipts: [],
      }
    })
    target.runners.register({ id: 'fixture', version: '1', run })
    const first = createMemoryApprovalSchedulerV1(target.options)
    const second = createMemoryApprovalSchedulerV1(target.options)
    await first.check()
    target.setNow('2026-08-20T19:31:00.000Z')

    const firstCheck = first.check()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    const secondCheck = second.check()
    releaseRun?.()

    await expect(firstCheck).resolves.toMatchObject({ kind: 'completed' })
    await expect(secondCheck).resolves.toMatchObject({ kind: 'waiting' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('records a failed attempt without persisting exception text or retrying that day', async () => {
    const target = await fixture()
    const run = vi.fn(async () => { throw new Error('candidate payload must not enter state') })
    target.runners.register({ id: 'fixture', version: '1', run })
    const scheduler = createMemoryApprovalSchedulerV1(target.options)
    await scheduler.check()
    target.setNow('2026-08-20T19:31:00.000Z')

    await expect(scheduler.check()).resolves.toMatchObject({
      kind: 'failed',
      receipt: { outcome: 'failed', localDate: '2026-08-21' },
    })
    await expect(scheduler.check()).resolves.toMatchObject({ kind: 'waiting' })
    expect(JSON.stringify(await scheduler.inspect())).not.toContain('candidate payload')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('marks a completed runner stale when the policy revision changes during execution', async () => {
    const target = await fixture()
    target.runners.register({
      id: 'fixture',
      version: '1',
      run: async () => {
        await updateMemoryApprovalPolicy(target.settingsPath, 8, {
          expectedRevision: 1,
          mode: 'manual',
        })
        return {
          schemaVersion: 1,
          reviewedCandidates: 0,
          approvedCandidates: 0,
          rejectedCandidates: 0,
          deferredCandidates: 0,
          reviewReceipts: [],
        }
      },
    })
    const scheduler = createMemoryApprovalSchedulerV1(target.options)
    await scheduler.check()
    target.setNow('2026-08-20T19:31:00.000Z')

    await expect(scheduler.check()).resolves.toMatchObject({
      kind: 'stale-policy',
      receipt: { outcome: 'stale-policy', policyRevision: 1 },
    })
    await expect(scheduler.check()).resolves.toMatchObject({ kind: 'disabled', policyRevision: 2 })
  })

  it('cancels an in-flight runner on lifecycle disposal without consuming the slot', async () => {
    const target = await fixture()
    let observedSignal: AbortSignal | undefined
    const run = vi.fn(async (request: { signal: AbortSignal }) => {
      observedSignal = request.signal
      await new Promise<void>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
      throw new Error('unreachable')
    })
    target.runners.register({ id: 'fixture', version: '1', run })
    const scheduler = createMemoryApprovalSchedulerV1(target.options)
    await scheduler.check()
    target.setNow('2026-08-20T19:31:00.000Z')

    const dispose = scheduler.start()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await dispose()

    expect(observedSignal?.aborted).toBe(true)
    await expect(scheduler.inspect()).resolves.toMatchObject({
      armed: { slot: { localDate: '2026-08-21' } },
      receipts: [],
    })
  })
})
