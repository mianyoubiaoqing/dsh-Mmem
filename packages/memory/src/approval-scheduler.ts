import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { lock as acquireProperLock } from 'proper-lockfile'
import { calculateMemoryApprovalScheduleV1, type MemoryApprovalScheduleSlotV1 } from './approval-schedule.js'
import type { MemoryApprovalPolicyV1 } from './approval-policy.js'
import type { MemoryRuntimeSettingsManagerV1 } from './runtime-settings.js'

/** Payload-free request for one idempotent local-date approval run. */
export interface MemoryScheduledApprovalRunRequestV1 {
  schemaVersion: 1
  runId: string
  policy: Extract<MemoryApprovalPolicyV1, { mode: 'scheduled-auto' }>
  slot: MemoryApprovalScheduleSlotV1
  signal: AbortSignal
}

/** Aggregate result returned by a scheduled approval runner. */
export interface MemoryScheduledApprovalRunResultV1 {
  schemaVersion: 1
  reviewedCandidates: number
  approvedCandidates: number
  rejectedCandidates: number
  deferredCandidates: number
}

/** Replaceable runner Adapter invoked only after scheduler governance succeeds. */
export interface MemoryScheduledApprovalRunnerV1 {
  readonly id: string
  readonly version: string
  run(request: MemoryScheduledApprovalRunRequestV1): Promise<MemoryScheduledApprovalRunResultV1>
}

/** Single-active scheduled runner registry owned by the Memory runtime. */
export class MemoryScheduledApprovalRunnerRegistryV1 {
  #runner: MemoryScheduledApprovalRunnerV1 | undefined

  register(runner: MemoryScheduledApprovalRunnerV1): () => void {
    if (this.#runner !== undefined) throw new Error('a scheduled approval runner is already active')
    if (runner.id.trim() === '' || runner.version.trim() === '') {
      throw new Error('scheduled approval runner id and version must be non-empty')
    }
    this.#runner = runner
    return () => {
      if (this.#runner === runner) this.#runner = undefined
    }
  }

  current(): MemoryScheduledApprovalRunnerV1 | undefined {
    return this.#runner
  }
}

interface MemoryApprovalSchedulerArmV1 {
  policyRevision: number
  timeZone: string
  localTime: string
  slot: MemoryApprovalScheduleSlotV1
}

/** Persisted payload-free receipt for one attempted local-date run. */
export interface MemoryApprovalRunReceiptV1 {
  schemaVersion: 1
  runId: string
  policyRevision: number
  timeZone: string
  localTime: string
  localDate: string
  dueAt: string
  startedAt: string
  completedAt: string
  outcome: 'completed' | 'failed' | 'stale-policy'
  runnerId: string
  runnerVersion: string
  reviewedCandidates?: number
  approvedCandidates?: number
  rejectedCandidates?: number
  deferredCandidates?: number
}

/** Versioned scheduler checkpoint containing no Candidate or Memory payload. */
export interface MemoryApprovalSchedulerStateV1 {
  schemaVersion: 1
  armed?: MemoryApprovalSchedulerArmV1
  receipts: MemoryApprovalRunReceiptV1[]
}

/** Observable result of one scheduler check. */
export type MemoryApprovalSchedulerCheckV1 = {
  schemaVersion: 1
  kind: 'disabled'
  policyRevision: number
} | {
  schemaVersion: 1
  kind: 'armed' | 'waiting' | 'runner-unavailable'
  policyRevision: number
  slot: MemoryApprovalScheduleSlotV1
} | {
  schemaVersion: 1
  kind: 'completed' | 'failed' | 'stale-policy'
  receipt: MemoryApprovalRunReceiptV1
} | {
  schemaVersion: 1
  kind: 'cancelled'
}

/** Cancellable scheduler lifecycle used by the Cordis plugin and deterministic tests. */
export interface MemoryApprovalSchedulerV1 {
  check(signal?: AbortSignal): Promise<MemoryApprovalSchedulerCheckV1>
  inspect(): Promise<MemoryApprovalSchedulerStateV1>
  start(): () => Promise<void>
}

interface TimerHandleV1 {
  cancel(): void
}

export interface MemoryApprovalSchedulerOptionsV1 {
  settings: MemoryRuntimeSettingsManagerV1
  statePath: string
  runners: MemoryScheduledApprovalRunnerRegistryV1
  now?: () => Date
  pollIntervalMs?: number
  leaseTimeoutMs?: number
  leaseStaleMs?: number
  /** @internal System timer seam for lifecycle tests. */
  schedule?: (task: () => void, delayMs: number) => TimerHandleV1
  onError?: (error: unknown) => void
}

const MAX_RECEIPTS = 90

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted()
  const keys = [...expected].toSorted()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} contains missing or unknown fields`)
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be non-empty`)
  return value
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function revision(value: unknown): number {
  return count(value, 'scheduler policyRevision')
}

