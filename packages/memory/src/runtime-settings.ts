/** Private owner settings consumed by the memory plugin at request time. */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { lock as acquireProperLock } from 'proper-lockfile'

/** Current private runtime-settings document. */
export interface MemoryRuntimeSettings {
  schemaVersion: 1
  recallLimit: number
  approvalPolicy: MemoryApprovalPolicyV1
}

/** Versioned Owner policy controlling whether pending Candidates require manual review. */
export type MemoryApprovalPolicyV1 = {
  schemaVersion: 1
  revision: number
  mode: 'manual'
} | {
  schemaVersion: 1
  revision: number
  mode: 'scheduled-auto'
  timeZone: string
  localTime: string
}

/** Owner update guarded by the exact previously observed policy revision. */
export type MemoryApprovalPolicyUpdateV1 = {
  expectedRevision: number
  mode: 'manual'
} | {
  expectedRevision: number
  mode: 'scheduled-auto'
  timeZone: string
  localTime: string
}

/** Stable runtime-settings failure surfaced through the Settings Host. */
export class MemoryRuntimeSettingsError extends Error {
  constructor(readonly code: 'SETTINGS_REVISION_CONFLICT', message: string) {
    super(message)
    this.name = 'MemoryRuntimeSettingsError'
  }
}

/** Default upper bound for one recalled-memory snapshot. */
export const DEFAULT_RECALL_LIMIT = 8

function defaultApprovalPolicy(): MemoryApprovalPolicyV1 {
  return { schemaVersion: 1, revision: 0, mode: 'manual' }
}

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

function revision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function timeZone(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('memory approval timeZone must be a non-empty IANA time zone')
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    throw new Error('memory approval timeZone must be a valid IANA time zone')
  }
}

function localTime(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
    throw new Error('memory approval localTime must use 24-hour HH:mm')
  }
  return value
}

function approvalPolicy(value: unknown): MemoryApprovalPolicyV1 {
  if (value === undefined) return defaultApprovalPolicy()
  const record = object(value, 'memory settings approvalPolicy')
  if (record.schemaVersion !== 1) throw new Error('memory approval policy schemaVersion must equal 1')
  const policyRevision = revision(record.revision, 'memory approval policy revision')
  if (record.mode === 'manual') {
    exactKeys(record, ['schemaVersion', 'revision', 'mode'], 'memory manual approval policy')
    return { schemaVersion: 1, revision: policyRevision, mode: 'manual' }
  }
  if (record.mode === 'scheduled-auto') {
    exactKeys(
      record,
      ['schemaVersion', 'revision', 'mode', 'timeZone', 'localTime'],
      'memory scheduled approval policy',
    )
    return {
      schemaVersion: 1,
      revision: policyRevision,
      mode: 'scheduled-auto',
      timeZone: timeZone(record.timeZone),
      localTime: localTime(record.localTime),
    }
  }
  throw new Error('memory approval policy mode must be manual or scheduled-auto')
}

function approvalUpdate(value: unknown): MemoryApprovalPolicyUpdateV1 {
  const record = object(value, 'memory approval policy update')
  const expectedRevision = revision(record.expectedRevision, 'memory approval expectedRevision')
  if (record.mode === 'manual') {
    exactKeys(record, ['expectedRevision', 'mode'], 'memory manual approval update')
    return { expectedRevision, mode: 'manual' }
  }
  if (record.mode === 'scheduled-auto') {
    exactKeys(
      record,
      ['expectedRevision', 'mode', 'timeZone', 'localTime'],
      'memory scheduled approval update',
    )
    return {
      expectedRevision,
      mode: 'scheduled-auto',
      timeZone: timeZone(record.timeZone),
      localTime: localTime(record.localTime),
    }
  }
  throw new Error('memory approval update mode must be manual or scheduled-auto')
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
    approvalPolicy: approvalPolicy(record.approvalPolicy),
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
        approvalPolicy: defaultApprovalPolicy(),
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
  const update = approvalUpdate(value)
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
