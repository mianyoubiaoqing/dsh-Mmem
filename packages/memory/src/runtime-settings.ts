/** Private owner settings consumed by the memory plugin at request time. */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { lock as acquireProperLock } from 'proper-lockfile'
import {
  defaultMemoryApprovalPolicyV1,
  parseMemoryApprovalPolicyUpdateV1,
  parseMemoryApprovalPolicyV1,
  type MemoryApprovalPolicyUpdateV1,
  type MemoryApprovalPolicyV1,
} from './approval-policy.js'
import {
  defaultMemoryTurnSummaryPolicyV1,
  parseMemoryTurnSummaryPolicyUpdateV1,
  parseMemoryTurnSummaryPolicyV1,
  type MemoryTurnSummaryPolicyUpdateV1,
  type MemoryTurnSummaryPolicyV1,
} from './turn-summary-policy.js'

export type { MemoryApprovalPolicyUpdateV1, MemoryApprovalPolicyV1 } from './approval-policy.js'
export type { MemoryTurnSummaryPolicyUpdateV1, MemoryTurnSummaryPolicyV1 } from './turn-summary-policy.js'

/** Separate private document so older approval settings remain downgrade-readable. */
export interface MemoryTurnSummarySettingsV1 {
  readonly schemaVersion: 1
  readonly spaces: Readonly<Record<string, MemoryTurnSummaryPolicyV1>>
}

/** Current private runtime-settings document. */
export interface MemoryRuntimeSettings {
  schemaVersion: 1
  recallLimit: number
  approvalPolicy: MemoryApprovalPolicyV1
}

/** Stable runtime-settings failure surfaced through the Settings Host. */
export class MemoryRuntimeSettingsError extends Error {
  constructor(readonly code: 'SETTINGS_REVISION_CONFLICT' | 'SETTINGS_NOT_CONFIGURED', message: string) {
    super(message)
    this.name = 'MemoryRuntimeSettingsError'
  }
}

/** Memory-owned settings Manager used by Host RPC and runtime consumers. */
export interface MemoryRuntimeSettingsManagerV1 {
  readonly configured: boolean
  get(): Promise<MemoryRuntimeSettings>
  updateApproval(value: unknown): Promise<MemoryRuntimeSettings>
  getTurnSummary(spaceId: string): Promise<MemoryTurnSummaryPolicyV1>
  updateTurnSummary(spaceId: string, value: unknown): Promise<MemoryTurnSummaryPolicyV1>
}

/** Construction options for the private settings Manager. */
export interface MemoryRuntimeSettingsManagerOptionsV1 {
  path?: string
  turnSummaryPath?: string
  fallbackRecallLimit: number
}

/** Default upper bound for one recalled-memory snapshot. */
export const DEFAULT_RECALL_LIMIT = 8

function recallLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 20) {
    throw new Error('memory settings recallLimit must be an integer from 1 through 20')
  }
  return value as number
}

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

function spaceId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
    throw new TypeError('turn summary Memory Space id must be a bounded non-empty string')
  }
  return value.trim()
}

function parseMemoryTurnSummarySettingsV1(value: unknown): MemoryTurnSummarySettingsV1 {
  const input = object(value, 'turn summary settings')
  exactKeys(input, ['schemaVersion', 'spaces'], 'turn summary settings')
  if (input.schemaVersion !== 1) throw new TypeError('turn summary settings schemaVersion must equal 1')
  const spaces = object(input.spaces, 'turn summary settings spaces')
  if (Object.keys(spaces).length > 1_000) throw new TypeError('turn summary settings contain too many Spaces')
  return {
    schemaVersion: 1,
    spaces: Object.fromEntries(Object.entries(spaces).map(([id, policy]) => [
      spaceId(id),
      parseMemoryTurnSummaryPolicyV1(policy),
    ])),
  }
}

