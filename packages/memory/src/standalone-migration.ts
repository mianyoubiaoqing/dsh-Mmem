import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { CompanionMemoryArchive } from './contracts.js'
import {
  parseMemoryAccessContextV1,
  parseMemoryKind,
  type MemoryAccessContextV1,
  type MemoryKind,
} from './domain.js'
import {
  importLegacyMemoryRows,
  inspectLegacyMemorySource,
} from './legacy-migration.js'
import {
  inspectArchiveBytes,
  MemoryArchiveStorage,
  verifyArchiveCheckpoint,
} from './storage/index.js'

const DEFAULT_PLAN_EXPIRY_MS = 10 * 60_000
const ARCHIVE_LIMITS = {
  maxArchiveBytes: 64 * 1024 * 1024,
  maxTransactionBytes: 1024 * 1024,
}

export interface PlanStandaloneMemoryMigrationOptionsV1 {
  sourcePath: string
  targetPath: string
  context: MemoryAccessContextV1
  memoryKind: MemoryKind
  backupPath?: string
  now?: () => Date
  expiresInMs?: number
}

/** Content-free plan bound to exact legacy rows and exact target Archive generation. */
export interface StandaloneMemoryMigrationPlanV1 {
  schemaVersion: 1
  action: 'standalone-memory-migration'
  compatible: true
  sourcePath: string
  sourceDigest: string
  targetPath: string
  targetDigest: string
  eligibleMemories: number
  skippedMemories: number
  backupRequired: true
  backupPath: string
  checkpointBackupPath: string
  expiresAt: string
  token: string
  confirmation: string
}

export interface ApplyStandaloneMemoryMigrationOptionsV1 {
  token: string
  confirmation: string
  expectedSourceDigest: string
  expectedTargetDigest: string
  now?: () => Date
  leaseTimeoutMs?: number
  leaseStaleMs?: number
}

/** Completed migration and the exact rollback capability it created. */
export interface StandaloneMemoryMigrationResultV1 {
  schemaVersion: 1
  action: 'standalone-memory-migration'
  state: 'ready'
  sourcePath: string
  sourceDigest: string
  targetPath: string
  previousTargetDigest: string
  resultDigest: string
  importedMemories: number
  duplicateMemories: number
  skippedMemories: number
  backupPath: string
  checkpointBackupPath: string
  rollbackToken: string
  rollbackConfirmation: string
}

export interface RehearseStandaloneMemoryRollbackOptionsV1 {
  token: string
}

export interface StandaloneMemoryRollbackRehearsalV1 {
  schemaVersion: 1
  action: 'standalone-memory-rollback-rehearsal'
  applicable: boolean
  targetPath: string
  currentTargetDigest: string
  expectedResultDigest: string
  backupPath: string
  issueCodes: Array<'target-changed' | 'archive-backup-changed' | 'checkpoint-backup-changed'>
}

export interface ApplyStandaloneMemoryRollbackOptionsV1 {
  token: string
  confirmation: string
  leaseTimeoutMs?: number
  leaseStaleMs?: number
}

export interface StandaloneMemoryRollbackResultV1 {
  schemaVersion: 1
  action: 'standalone-memory-rollback'
  state: 'restored'
  targetPath: string
  restoredTargetDigest: string
}

interface OptionalBytes {
  exists: boolean
  bytes: Buffer
}

interface TargetGeneration {
  archive: OptionalBytes
  checkpoint: OptionalBytes
  digest: string
}

interface MigrationTokenPayload {
  schemaVersion: 1
  kind: 'migration'
  sourcePath: string
  sourceDigest: string
  targetPath: string
  targetDigest: string
  targetExisted: boolean
  checkpointExisted: boolean
  context: MemoryAccessContextV1
  memoryKind: MemoryKind
  eligibleMemories: number
  skippedMemories: number
  backupPath: string
  checkpointBackupPath: string
  expiresAt: string
}

