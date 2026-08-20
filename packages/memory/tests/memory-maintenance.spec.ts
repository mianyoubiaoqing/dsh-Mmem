import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { openMemoryArchive } from '../src/index.js'
import {
  applyMemoryArchiveMaintenance,
  inspectMemoryArchive,
  planMemoryArchiveMaintenance,
  rehearseMemoryArchiveRollback,
  type MemoryMaintenancePlan,
} from '../src/maintenance.js'
import { inspectArchiveBytes, MemoryArchiveStorage, migrateV1ArchiveBytes } from '../src/storage/index.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

const execFileAsync = promisify(execFile)
const SCOPE_MIGRATION = {
  ownerId: 'owner-fixture',
  authority: 'local-dsh-host-rpc',
  scope: { version: 1, kind: 'companion-reality' },
  memoryKind: 'summary',
  recordedAtPolicy: 'legacy-created-at',
} as const

function legacyRecord(): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    id: 'legacy-memory-1',
    createdAt: '2026-08-18T00:00:00.000Z',
    content: 'Owner 使用中性数据演练格式迁移。',
    visibility: 'personal',
    sourceMessageId: 'legacy-source-1',
    status: 'confirmed',
  })}\n`
}

describe('memory archive maintenance', () => {
  it('scope-migrates an existing storage-v2/domain-v1 generation without guessing fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-scope-only-migration-'))
    const path = join(root, 'memories.jsonl')
    await writeFile(path, migrateV1ArchiveBytes(Buffer.from(legacyRecord(), 'utf8'), {
      now: () => new Date('2026-08-18T00:30:00.000Z'),
    }))

    expect(inspectArchiveBytes(await readFile(path), {
      maxArchiveBytes: Number.MAX_SAFE_INTEGER,
      maxTransactionBytes: Number.MAX_SAFE_INTEGER,
    }).inspection).toMatchObject({ state: 'scope-migration-required', format: 'v2' })
    const plan = await planMemoryArchiveMaintenance({
      path,
      action: 'migrate-v1',
      scopeMigration: SCOPE_MIGRATION,
    })
    await applyMemoryArchiveMaintenance({ path, token: plan.token, expectedDigest: plan.sourceDigest })
    const archive = await openMemoryArchive({ path })
    expect(archive.inspection()).toMatchObject({ state: 'ready', format: 'v2' })
    expect(archive.recall({ context: PERSONAL_COMPANION_ACCESS, query: '格式迁移' }))
      .toEqual([expect.objectContaining({ ownerId: 'owner-fixture', memoryKind: 'summary' })])
  })

  it('keeps v1 fail-closed until an exact-digest migration plan is explicitly applied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-migration-'))
    const path = join(root, 'memories.jsonl')
    const original = Buffer.from(legacyRecord(), 'utf8')
    await writeFile(path, original)

    const legacy = await openMemoryArchive({ path })
    expect(legacy.inspection()).toMatchObject({ state: 'scope-migration-required', format: 'v1', eventCount: 1 })
    expect(legacy.recall({ context: PERSONAL_COMPANION_ACCESS, query: '格式迁移' })).toEqual([])
    await expect(legacy.observeExplicit({
      context: PERSONAL_COMPANION_ACCESS, memoryKind: 'summary',
      sourceMessageId: 'new-source', text: '请记住：不应写入 v1。',
    }))
      .rejects.toMatchObject({ code: 'MEMORY_ARCHIVE_SCOPE_MIGRATION_REQUIRED' })

    const plan = await planMemoryArchiveMaintenance({
      path,
      action: 'migrate-v1',
      scopeMigration: SCOPE_MIGRATION,
      now: () => new Date('2026-08-18T01:00:00.000Z'),
      expiresInMs: 60_000,
    })
    expect(plan).toMatchObject({
      action: 'migrate-v1',
      sourceDigest: legacy.inspection().digest,
      backupRequired: true,
      eventCount: 1,
    })
    expect(JSON.stringify(plan)).not.toContain('中性数据演练')
    expect(await readFile(path)).toEqual(original)

    const result = await applyMemoryArchiveMaintenance({
      path,
      token: plan.token,
      expectedDigest: plan.sourceDigest,
      now: () => new Date('2026-08-18T01:00:30.000Z'),
    })

    expect(result).toMatchObject({
      action: 'migrate-v1',
      state: 'ready',
      backupPath: plan.backupPath,
      directoryDurability: process.platform === 'win32' ? 'unsupported-platform' : 'confirmed',
    })
    expect(await readFile(plan.backupPath)).toEqual(original)
    expect(await inspectMemoryArchive({ path })).toMatchObject({ state: 'ready', format: 'v2', eventCount: 2 })
    const migrated = await openMemoryArchive({ path })
    expect(migrated.recall({ context: PERSONAL_COMPANION_ACCESS, query: '格式迁移' })).toEqual([
      expect.objectContaining({ id: 'legacy-memory-1', sourceMessageId: 'legacy-source-1' }),
    ])
    await expect(rehearseMemoryArchiveRollback({
      path,
      backupPath: plan.backupPath,
      expectedBackupDigest: plan.sourceDigest,
    })).resolves.toMatchObject({
      action: 'rollback-rehearsal',
      applicable: true,
      sourceFormat: 'v2',
      backupFormat: 'v1',
      backupState: 'scope-migration-required',
      issueCodes: [],
    })
  })

  it('recovers only a trailing partial transaction after backing up the exact damaged generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-recovery-'))
    const path = join(root, 'memories.jsonl')
    const archive = await openMemoryArchive({
      path,
      createId: (() => { const ids = ['observation-1', 'memory-1']; return () => ids.shift() ?? 'unexpected-id' })(),
      now: () => new Date('2026-08-18T02:00:00.000Z'),
    })
    await archive.observeExplicit({
      context: PERSONAL_COMPANION_ACCESS, memoryKind: 'summary',
      sourceMessageId: 'source-1', text: '请记住：中性恢复夹具仍然有效。',
    })
    await appendFile(path, '{"kind":"transaction"', 'utf8')
    const damaged = await readFile(path)

    const inspection = await inspectMemoryArchive({ path })
    expect(inspection).toMatchObject({
      state: 'quarantined',
      issues: [{ code: 'trailing-partial-transaction' }],
    })
    const plan = await planMemoryArchiveMaintenance({
      path,
      action: 'recover-trailing',
      now: () => new Date('2026-08-18T02:01:00.000Z'),
    })
    if (plan.action !== 'recover-trailing') throw new Error('expected an applicable trailing recovery plan')
    const result = await applyMemoryArchiveMaintenance({
      path,
      token: plan.token,
      expectedDigest: plan.sourceDigest,
      now: () => new Date('2026-08-18T02:02:00.000Z'),
    })

    expect(result).toMatchObject({ action: 'recover-trailing', state: 'ready' })
    expect(await readFile(plan.backupPath)).toEqual(damaged)
    const recovered = await openMemoryArchive({ path })
    expect(recovered.recall({ context: PERSONAL_COMPANION_ACCESS, query: '恢复夹具' }))
      .toEqual([expect.objectContaining({ id: 'memory-1' })])

    await appendFile(path, '{not-json}\n', 'utf8')
    const restore = await planMemoryArchiveMaintenance({ path, action: 'recover-trailing' })
    expect(restore).toMatchObject({
      action: 'restore-required',
      applicable: false,
      issueCodes: ['interior-invalid-json'],
    })
    expect(restore).not.toHaveProperty('token')
    expect(restore).not.toHaveProperty('backupPath')
    expect(JSON.stringify(restore)).not.toContain('中性恢复夹具')
  })

  it('rejects expired or stale plans without changing the source archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-stale-plan-'))
    const path = join(root, 'memories.jsonl')
    await writeFile(path, legacyRecord(), 'utf8')
    const expired = await planMemoryArchiveMaintenance({
      path,
      action: 'migrate-v1',
      scopeMigration: SCOPE_MIGRATION,
      now: () => new Date('2026-08-18T03:00:00.000Z'),
      expiresInMs: 1_000,
    })
    const beforeExpired = await readFile(path)
    await expect(applyMemoryArchiveMaintenance({
      path,
      token: expired.token,
      expectedDigest: expired.sourceDigest,
      now: () => new Date('2026-08-18T03:00:02.000Z'),
    })).rejects.toThrow('expired')
    expect(await readFile(path)).toEqual(beforeExpired)

    const stale = await planMemoryArchiveMaintenance({ path, action: 'migrate-v1', scopeMigration: SCOPE_MIGRATION })
    await appendFile(path, '\n', 'utf8')
    const changed = await readFile(path)
    await expect(applyMemoryArchiveMaintenance({
      path,
      token: stale.token,
      expectedDigest: stale.sourceDigest,
    })).rejects.toThrow('changed after maintenance planning')
    expect(await readFile(path)).toEqual(changed)
  })

  it('keeps every migration fault boundary recoverable from an exact backup', async () => {
    const points = ['after-backup', 'after-temp-flush', 'after-rename', 'after-checkpoint'] as const
    for (const point of points) {
      const root = await mkdtemp(join(tmpdir(), `mistymoon-memory-migration-${point}-`))
      const path = join(root, 'memories.jsonl')
      const original = Buffer.from(legacyRecord(), 'utf8')
      await writeFile(path, original)
      const plan = await planMemoryArchiveMaintenance({ path, action: 'migrate-v1', scopeMigration: SCOPE_MIGRATION })

      await expect(applyMemoryArchiveMaintenance({
        path,
        token: plan.token,
        expectedDigest: plan.sourceDigest,
        faultInjector: current => {
          if (current === point) throw new Error(`injected ${point}`)
        },
      })).rejects.toThrow(`injected ${point}`)

      expect(await readFile(plan.backupPath)).toEqual(original)
      const source = await readFile(path)
      const structural = inspectArchiveBytes(source, {
        maxArchiveBytes: Number.MAX_SAFE_INTEGER,
        maxTransactionBytes: Number.MAX_SAFE_INTEGER,
      }).inspection
      expect(
        (structural.state === 'scope-migration-required' && structural.format === 'v1')
        || (structural.state === 'ready' && structural.format === 'v2'),
      ).toBe(true)
    }
  })

  it('keeps every trailing-recovery fault boundary recoverable from an exact backup', async () => {
    const points = ['after-backup', 'after-temp-flush', 'after-rename', 'after-checkpoint'] as const
    for (const point of points) {
      const root = await mkdtemp(join(tmpdir(), `mistymoon-memory-recovery-${point}-`))
      const path = join(root, 'memories.jsonl')
      const archive = await openMemoryArchive({ path })
      await archive.observeExplicit({
        context: PERSONAL_COMPANION_ACCESS, memoryKind: 'summary',
        sourceMessageId: 'source-1', text: '请记住：中性恢复故障夹具。',
      })
      await appendFile(path, '{"kind":"transaction"', 'utf8')
      const damaged = await readFile(path)
      const plan = await planMemoryArchiveMaintenance({ path, action: 'recover-trailing' })
      if (plan.action !== 'recover-trailing') throw new Error('expected an applicable trailing recovery plan')

      await expect(applyMemoryArchiveMaintenance({
        path,
        token: plan.token,
        expectedDigest: plan.sourceDigest,
        faultInjector: current => {
          if (current === point) throw new Error(`injected ${point}`)
        },
      })).rejects.toThrow(`injected ${point}`)

      expect(await readFile(plan.backupPath)).toEqual(damaged)
      const structural = inspectArchiveBytes(await readFile(path), {
        maxArchiveBytes: Number.MAX_SAFE_INTEGER,
        maxTransactionBytes: Number.MAX_SAFE_INTEGER,
      }).inspection
      expect(
        (structural.state === 'quarantined' && structural.issues[0]?.code === 'trailing-partial-transaction')
        || (structural.state === 'ready' && structural.format === 'v2'),
      ).toBe(true)
    }
  })

  it('rejects token, expected-digest, and backup failures before replacing source bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-maintenance-preconditions-'))
    const path = join(root, 'memories.jsonl')
    const backupPath = join(root, 'chosen.backup')
    const original = Buffer.from(legacyRecord(), 'utf8')
    await writeFile(path, original)
    const plan = await planMemoryArchiveMaintenance({
      path, action: 'migrate-v1', backupPath, scopeMigration: SCOPE_MIGRATION,
    })

    await expect(applyMemoryArchiveMaintenance({
      path,
      token: `${plan.token}invalid`,
      expectedDigest: plan.sourceDigest,
    })).rejects.toThrow('token is invalid')
    await expect(applyMemoryArchiveMaintenance({
      path,
      token: plan.token,
      expectedDigest: '0'.repeat(64),
    })).rejects.toThrow('expected digest')
    await writeFile(backupPath, 'different neutral bytes', 'utf8')
    await expect(applyMemoryArchiveMaintenance({
      path,
      token: plan.token,
      expectedDigest: plan.sourceDigest,
    })).rejects.toThrow('different bytes')
    expect(await readFile(path)).toEqual(original)
  })

  it('refuses to create a generated backup beyond the configured retention ceiling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-backup-retention-'))
    const path = join(root, 'memories.jsonl')
    await writeFile(path, legacyRecord(), 'utf8')
    await writeFile(`${path}.backup-neutral-a`, 'neutral backup a', 'utf8')
    await writeFile(`${path}.backup-neutral-b`, 'neutral backup b', 'utf8')

    await expect(planMemoryArchiveMaintenance({
      path,
      action: 'migrate-v1',
      scopeMigration: SCOPE_MIGRATION,
      backupRetentionLimit: 2,
    })).rejects.toThrow('retention limit')
    await expect(planMemoryArchiveMaintenance({
      path,
      action: 'migrate-v1',
      scopeMigration: SCOPE_MIGRATION,
      backupRetentionLimit: 3,
    })).resolves.toMatchObject({ action: 'migrate-v1', backupRequired: true })
  })

  it('fails a contended apply at the bounded lease timeout without changing source bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-maintenance-lease-'))
    const path = join(root, 'memories.jsonl')
    const original = Buffer.from(legacyRecord(), 'utf8')
    await writeFile(path, original)
    const plan = await planMemoryArchiveMaintenance({ path, action: 'migrate-v1', scopeMigration: SCOPE_MIGRATION })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const acquired = new Promise<void>(resolve => { entered = resolve })
    const holding = MemoryArchiveStorage.withExclusiveLease(path, 1_000, async () => {
      entered()
      await held
    })
    await acquired

    await expect(applyMemoryArchiveMaintenance({
      path,
      token: plan.token,
      expectedDigest: plan.sourceDigest,
      leaseTimeoutMs: 100,
    })).rejects.toMatchObject({ code: 'MEMORY_LEASE_TIMEOUT' })
    expect(await readFile(path)).toEqual(original)
    await expect(readFile(plan.backupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    release()
    await holding
  })

  it('keeps the local CLI read-only until a token-bound apply and never prints memory content', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-cli-'))
    const path = join(root, 'memories.jsonl')
    await writeFile(path, legacyRecord(), 'utf8')
    const cli = join(process.cwd(), 'scripts', 'memory-maintenance.ts')
    const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')

    const inspected = await execFileAsync(process.execPath, [tsx, cli, 'inspect', path], { encoding: 'utf8' })
    expect(JSON.parse(inspected.stdout)).toMatchObject({ state: 'scope-migration-required', format: 'v1' })
    expect(inspected.stdout).not.toContain('中性数据演练')

    const planned = await execFileAsync(process.execPath, [
      tsx, cli, 'plan-migrate', path,
      SCOPE_MIGRATION.ownerId,
      SCOPE_MIGRATION.authority,
      JSON.stringify(SCOPE_MIGRATION.scope),
      SCOPE_MIGRATION.memoryKind,
    ], { encoding: 'utf8' })
    const plan = JSON.parse(planned.stdout) as MemoryMaintenancePlan
    expect(plan).toMatchObject({ action: 'migrate-v1', backupRequired: true })
    expect(planned.stdout).not.toContain('中性数据演练')
    if (plan.action !== 'migrate-v1') throw new Error('expected an applicable migration plan')

    const applied = await execFileAsync(process.execPath, [
      tsx, cli, 'apply', path, plan.token, plan.sourceDigest,
    ], { encoding: 'utf8' })
    expect(JSON.parse(applied.stdout)).toMatchObject({ state: 'ready', action: 'migrate-v1' })
    expect(applied.stdout).not.toContain('中性数据演练')

    const rehearsed = await execFileAsync(process.execPath, [
      tsx, cli, 'rehearse-rollback', path, plan.backupPath, plan.sourceDigest,
    ], { encoding: 'utf8' })
    expect(JSON.parse(rehearsed.stdout)).toMatchObject({ action: 'rollback-rehearsal', applicable: true })
    expect(rehearsed.stdout).not.toContain('中性数据演练')

    await appendFile(path, '{"kind":"transaction"', 'utf8')
    const recoveryOutput = await execFileAsync(process.execPath, [tsx, cli, 'plan-recover', path], { encoding: 'utf8' })
    const recovery = JSON.parse(recoveryOutput.stdout) as MemoryMaintenancePlan
    expect(recovery).toMatchObject({ action: 'recover-trailing', backupRequired: true })
    if (recovery.action !== 'recover-trailing') throw new Error('expected an applicable recovery plan')
    const recovered = await execFileAsync(process.execPath, [
      tsx, cli, 'apply', path, recovery.token, recovery.sourceDigest,
    ], { encoding: 'utf8' })
    expect(JSON.parse(recovered.stdout)).toMatchObject({ state: 'ready', action: 'recover-trailing' })
    expect(`${recoveryOutput.stdout}${recovered.stdout}`).not.toContain('中性数据演练')
  })
})