function timestamp(value: unknown, label: string): string {
  const source = nonEmpty(value, label)
  const parsed = new Date(source)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== source) {
    throw new Error(`${label} must be a canonical ISO timestamp`)
  }
  return source
}

function localDate(value: unknown): string {
  const source = nonEmpty(value, 'scheduler localDate')
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(source)) throw new Error('scheduler localDate must use YYYY-MM-DD')
  return source
}

function slot(value: unknown): MemoryApprovalScheduleSlotV1 {
  const source = object(value, 'scheduler slot')
  exactKeys(source, ['localDate', 'dueAt'], 'scheduler slot')
  return { localDate: localDate(source.localDate), dueAt: timestamp(source.dueAt, 'scheduler dueAt') }
}

function arm(value: unknown): MemoryApprovalSchedulerArmV1 {
  const source = object(value, 'scheduler arm')
  exactKeys(source, ['policyRevision', 'timeZone', 'localTime', 'slot'], 'scheduler arm')
  return {
    policyRevision: revision(source.policyRevision),
    timeZone: nonEmpty(source.timeZone, 'scheduler timeZone'),
    localTime: nonEmpty(source.localTime, 'scheduler localTime'),
    slot: slot(source.slot),
  }
}

function receipt(value: unknown): MemoryApprovalRunReceiptV1 {
  const source = object(value, 'scheduler receipt')
  const outcome = source.outcome
  if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'stale-policy') {
    throw new Error('scheduler receipt outcome is unsupported')
  }
  const aggregateKeys = outcome === 'failed'
    ? []
    : ['reviewedCandidates', 'approvedCandidates', 'rejectedCandidates', 'deferredCandidates']
  exactKeys(source, [
    'schemaVersion', 'runId', 'policyRevision', 'timeZone', 'localTime', 'localDate', 'dueAt',
    'startedAt', 'completedAt', 'outcome', 'runnerId', 'runnerVersion', ...aggregateKeys,
  ], 'scheduler receipt')
  if (source.schemaVersion !== 1) throw new Error('scheduler receipt schemaVersion must equal 1')
  const base: MemoryApprovalRunReceiptV1 = {
    schemaVersion: 1,
    runId: nonEmpty(source.runId, 'scheduler runId'),
    policyRevision: revision(source.policyRevision),
    timeZone: nonEmpty(source.timeZone, 'scheduler receipt timeZone'),
    localTime: nonEmpty(source.localTime, 'scheduler receipt localTime'),
    localDate: localDate(source.localDate),
    dueAt: timestamp(source.dueAt, 'scheduler receipt dueAt'),
    startedAt: timestamp(source.startedAt, 'scheduler receipt startedAt'),
    completedAt: timestamp(source.completedAt, 'scheduler receipt completedAt'),
    outcome,
    runnerId: nonEmpty(source.runnerId, 'scheduler runnerId'),
    runnerVersion: nonEmpty(source.runnerVersion, 'scheduler runnerVersion'),
  }
  return outcome === 'failed' ? base : {
    ...base,
    reviewedCandidates: count(source.reviewedCandidates, 'scheduler reviewedCandidates'),
    approvedCandidates: count(source.approvedCandidates, 'scheduler approvedCandidates'),
    rejectedCandidates: count(source.rejectedCandidates, 'scheduler rejectedCandidates'),
    deferredCandidates: count(source.deferredCandidates, 'scheduler deferredCandidates'),
  }
}

function parseState(value: unknown): MemoryApprovalSchedulerStateV1 {
  const source = object(value, 'approval scheduler state')
  exactKeys(source, source.armed === undefined
    ? ['schemaVersion', 'receipts']
    : ['schemaVersion', 'armed', 'receipts'], 'approval scheduler state')
  if (source.schemaVersion !== 1 || !Array.isArray(source.receipts)) {
    throw new Error('approval scheduler state has an invalid schema')
  }
  const receipts = source.receipts.map(receipt)
  if (receipts.length > MAX_RECEIPTS) throw new Error('approval scheduler state exceeds receipt retention')
  return {
    schemaVersion: 1,
    ...(source.armed === undefined ? {} : { armed: arm(source.armed) }),
    receipts,
  }
}