/** Load the independent per-Space summary-policy document. */
export async function loadMemoryTurnSummarySettingsV1(path: string): Promise<MemoryTurnSummarySettingsV1> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 1, spaces: {} }
    }
    throw error
  }
  try {
    return parseMemoryTurnSummarySettingsV1(JSON.parse(source) as unknown)
  } catch (error) {
    throw new Error(`turn summary settings are invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function saveMemoryTurnSummarySettingsV1(
  path: string,
  value: MemoryTurnSummarySettingsV1,
): Promise<MemoryTurnSummarySettingsV1> {
  const settings = parseMemoryTurnSummarySettingsV1(value)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  return settings
}

/** Atomically replace one Space's summary policy at its exact observed revision. */
export async function updateMemoryTurnSummaryPolicyV1(
  path: string,
  requestedSpaceId: string,
  value: unknown,
): Promise<MemoryTurnSummaryPolicyV1> {
  const id = spaceId(requestedSpaceId)
  const update = parseMemoryTurnSummaryPolicyUpdateV1(value)
  await mkdir(dirname(path), { recursive: true })
  const release = await acquireProperLock(path, {
    realpath: false,
    stale: 120_000,
    update: 60_000,
    retries: { retries: 600, minTimeout: 50, maxTimeout: 50, randomize: false },
  })
  try {
    const current = await loadMemoryTurnSummarySettingsV1(path)
    const policy = current.spaces[id] ?? defaultMemoryTurnSummaryPolicyV1()
    if (policy.revision !== update.expectedRevision) {
      throw new MemoryRuntimeSettingsError(
        'SETTINGS_REVISION_CONFLICT',
        `turn summary policy revision changed from ${String(update.expectedRevision)} to ${String(policy.revision)}`,
      )
    }
    const nextRevision = policy.revision + 1
    if (!Number.isSafeInteger(nextRevision)) throw new Error('turn summary policy revision is exhausted')
    const next: MemoryTurnSummaryPolicyV1 = update.mode === 'local-deterministic'
      ? { schemaVersion: 1, revision: nextRevision, mode: 'local-deterministic' }
      : {
          schemaVersion: 1,
          revision: nextRevision,
          mode: 'dsh-model',
          ...(update.provider === undefined ? {} : { provider: update.provider }),
          ...(update.model === undefined ? {} : { model: update.model }),
        }
    await saveMemoryTurnSummarySettingsV1(path, {
      schemaVersion: 1,
      spaces: { ...current.spaces, [id]: next },
    })
    return next
  } finally {
    await release()
  }
}

/**
 * Parse an untrusted private runtime-settings value.
 * @param value - Parsed JSON value.
 * @returns Canonical current settings.
 */
export function parseMemoryRuntimeSettings(value: unknown): MemoryRuntimeSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('memory settings must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) throw new Error('memory settings schemaVersion must equal 1')
  const allowed = record.approvalPolicy === undefined
    ? ['schemaVersion', 'recallLimit']
    : ['schemaVersion', 'recallLimit', 'approvalPolicy']
  exactKeys(record, allowed, 'memory settings')
  return {
    schemaVersion: 1,
    recallLimit: recallLimit(record.recallLimit),
    approvalPolicy: parseMemoryApprovalPolicyV1(record.approvalPolicy),
  }
}

/**
 * Read private runtime settings, returning the deployment value before the owner creates an override.
 * @param path - Absolute settings document path.
 * @param fallbackRecallLimit - Deployment-composed recall limit.
 * @returns Owner settings or a synthetic fallback document.
 */
export async function loadMemoryRuntimeSettings(
  path: string,
  fallbackRecallLimit: number,
): Promise<MemoryRuntimeSettings> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        schemaVersion: 1,
        recallLimit: recallLimit(fallbackRecallLimit),
        approvalPolicy: defaultMemoryApprovalPolicyV1(),
      }
    }
    throw error
  }
  try {
    return parseMemoryRuntimeSettings(JSON.parse(source) as unknown)
  } catch (error) {
    throw new Error(`memory settings are invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Validate and atomically replace the private runtime-settings document.
 * @param path - Absolute settings document path.
 * @param value - Candidate settings.
 * @returns Canonical settings written to disk.
 */
export async function saveMemoryRuntimeSettings(path: string, value: unknown): Promise<MemoryRuntimeSettings> {
  const settings = parseMemoryRuntimeSettings(value)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  return settings
}

/**
 * Atomically replace only the Owner approval policy after checking its observed revision.
 * Callers must retry from a freshly loaded document after SETTINGS_REVISION_CONFLICT.
 */
export async function updateMemoryApprovalPolicy(
  path: string,
  fallbackRecallLimit: number,
  value: unknown,
): Promise<MemoryRuntimeSettings> {
  const update = parseMemoryApprovalPolicyUpdateV1(value)
  await mkdir(dirname(path), { recursive: true })
  const release = await acquireProperLock(path, {
    realpath: false,
    stale: 120_000,
    update: 60_000,
    retries: { retries: 600, minTimeout: 50, maxTimeout: 50, randomize: false },
  })
  try {
    const current = await loadMemoryRuntimeSettings(path, fallbackRecallLimit)
    if (current.approvalPolicy.revision !== update.expectedRevision) {
      throw new MemoryRuntimeSettingsError(
        'SETTINGS_REVISION_CONFLICT',
        `memory approval policy revision changed from ${String(update.expectedRevision)} `
          + `to ${String(current.approvalPolicy.revision)}`,
      )
    }
    const nextRevision = current.approvalPolicy.revision + 1
    if (!Number.isSafeInteger(nextRevision)) throw new Error('memory approval policy revision is exhausted')
    return await saveMemoryRuntimeSettings(path, {
      ...current,
      approvalPolicy: update.mode === 'manual'
        ? { schemaVersion: 1, revision: nextRevision, mode: 'manual' }
        : {
            schemaVersion: 1,
            revision: nextRevision,
            mode: 'scheduled-auto',
            timeZone: update.timeZone,
            localTime: update.localTime,
          },
    })
  } finally {
    await release()
  }
}

/** Create one Manager over the configured private settings document. */
export function createMemoryRuntimeSettingsManager(
  options: MemoryRuntimeSettingsManagerOptionsV1,
): MemoryRuntimeSettingsManagerV1 {
  const turnSummaryPath = options.turnSummaryPath
    ?? (options.path === undefined ? undefined : `${options.path}.turn-summary.json`)
  return {
    configured: options.path !== undefined,
    async get() {
      if (options.path === undefined) {
        return {
          schemaVersion: 1,
          recallLimit: recallLimit(options.fallbackRecallLimit),
          approvalPolicy: defaultMemoryApprovalPolicyV1(),
        }
      }
      return loadMemoryRuntimeSettings(options.path, options.fallbackRecallLimit)
    },
    async updateApproval(value) {
      if (options.path === undefined) {
        throw new MemoryRuntimeSettingsError(
          'SETTINGS_NOT_CONFIGURED',
          'memory approval settings require a private settingsPath',
        )
      }
      return updateMemoryApprovalPolicy(options.path, options.fallbackRecallLimit, value)
    },
    async getTurnSummary(requestedSpaceId) {
      const id = spaceId(requestedSpaceId)
      if (turnSummaryPath === undefined) return defaultMemoryTurnSummaryPolicyV1()
      return (await loadMemoryTurnSummarySettingsV1(turnSummaryPath)).spaces[id]
        ?? defaultMemoryTurnSummaryPolicyV1()
    },
    async updateTurnSummary(requestedSpaceId, value) {
      if (turnSummaryPath === undefined) {
        throw new MemoryRuntimeSettingsError(
          'SETTINGS_NOT_CONFIGURED',
          'turn summary settings require a private settingsPath',
        )
      }
      return updateMemoryTurnSummaryPolicyV1(turnSummaryPath, requestedSpaceId, value)
    },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Private versioned runtime settings owned by dsh-Mmem. */
    dshMmemRuntimeSettings: MemoryRuntimeSettingsManagerV1
  }
}
