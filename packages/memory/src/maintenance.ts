import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import {
  inspectArchiveBytes,
  MemoryArchiveStorage,
  migrateLegacyArchiveToScopedBytes,
  verifyArchiveCheckpoint,
  writeArchiveCheckpoint,
  type ArchiveInspection,
  type LegacyScopeMigrationPolicy,
} from './storage/index.js'
import { parseMemoryKind, parseMemoryScopeV1 } from './domain.js'

const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_TRANSACTION_BYTES = 1024 * 1024
const DEFAULT_LEASE_TIMEOUT_MS = 5_000
const DEFAULT_PLAN_EXPIRY_MS = 10 * 60_000

export type ApplicableMemoryMaintenanceAction = 'migrate-v1' | 'recover-trailing'
export type MemoryMaintenanceAction = ApplicableMemoryMaintenanceAction | 'restore-required'

export interface InspectMemoryArchiveOptions {
  path: string
  maxArchiveBytes?: number
  maxTransactionBytes?: number
}

export interface PlanMemoryArchiveMaintenanceOptions extends InspectMemoryArchiveOptions {
  action: ApplicableMemoryMaintenanceAction
  backupPath?: string
  now?: () => Date
  expiresInMs?: number
  /** Maximum generated backups retained beside one archive; existing files are never deleted automatically. */
  backupRetentionLimit?: number
  /** Required explicit assignments for legacy domain events; content is never inspected to infer these values. */
  scopeMigration?: LegacyScopeMigrationPolicy
}

export interface ApplicableMemoryMaintenancePlan {
  schemaVersion: 1
  action: ApplicableMemoryMaintenanceAction
  sourcePath: string
  sourceDigest: string
  backupPath: string
  backupRequired: true
  eventCount: number
  transactionCount: number
  lastValidOffset: number
  expiresAt: string
  token: string
  scopeMigration?: LegacyScopeMigrationPolicy
}

/** Content-free advisory for corruption that cannot be safely truncated or skipped. */
export interface RestoreRequiredMemoryMaintenancePlan {
  schemaVersion: 1
  action: 'restore-required'
  applicable: false
  sourcePath: string
  sourceDigest: string
  eventCount: number
  transactionCount: number
  lastValidOffset: number
  issueCodes: ArchiveInspection['issues'][number]['code'][]
}

export type MemoryMaintenancePlan = ApplicableMemoryMaintenancePlan | RestoreRequiredMemoryMaintenancePlan

export interface ApplyMemoryArchiveMaintenanceOptions {
  path: string
  token: string
  expectedDigest: string
  now?: () => Date
  leaseTimeoutMs?: number
  maxArchiveBytes?: number
  maxTransactionBytes?: number
  /** @internal Deterministic crash-boundary seam for maintenance fault tests. */
  faultInjector?: (point: MemoryMaintenanceFaultPoint) => void | Promise<void>
}

export type MemoryMaintenanceFaultPoint =
  | 'after-backup'
  | 'after-temp-flush'
  | 'after-rename'
  | 'after-checkpoint'

export interface MemoryMaintenanceResult {
  schemaVersion: 1
  action: MemoryMaintenanceAction
  state: 'ready'
  sourcePath: string
  sourceDigest: string
  resultDigest: string
  backupPath: string
  /** Directory-entry fsync is unavailable through Node on Windows; file durability and reopen verification still apply. */
  directoryDurability: 'confirmed' | 'unsupported-platform'
}

export interface RehearseMemoryArchiveRollbackOptions extends InspectMemoryArchiveOptions {
  backupPath: string
  expectedBackupDigest: string
}

/** Content-free readiness report for the documented stop-and-restore rollback procedure. */
export interface MemoryArchiveRollbackRehearsal {
  schemaVersion: 1
  action: 'rollback-rehearsal'
  applicable: boolean
  sourcePath: string
  sourceFormat: ArchiveInspection['format']
  sourceState: ArchiveInspection['state']
  backupPath: string
  backupFormat: ArchiveInspection['format']
  backupState: ArchiveInspection['state']
  backupDigest: string
  issueCodes: Array<'source-not-v2' | 'backup-not-valid-v1' | 'backup-digest-mismatch'>
  requiredSteps: ['stop-writers', 'restore-exact-backup', 'verify-v1', 'start-compatible-runtime']
}