async function loadState(path: string): Promise<MemoryApprovalSchedulerStateV1> {
  try {
    return parseState(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 1, receipts: [] }
    }
    throw new Error(`memory approval scheduler state is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function saveState(path: string, state: MemoryApprovalSchedulerStateV1): Promise<void> {
  const canonical = parseState(state)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(canonical, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
  } finally {
    await handle?.close()
    await rm(temporary, { force: true })
  }
}

function parseRunnerResult(value: unknown): MemoryScheduledApprovalRunResultV1 {
  const source = object(value, 'scheduled approval runner result')
  exactKeys(source, [
    'schemaVersion', 'reviewedCandidates', 'approvedCandidates', 'rejectedCandidates', 'deferredCandidates',
  ], 'scheduled approval runner result')
  if (source.schemaVersion !== 1) throw new Error('scheduled approval runner result schemaVersion must equal 1')
  const result = {
    schemaVersion: 1 as const,
    reviewedCandidates: count(source.reviewedCandidates, 'runner reviewedCandidates'),
    approvedCandidates: count(source.approvedCandidates, 'runner approvedCandidates'),
    rejectedCandidates: count(source.rejectedCandidates, 'runner rejectedCandidates'),
    deferredCandidates: count(source.deferredCandidates, 'runner deferredCandidates'),
  }
  if (result.reviewedCandidates !== result.approvedCandidates
    + result.rejectedCandidates + result.deferredCandidates) {
    throw new Error('scheduled approval runner counts must total reviewedCandidates')
  }
  return result
}

function armFor(policy: Extract<MemoryApprovalPolicyV1, { mode: 'scheduled-auto' }>, slot: MemoryApprovalScheduleSlotV1) {
  return {
    policyRevision: policy.revision,
    timeZone: policy.timeZone,
    localTime: policy.localTime,
    slot,
  }
}

function samePolicy(armed: MemoryApprovalSchedulerArmV1 | undefined, policy: MemoryApprovalPolicyV1): boolean {
  return policy.mode === 'scheduled-auto' && armed !== undefined
    && armed.policyRevision === policy.revision
    && armed.timeZone === policy.timeZone
    && armed.localTime === policy.localTime
}

function defaultSchedule(task: () => void, delayMs: number): TimerHandleV1 {
  const timer = setTimeout(task, delayMs)
  timer.unref()
  return { cancel: () => clearTimeout(timer) }
}

/** Create one scheduler over a private state document and single-active runner registry. */
export function createMemoryApprovalSchedulerV1(options: MemoryApprovalSchedulerOptionsV1): MemoryApprovalSchedulerV1 {
  const now = options.now ?? (() => new Date())
  const pollIntervalMs = options.pollIntervalMs ?? 60_000
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1_000 || pollIntervalMs > 3_600_000) {
    throw new Error('memory approval scheduler pollIntervalMs must be from 1000 through 3600000')
  }
  const leaseTimeoutMs = options.leaseTimeoutMs ?? 30_000
  const leaseStaleMs = options.leaseStaleMs ?? 120_000
  if (!Number.isSafeInteger(leaseTimeoutMs) || leaseTimeoutMs < 100 || leaseTimeoutMs > 60_000) {
    throw new Error('memory approval scheduler leaseTimeoutMs must be from 100 through 60000')
  }
  if (!Number.isSafeInteger(leaseStaleMs) || leaseStaleMs < 5_000 || leaseStaleMs > 600_000) {
    throw new Error('memory approval scheduler leaseStaleMs must be from 5000 through 600000')
  }
  let started = false

  async function check(signal = new AbortController().signal): Promise<MemoryApprovalSchedulerCheckV1> {
    await mkdir(dirname(options.statePath), { recursive: true })
    const release = await acquireProperLock(options.statePath, {
      realpath: false,
      stale: leaseStaleMs,
      update: Math.max(1_000, Math.floor(leaseStaleMs / 2)),
      retries: {
        retries: Math.max(0, Math.ceil(leaseTimeoutMs / 50) - 1),
        minTimeout: 50,
        maxTimeout: 50,
        randomize: false,
      },
    })
    try {
      if (signal.aborted) return { schemaVersion: 1, kind: 'cancelled' }
      const state = await loadState(options.statePath)
      const settings = await options.settings.get()
      const policy = settings.approvalPolicy
      if (policy.mode === 'manual') {
        if (state.armed !== undefined) {
          delete state.armed
          await saveState(options.statePath, state)
        }
        return { schemaVersion: 1, kind: 'disabled', policyRevision: policy.revision }
      }
      const checkedAt = now()
      const schedule = calculateMemoryApprovalScheduleV1(policy, checkedAt)
      if (schedule.kind !== 'scheduled') throw new Error('scheduled approval policy produced a disabled schedule')
      if (!samePolicy(state.armed, policy)) {
        state.armed = armFor(policy, schedule.nextDue)
        await saveState(options.statePath, state)
        return {
          schemaVersion: 1,
          kind: 'armed',
          policyRevision: policy.revision,
          slot: { ...schedule.nextDue },
        }
      }
      const armed = state.armed
      if (armed === undefined) throw new Error('scheduled approval state lost its armed slot')
      if (Date.parse(armed.slot.dueAt) > checkedAt.getTime()) {
        return { schemaVersion: 1, kind: 'waiting', policyRevision: policy.revision, slot: { ...armed.slot } }
      }
      const runner = options.runners.current()
      if (runner === undefined) {
        return {
          schemaVersion: 1,
          kind: 'runner-unavailable',
          policyRevision: policy.revision,
          slot: { ...armed.slot },
        }
      }
      const runId = `scheduled-auto:r${String(policy.revision)}:${armed.slot.localDate}`
      const startedAt = now().toISOString()
      let result: MemoryScheduledApprovalRunResultV1 | undefined
      let failed = false
      try {
        result = parseRunnerResult(await runner.run({
          schemaVersion: 1,
          runId,
          policy: { ...policy },
          slot: { ...armed.slot },
          signal,
        }))
      } catch {
        if (signal.aborted) return { schemaVersion: 1, kind: 'cancelled' }
        failed = true
      }
      const completedAt = now()
      const currentPolicy = (await options.settings.get()).approvalPolicy
      const stale = !samePolicy(armed, currentPolicy)
      const outcome = failed ? 'failed' : stale ? 'stale-policy' : 'completed'
      const runReceipt: MemoryApprovalRunReceiptV1 = {
        schemaVersion: 1,
        runId,
        policyRevision: policy.revision,
        timeZone: policy.timeZone,
        localTime: policy.localTime,
        localDate: armed.slot.localDate,
        dueAt: armed.slot.dueAt,
        startedAt,
        completedAt: completedAt.toISOString(),
        outcome,
        runnerId: runner.id,
        runnerVersion: runner.version,
        ...(failed || result === undefined ? {} : result),
      }
      state.receipts = [...state.receipts, runReceipt].slice(-MAX_RECEIPTS)
      if (currentPolicy.mode === 'scheduled-auto' && !stale) {
        const next = calculateMemoryApprovalScheduleV1(currentPolicy, completedAt)
        if (next.kind !== 'scheduled') throw new Error('scheduled approval policy produced a disabled schedule')
        state.armed = armFor(currentPolicy, next.nextDue)
      } else {
        delete state.armed
      }
      await saveState(options.statePath, state)
      return { schemaVersion: 1, kind: outcome, receipt: { ...runReceipt } }
    } finally {
      await release()
    }
  }

  return {
    check,
    async inspect() {
      const state = await loadState(options.statePath)
      return parseState(state)
    },
    start() {
      if (started) throw new Error('memory approval scheduler is already started')
      started = true
      const controller = new AbortController()
      const schedule = options.schedule ?? defaultSchedule
      let timer: TimerHandleV1 | undefined
      let inFlight: Promise<void> | undefined
      const run = (): void => {
        if (controller.signal.aborted) return
        inFlight = check(controller.signal).then(
          () => undefined,
          error => options.onError?.(error),
        ).finally(() => {
          inFlight = undefined
          if (!controller.signal.aborted) timer = schedule(run, pollIntervalMs)
        })
      }
      run()
      return async () => {
        controller.abort()
        timer?.cancel()
        await inFlight
        started = false
      }
    },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Single-active Adapter registry for scheduled approval execution. */
    dshMmemScheduledApprovalRunners: MemoryScheduledApprovalRunnerRegistryV1
    /** Private local scheduler active only when runtime settings are configured. */
    dshMmemApprovalScheduler: MemoryApprovalSchedulerV1
  }
}