interface RollbackTokenPayload {
  schemaVersion: 1
  kind: 'rollback'
  targetPath: string
  previousTargetDigest: string
  resultDigest: string
  targetExisted: boolean
  checkpointExisted: boolean
  backupPath: string
  backupDigest: string
  checkpointBackupPath: string
  checkpointBackupDigest?: string
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function encodeToken(value: MigrationTokenPayload | RollbackTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${encoded}.${sha256(encoded)}`
}

function tokenObject(token: string): Record<string, unknown> {
  const [encoded, digest, extra] = token.split('.')
  if (encoded === undefined || digest === undefined || extra !== undefined || sha256(encoded) !== digest) {
    throw new Error('standalone Memory migration token is invalid')
  }
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw new Error('standalone Memory migration token is invalid')
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is invalid`)
  return value
}

function requiredCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`)
  return value as number
}

function decodeMigrationToken(token: string): MigrationTokenPayload {
  const value = tokenObject(token)
  if (value.schemaVersion !== 1 || value.kind !== 'migration'
    || typeof value.targetExisted !== 'boolean' || typeof value.checkpointExisted !== 'boolean') {
    throw new Error('standalone Memory migration token is invalid')
  }
  return {
    schemaVersion: 1,
    kind: 'migration',
    sourcePath: resolve(requiredString(value.sourcePath, 'migration sourcePath')),
    sourceDigest: requiredString(value.sourceDigest, 'migration sourceDigest'),
    targetPath: resolve(requiredString(value.targetPath, 'migration targetPath')),
    targetDigest: requiredString(value.targetDigest, 'migration targetDigest'),
    targetExisted: value.targetExisted,
    checkpointExisted: value.checkpointExisted,
    context: parseMemoryAccessContextV1(value.context),
    memoryKind: parseMemoryKind(value.memoryKind),
    eligibleMemories: requiredCount(value.eligibleMemories, 'migration eligibleMemories'),
    skippedMemories: requiredCount(value.skippedMemories, 'migration skippedMemories'),
    backupPath: resolve(requiredString(value.backupPath, 'migration backupPath')),
    checkpointBackupPath: resolve(requiredString(value.checkpointBackupPath, 'migration checkpointBackupPath')),
    expiresAt: new Date(requiredString(value.expiresAt, 'migration expiresAt')).toISOString(),
  }
}

function decodeRollbackToken(token: string): RollbackTokenPayload {
  const value = tokenObject(token)
  if (value.schemaVersion !== 1 || value.kind !== 'rollback'
    || typeof value.targetExisted !== 'boolean' || typeof value.checkpointExisted !== 'boolean') {
    throw new Error('standalone Memory rollback token is invalid')
  }
  const checkpointBackupDigest = value.checkpointBackupDigest === undefined
    ? undefined
    : requiredString(value.checkpointBackupDigest, 'rollback checkpointBackupDigest')
  if (value.checkpointExisted !== (checkpointBackupDigest !== undefined)) {
    throw new Error('standalone Memory rollback token checkpoint facts are invalid')
  }
  return {
    schemaVersion: 1,
    kind: 'rollback',
    targetPath: resolve(requiredString(value.targetPath, 'rollback targetPath')),
    previousTargetDigest: requiredString(value.previousTargetDigest, 'rollback previousTargetDigest'),
    resultDigest: requiredString(value.resultDigest, 'rollback resultDigest'),
    targetExisted: value.targetExisted,
    checkpointExisted: value.checkpointExisted,
    backupPath: resolve(requiredString(value.backupPath, 'rollback backupPath')),
    backupDigest: requiredString(value.backupDigest, 'rollback backupDigest'),
    checkpointBackupPath: resolve(requiredString(value.checkpointBackupPath, 'rollback checkpointBackupPath')),
    ...(checkpointBackupDigest === undefined ? {} : { checkpointBackupDigest }),
  }
}

async function optionalBytes(path: string): Promise<OptionalBytes> {
  try {
    return { exists: true, bytes: await readFile(path) }
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, bytes: Buffer.alloc(0) }
    }
    throw error
  }
}

function generationDigest(archive: OptionalBytes, checkpoint: OptionalBytes): string {
  return sha256(JSON.stringify({
    archiveExists: archive.exists,
    archiveDigest: sha256(archive.bytes),
    checkpointExists: checkpoint.exists,
    checkpointDigest: sha256(checkpoint.bytes),
  }))
}

async function targetGeneration(path: string): Promise<TargetGeneration> {
  const archive = await optionalBytes(path)
  const checkpoint = await optionalBytes(`${path}.checkpoint`)
  if (archive.exists) {
    const parsed = inspectArchiveBytes(archive.bytes, ARCHIVE_LIMITS)
    const verified = await verifyArchiveCheckpoint(path, parsed)
    if (verified.inspection.state !== 'ready') {
      throw new Error('standalone Memory migration target Archive is not ready')
    }
  } else if (checkpoint.exists) {
    throw new Error('standalone Memory migration target has an orphan checkpoint')
  }
  return { archive, checkpoint, digest: generationDigest(archive, checkpoint) }
}

async function writeExact(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!Buffer.from(await readFile(path)).equals(bytes)) {
      throw new Error('standalone Memory migration backup path already contains different bytes')
    }
    return
  }
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function replaceExact(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function migrationConfirmation(ownerId: string, sourceDigest: string, targetDigest: string): string {
  return `APPLY_STANDALONE_MEMORY_MIGRATION:${ownerId}:${sourceDigest}:${targetDigest}`
}

function rollbackConfirmation(targetPath: string, resultDigest: string): string {
  return `RESTORE_STANDALONE_MEMORY_BACKUP:${targetPath}:${resultDigest}`
}

/** Inspect source and target without changing either, then mint an expiring exact-generation plan. */
export async function planStandaloneMemoryMigrationV1(
  options: PlanStandaloneMemoryMigrationOptionsV1,
): Promise<StandaloneMemoryMigrationPlanV1> {
  const source = inspectLegacyMemorySource(options.sourcePath)
  if (!source.preview.compatible) throw new Error('legacy MistyMoon database is incompatible')
  const sourcePath = source.preview.sourcePath
  const targetPath = resolve(options.targetPath)
  if (sourcePath === targetPath) throw new Error('standalone Memory source and target paths must differ')
  const context = parseMemoryAccessContextV1(options.context)
  const memoryKind = parseMemoryKind(options.memoryKind)
  const target = await targetGeneration(targetPath)
  const backupPath = resolve(options.backupPath ?? `${targetPath}.standalone-backup-${target.digest.slice(0, 16)}`)
  const checkpointBackupPath = `${backupPath}.checkpoint`
  if (backupPath === sourcePath || backupPath === targetPath || checkpointBackupPath === `${targetPath}.checkpoint`) {
    throw new Error('standalone Memory backup path must be distinct from source and target')
  }
  const now = options.now ?? (() => new Date())
  const expiresInMs = options.expiresInMs ?? DEFAULT_PLAN_EXPIRY_MS
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 1) throw new TypeError('migration plan expiry must be positive')
  const expiresAt = new Date(now().getTime() + expiresInMs).toISOString()
  const payload: MigrationTokenPayload = {
    schemaVersion: 1,
    kind: 'migration',
    sourcePath,
    sourceDigest: source.sourceDigest,
    targetPath,
    targetDigest: target.digest,
    targetExisted: target.archive.exists,
    checkpointExisted: target.checkpoint.exists,
    context,
    memoryKind,
    eligibleMemories: source.preview.eligibleMemories,
    skippedMemories: source.preview.skippedMemories,
    backupPath,
    checkpointBackupPath,
    expiresAt,
  }
  return {
    schemaVersion: 1,
    action: 'standalone-memory-migration',
    compatible: true,
    sourcePath,
    sourceDigest: source.sourceDigest,
    targetPath,
    targetDigest: target.digest,
    eligibleMemories: source.preview.eligibleMemories,
    skippedMemories: source.preview.skippedMemories,
    backupRequired: true,
    backupPath,
    checkpointBackupPath,
    expiresAt,
    token: encodeToken(payload),
    confirmation: migrationConfirmation(context.ownerId, source.sourceDigest, target.digest),
  }
}

/** Apply one confirmed plan to an offline target generation and create an exact rollback token. */
export async function applyStandaloneMemoryMigrationV1(
  options: ApplyStandaloneMemoryMigrationOptionsV1,
): Promise<StandaloneMemoryMigrationResultV1> {
  const payload = decodeMigrationToken(options.token)
  if (options.confirmation !== migrationConfirmation(
    payload.context.ownerId,
    payload.sourceDigest,
    payload.targetDigest,
  )) throw new Error('standalone Memory migration confirmation is invalid')
  if (options.expectedSourceDigest !== payload.sourceDigest || options.expectedTargetDigest !== payload.targetDigest) {
    throw new Error('standalone Memory migration expected digest is invalid')
  }
  const now = options.now ?? (() => new Date())
  if (now().getTime() > new Date(payload.expiresAt).getTime()) throw new Error('standalone Memory migration plan expired')
  const source = inspectLegacyMemorySource(payload.sourcePath)
  if (source.sourceDigest !== payload.sourceDigest) throw new Error('standalone Memory migration source changed after planning')
  await mkdir(dirname(payload.targetPath), { recursive: true })
  return MemoryArchiveStorage.withExclusiveLease(
    payload.targetPath,
    options.leaseTimeoutMs ?? 30_000,
    async lease => {
      const currentSource = inspectLegacyMemorySource(payload.sourcePath)
      if (currentSource.sourceDigest !== payload.sourceDigest) {
        throw new Error('standalone Memory migration source changed after planning')
      }
      const target = await targetGeneration(payload.targetPath)
      if (target.digest !== payload.targetDigest
        || target.archive.exists !== payload.targetExisted
        || target.checkpoint.exists !== payload.checkpointExisted) {
        throw new Error('standalone Memory migration target changed after planning')
      }
      await writeExact(payload.backupPath, target.archive.bytes)
      if (target.checkpoint.exists) await writeExact(payload.checkpointBackupPath, target.checkpoint.bytes)
      const temporaryTarget = `${payload.targetPath}.standalone-migration-${randomUUID()}.tmp`
      try {
        if (target.archive.exists) await writeExact(temporaryTarget, target.archive.bytes)
        if (target.checkpoint.exists) await writeExact(`${temporaryTarget}.checkpoint`, target.checkpoint.bytes)
        const { openMemoryArchive } = await import('./index.js')
        const archive: CompanionMemoryArchive = await openMemoryArchive({ path: temporaryTarget })
        let counts: { importedMemories: number; duplicateMemories: number }
        try {
          counts = await importLegacyMemoryRows({
            rows: currentSource.rows,
            archive,
            context: payload.context,
            memoryKind: payload.memoryKind,
          })
        } finally {
          await archive.dispose()
        }
        const replacement = await targetGeneration(temporaryTarget)
        let targetTouched = false
        try {
          lease.assertHeld()
          await rename(temporaryTarget, payload.targetPath)
          targetTouched = true
          await rename(`${temporaryTarget}.checkpoint`, `${payload.targetPath}.checkpoint`)
          const published = await targetGeneration(payload.targetPath)
          if (published.digest !== replacement.digest) {
            throw new Error('standalone Memory migration target failed publication verification')
          }
          const rollbackPayload: RollbackTokenPayload = {
            schemaVersion: 1,
            kind: 'rollback',
            targetPath: payload.targetPath,
            previousTargetDigest: payload.targetDigest,
            resultDigest: published.digest,
            targetExisted: payload.targetExisted,
            checkpointExisted: payload.checkpointExisted,
            backupPath: payload.backupPath,
            backupDigest: sha256(target.archive.bytes),
            checkpointBackupPath: payload.checkpointBackupPath,
            ...(target.checkpoint.exists ? { checkpointBackupDigest: sha256(target.checkpoint.bytes) } : {}),
          }
          return {
            schemaVersion: 1,
            action: 'standalone-memory-migration',
            state: 'ready',
            sourcePath: payload.sourcePath,
            sourceDigest: payload.sourceDigest,
            targetPath: payload.targetPath,
            previousTargetDigest: payload.targetDigest,
            resultDigest: published.digest,
            importedMemories: counts.importedMemories,
            duplicateMemories: counts.duplicateMemories,
            skippedMemories: payload.skippedMemories,
            backupPath: payload.backupPath,
            checkpointBackupPath: payload.checkpointBackupPath,
            rollbackToken: encodeToken(rollbackPayload),
            rollbackConfirmation: rollbackConfirmation(payload.targetPath, published.digest),
          }
        } catch (error) {
          if (targetTouched) {
            if (target.archive.exists) await replaceExact(payload.targetPath, target.archive.bytes)
            else await rm(payload.targetPath, { force: true })
            if (target.checkpoint.exists) {
              await replaceExact(`${payload.targetPath}.checkpoint`, target.checkpoint.bytes)
            } else {
              await rm(`${payload.targetPath}.checkpoint`, { force: true })
            }
            if ((await targetGeneration(payload.targetPath)).digest !== payload.targetDigest) {
              throw new Error('standalone Memory migration failed and exact backup restore also failed', { cause: error })
            }
          }
          throw error
        }
      } finally {
        await rm(temporaryTarget, { force: true })
        await rm(`${temporaryTarget}.checkpoint`, { force: true })
      }
    },
    undefined,
    options.leaseStaleMs ?? 120_000,
  )
}

/** Verify that the current generation and exact backups still match a rollback token. */
export async function rehearseStandaloneMemoryRollbackV1(
  options: RehearseStandaloneMemoryRollbackOptionsV1,
): Promise<StandaloneMemoryRollbackRehearsalV1> {
  const payload = decodeRollbackToken(options.token)
  const current = await targetGeneration(payload.targetPath)
  const backup = await optionalBytes(payload.backupPath)
  const checkpointBackup = await optionalBytes(payload.checkpointBackupPath)
  const issueCodes: StandaloneMemoryRollbackRehearsalV1['issueCodes'] = []
  if (current.digest !== payload.resultDigest) issueCodes.push('target-changed')
  if (!backup.exists || sha256(backup.bytes) !== payload.backupDigest) issueCodes.push('archive-backup-changed')
  if (payload.checkpointExisted
    && (!checkpointBackup.exists || sha256(checkpointBackup.bytes) !== payload.checkpointBackupDigest)) {
    issueCodes.push('checkpoint-backup-changed')
  }
  return {
    schemaVersion: 1,
    action: 'standalone-memory-rollback-rehearsal',
    applicable: issueCodes.length === 0,
    targetPath: payload.targetPath,
    currentTargetDigest: current.digest,
    expectedResultDigest: payload.resultDigest,
    backupPath: payload.backupPath,
    issueCodes,
  }
}

/** Restore the exact pre-migration target generation after a successful rehearsal. */
export async function applyStandaloneMemoryRollbackV1(
  options: ApplyStandaloneMemoryRollbackOptionsV1,
): Promise<StandaloneMemoryRollbackResultV1> {
  const payload = decodeRollbackToken(options.token)
  if (options.confirmation !== rollbackConfirmation(payload.targetPath, payload.resultDigest)) {
    throw new Error('standalone Memory rollback confirmation is invalid')
  }
  await mkdir(dirname(payload.targetPath), { recursive: true })
  return MemoryArchiveStorage.withExclusiveLease(
    payload.targetPath,
    options.leaseTimeoutMs ?? 30_000,
    async lease => {
      const rehearsal = await rehearseStandaloneMemoryRollbackV1({ token: options.token })
      if (!rehearsal.applicable) throw new Error(`standalone Memory rollback is not applicable: ${rehearsal.issueCodes.join(',')}`)
      const backup = await readFile(payload.backupPath)
      lease.assertHeld()
      if (payload.targetExisted) await replaceExact(payload.targetPath, backup)
      else await rm(payload.targetPath, { force: true })
      if (payload.checkpointExisted) {
        await replaceExact(`${payload.targetPath}.checkpoint`, await readFile(payload.checkpointBackupPath))
      } else {
        await rm(`${payload.targetPath}.checkpoint`, { force: true })
      }
      const restored = await targetGeneration(payload.targetPath)
      if (restored.digest !== payload.previousTargetDigest) {
        throw new Error('standalone Memory rollback failed exact-generation verification')
      }
      return {
        schemaVersion: 1,
        action: 'standalone-memory-rollback',
        state: 'restored',
        targetPath: payload.targetPath,
        restoredTargetDigest: restored.digest,
      }
    },
    undefined,
    options.leaseStaleMs ?? 120_000,
  )
}