interface MaintenanceTokenPayload {
  schemaVersion: 1
  action: ApplicableMemoryMaintenanceAction
  sourcePath: string
  sourceDigest: string
  backupPath: string
  lastValidOffset: number
  expiresAt: string
  scopeMigration?: LegacyScopeMigrationPolicy
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function encodeToken(payload: MaintenanceTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${encoded}.${sha256(encoded)}`
}

function scopeMigrationPolicy(value: unknown): LegacyScopeMigrationPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('memory scope migration policy is invalid')
  }
  const input = value as Record<string, unknown>
  const keys = Object.keys(input).toSorted()
  if (keys.join(',') !== ['authority', 'memoryKind', 'ownerId', 'recordedAtPolicy', 'scope'].toSorted().join(',')) {
    throw new Error('memory scope migration policy is invalid')
  }
  if (typeof input.ownerId !== 'string' || input.ownerId.trim() === ''
    || typeof input.authority !== 'string' || input.authority.trim() === ''
    || input.recordedAtPolicy !== 'legacy-created-at') {
    throw new Error('memory scope migration policy is invalid')
  }
  return {
    ownerId: input.ownerId,
    authority: input.authority,
    scope: parseMemoryScopeV1(input.scope),
    memoryKind: parseMemoryKind(input.memoryKind),
    recordedAtPolicy: 'legacy-created-at',
  }
}

function decodeToken(token: string): MaintenanceTokenPayload {
  const [encoded, suppliedDigest, extra] = token.split('.')
  if (encoded === undefined || suppliedDigest === undefined || extra !== undefined || sha256(encoded) !== suppliedDigest) {
    throw new Error('memory maintenance token is invalid')
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new Error('memory maintenance token is invalid')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('memory maintenance token is invalid')
  const payload = value as Record<string, unknown>
  if (payload.schemaVersion !== 1 || (payload.action !== 'migrate-v1' && payload.action !== 'recover-trailing')
    || typeof payload.sourcePath !== 'string' || typeof payload.sourceDigest !== 'string'
    || typeof payload.backupPath !== 'string' || typeof payload.lastValidOffset !== 'number'
    || typeof payload.expiresAt !== 'string') {
    throw new Error('memory maintenance token is invalid')
  }
  return {
    schemaVersion: 1,
    action: payload.action,
    sourcePath: payload.sourcePath,
    sourceDigest: payload.sourceDigest,
    backupPath: payload.backupPath,
    lastValidOffset: payload.lastValidOffset,
    expiresAt: payload.expiresAt,
    ...(payload.scopeMigration === undefined ? {} : { scopeMigration: scopeMigrationPolicy(payload.scopeMigration) }),
  }
}

async function readBytes(path: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0)
    throw error
  }
}

async function enforceGeneratedBackupRetention(sourcePath: string, backupPath: string, limit: number): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new TypeError('memory maintenance backup retention limit must be an integer from 1 through 1000')
  }
  const prefix = `${basename(sourcePath)}.backup-`
  const entries = await readdir(dirname(sourcePath))
  if (entries.includes(basename(backupPath))) return
  if (entries.filter(entry => entry.startsWith(prefix)).length >= limit) {
    throw new Error('memory maintenance backup retention limit reached; owner cleanup is required')
  }
}

function inspectBytes(bytes: Buffer, options: InspectMemoryArchiveOptions): ArchiveInspection {
  return inspectArchiveBytes(bytes, {
    maxArchiveBytes: options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
    maxTransactionBytes: options.maxTransactionBytes ?? DEFAULT_MAX_TRANSACTION_BYTES,
  }).inspection
}

/** Inspect archive structure without opening it for recall or mutation. */
export async function inspectMemoryArchive(options: InspectMemoryArchiveOptions): Promise<ArchiveInspection> {
  const sourcePath = resolve(options.path)
  const parsed = inspectArchiveBytes(await readBytes(sourcePath), {
    maxArchiveBytes: options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
    maxTransactionBytes: options.maxTransactionBytes ?? DEFAULT_MAX_TRANSACTION_BYTES,
  })
  return (await verifyArchiveCheckpoint(sourcePath, parsed)).inspection
}

/** Verify rollback inputs without changing the current archive or its exact backup. */
export async function rehearseMemoryArchiveRollback(
  options: RehearseMemoryArchiveRollbackOptions,
): Promise<MemoryArchiveRollbackRehearsal> {
  const sourcePath = resolve(options.path)
  const backupPath = resolve(options.backupPath)
  const source = inspectBytes(await readBytes(sourcePath), options)
  const backup = inspectBytes(await readBytes(backupPath), options)
  const issueCodes: MemoryArchiveRollbackRehearsal['issueCodes'] = []
  if (source.format !== 'v2') issueCodes.push('source-not-v2')
  if (backup.state !== 'scope-migration-required' || backup.format !== 'v1') issueCodes.push('backup-not-valid-v1')
  if (backup.digest !== options.expectedBackupDigest) issueCodes.push('backup-digest-mismatch')
  return {
    schemaVersion: 1,
    action: 'rollback-rehearsal',
    applicable: issueCodes.length === 0,
    sourcePath,
    sourceFormat: source.format,
    sourceState: source.state,
    backupPath,
    backupFormat: backup.format,
    backupState: backup.state,
    backupDigest: backup.digest,
    issueCodes,
    requiredSteps: ['stop-writers', 'restore-exact-backup', 'verify-v1', 'start-compatible-runtime'],
  }
}

/** Create a content-free, exact-generation plan. This function never mutates the archive. */
export function planMemoryArchiveMaintenance(
  options: PlanMemoryArchiveMaintenanceOptions & { action: 'migrate-v1' },
): Promise<ApplicableMemoryMaintenancePlan>
export function planMemoryArchiveMaintenance(
  options: PlanMemoryArchiveMaintenanceOptions & { action: 'recover-trailing' },
): Promise<MemoryMaintenancePlan>
export async function planMemoryArchiveMaintenance(
  options: PlanMemoryArchiveMaintenanceOptions,
): Promise<MemoryMaintenancePlan> {
  const sourcePath = resolve(options.path)
  const bytes = await readBytes(sourcePath)
  const inspection = inspectBytes(bytes, options)
  if (options.action === 'migrate-v1') {
    if (inspection.state !== 'scope-migration-required') {
      throw new Error('memory migration plan requires a valid legacy-domain archive')
    }
    if (options.scopeMigration === undefined) throw new Error('memory scope migration policy is required')
    options.scopeMigration = scopeMigrationPolicy(options.scopeMigration)
  } else if (inspection.state !== 'quarantined') {
    throw new Error('memory recovery plan requires a quarantined archive')
  } else if (inspection.issues.length !== 1
    || inspection.issues[0]?.code !== 'trailing-partial-transaction') {
    return {
      schemaVersion: 1,
      action: 'restore-required',
      applicable: false,
      sourcePath,
      sourceDigest: inspection.digest,
      eventCount: inspection.eventCount,
      transactionCount: inspection.transactionCount,
      lastValidOffset: inspection.lastValidOffset,
      issueCodes: inspection.issues.map(issue => issue.code),
    }
  }
  const now = options.now ?? (() => new Date())
  const expiresInMs = options.expiresInMs ?? DEFAULT_PLAN_EXPIRY_MS
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 1) throw new TypeError('maintenance plan expiry must be positive')
  const expiresAt = new Date(now().getTime() + expiresInMs).toISOString()
  const backupPath = resolve(options.backupPath ?? `${sourcePath}.backup-${inspection.digest.slice(0, 16)}`)
  if (options.backupPath === undefined) {
    await enforceGeneratedBackupRetention(sourcePath, backupPath, options.backupRetentionLimit ?? 20)
  }
  const payload: MaintenanceTokenPayload = {
    schemaVersion: 1,
    action: options.action,
    sourcePath,
    sourceDigest: inspection.digest,
    backupPath,
    lastValidOffset: inspection.lastValidOffset,
    expiresAt,
    ...(options.action === 'migrate-v1' ? { scopeMigration: options.scopeMigration } : {}),
  }
  return {
    ...payload,
    backupRequired: true,
    eventCount: inspection.eventCount,
    transactionCount: inspection.transactionCount,
    token: encodeToken(payload),
  }
}

async function writeExactBackup(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!Buffer.from(await readFile(path)).equals(bytes)) throw new Error('memory maintenance backup path already contains different bytes')
    return
  }
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (!Buffer.from(await readFile(path)).equals(bytes)) throw new Error('memory maintenance backup verification failed')
}

async function flushDirectory(path: string): Promise<'confirmed' | 'unsupported-platform'> {
  const handle = await open(path, 'r')
  try {
    try {
      await handle.sync()
      return 'confirmed'
    } catch (error) {
      if (process.platform === 'win32' && error instanceof Error
        && (error as NodeJS.ErrnoException).code === 'EPERM') {
        return 'unsupported-platform'
      }
      throw error
    }
  } finally {
    await handle.close()
  }
}

/** Apply one still-current maintenance token after creating and verifying an exact backup. */
export async function applyMemoryArchiveMaintenance(
  options: ApplyMemoryArchiveMaintenanceOptions,
): Promise<MemoryMaintenanceResult> {
  const sourcePath = resolve(options.path)
  const payload = decodeToken(options.token)
  const now = options.now ?? (() => new Date())
  if (payload.sourcePath !== sourcePath) throw new Error('memory maintenance token belongs to another archive path')
  if (payload.sourceDigest !== options.expectedDigest) throw new Error('memory maintenance expected digest does not match plan')
  if (Date.parse(payload.expiresAt) <= now().getTime()) throw new Error('memory maintenance plan has expired')
  const limits = {
    maxArchiveBytes: options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
    maxTransactionBytes: options.maxTransactionBytes ?? DEFAULT_MAX_TRANSACTION_BYTES,
  }
  return MemoryArchiveStorage.withExclusiveLease(
    sourcePath,
    options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS,
    async () => {
      const bytes = await readBytes(sourcePath)
      const inspection = inspectArchiveBytes(bytes, limits).inspection
      if (inspection.digest !== payload.sourceDigest) throw new Error('memory archive changed after maintenance planning')
      if (payload.action === 'migrate-v1'
        && inspection.state !== 'scope-migration-required') {
        throw new Error('memory archive no longer requires scoped-record migration')
      }
      if (payload.action === 'recover-trailing'
        && (inspection.state !== 'quarantined' || inspection.issues.length !== 1
          || inspection.issues[0]?.code !== 'trailing-partial-transaction'
          || inspection.lastValidOffset !== payload.lastValidOffset)) {
        throw new Error('memory archive is not the planned trailing recovery generation')
      }
      // Node on some Windows filesystems cannot fsync a directory handle. Probe before
      // creating a backup or replacing the source so an unsupported durability level
      // fails without changing any owner data.
      const directoryDurability = await flushDirectory(dirname(sourcePath))
      await writeExactBackup(payload.backupPath, bytes)
      await options.faultInjector?.('after-backup')
      const replacement = payload.action === 'migrate-v1'
        ? migrateLegacyArchiveToScopedBytes(
            bytes,
            payload.scopeMigration ?? (() => { throw new Error('memory scope migration policy is missing') })(),
            { now },
          )
        : bytes.subarray(0, payload.lastValidOffset)
      const verifiedReplacement = inspectArchiveBytes(replacement, limits).inspection
      if (verifiedReplacement.state !== 'ready') throw new Error('memory maintenance replacement did not validate')
      const temporaryPath = `${sourcePath}.maintenance-${randomUUID()}.tmp`
      let renamed = false
      try {
        const handle = await open(temporaryPath, 'wx', 0o600)
        try {
          await handle.writeFile(replacement)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await options.faultInjector?.('after-temp-flush')
        await rename(temporaryPath, sourcePath)
        renamed = true
        await options.faultInjector?.('after-rename')
        const published = inspectArchiveBytes(await readBytes(sourcePath), limits)
        await writeArchiveCheckpoint(sourcePath, published)
        await options.faultInjector?.('after-checkpoint')
        await flushDirectory(dirname(sourcePath))
      } finally {
        if (!renamed) await rm(temporaryPath, { force: true })
      }
      const resultInspection = (await verifyArchiveCheckpoint(
        sourcePath,
        inspectArchiveBytes(await readBytes(sourcePath), limits),
      )).inspection
      if (resultInspection.state !== 'ready') throw new Error('memory archive failed validation after maintenance apply')
      return {
        schemaVersion: 1,
        action: payload.action,
        state: 'ready',
        sourcePath,
        sourceDigest: payload.sourceDigest,
        resultDigest: resultInspection.digest,
        backupPath: payload.backupPath,
        directoryDurability,
      }
    },
  )
}
