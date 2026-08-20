import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openMemoryArchive } from '../src/index.js'
import {
  applyStandaloneMemoryMigrationV1,
  applyStandaloneMemoryRollbackV1,
  planStandaloneMemoryMigrationV1,
  rehearseStandaloneMemoryRollbackV1,
} from '../src/standalone-migration.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

function legacyDatabase(path: string): void {
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      content TEXT NOT NULL,
      visibility TEXT NOT NULL,
      status TEXT NOT NULL
    );
    INSERT INTO memories VALUES
      ('legacy-a', '2026-01-01T00:00:00.000Z', 'Neutral migrated preference.', 'personal', 'confirmed'),
      ('legacy-b', '2026-01-02T00:00:00.000Z', 'Neutral rejected draft.', 'personal', 'candidate');
  `)
  database.close()
}

describe('standalone Memory Space migration', () => {
  it('plans content-free, applies from exact digests, and restores the exact target backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-standalone-migration-'))
    const sourcePath = join(root, 'legacy.sqlite')
    const targetPath = join(root, 'spaces', 'space-neutral', 'memories.jsonl')
    legacyDatabase(sourcePath)
    const target = await openMemoryArchive({ path: targetPath })
    await target.importConfirmed({
      context: PERSONAL_COMPANION_ACCESS,
      memoryKind: 'summary',
      sourceMessageId: 'existing-source',
      content: 'Existing neutral target memory.',
      createdAt: '2026-01-03T00:00:00.000Z',
      visibility: 'personal',
    })
    await target.dispose()
    const originalArchive = await readFile(targetPath)
    const originalCheckpoint = await readFile(`${targetPath}.checkpoint`)

    const plan = await planStandaloneMemoryMigrationV1({
      sourcePath,
      targetPath,
      context: PERSONAL_COMPANION_ACCESS,
      memoryKind: 'summary',
    })

    expect(plan).toMatchObject({
      schemaVersion: 1,
      action: 'standalone-memory-migration',
      compatible: true,
      eligibleMemories: 1,
      skippedMemories: 1,
      backupRequired: true,
    })
    expect(JSON.stringify(plan)).not.toContain('Neutral migrated preference')
    await expect(applyStandaloneMemoryMigrationV1({
      token: plan.token,
      confirmation: 'wrong confirmation',
      expectedSourceDigest: plan.sourceDigest,
      expectedTargetDigest: plan.targetDigest,
    })).rejects.toThrow('confirmation')
    expect(await readFile(targetPath)).toEqual(originalArchive)

    const result = await applyStandaloneMemoryMigrationV1({
      token: plan.token,
      confirmation: plan.confirmation,
      expectedSourceDigest: plan.sourceDigest,
      expectedTargetDigest: plan.targetDigest,
    })
    expect(result).toMatchObject({
      schemaVersion: 1,
      action: 'standalone-memory-migration',
      importedMemories: 1,
      duplicateMemories: 0,
      skippedMemories: 1,
    })
    const migrated = await openMemoryArchive({ path: targetPath })
    expect(migrated.list({ context: PERSONAL_COMPANION_ACCESS })).toHaveLength(2)
    await migrated.dispose()
    await expect(rehearseStandaloneMemoryRollbackV1({ token: result.rollbackToken })).resolves.toMatchObject({
      action: 'standalone-memory-rollback-rehearsal',
      applicable: true,
      issueCodes: [],
    })

    await expect(applyStandaloneMemoryRollbackV1({
      token: result.rollbackToken,
      confirmation: result.rollbackConfirmation,
    })).resolves.toMatchObject({ action: 'standalone-memory-rollback', state: 'restored' })
    expect(await readFile(targetPath)).toEqual(originalArchive)
    expect(await readFile(`${targetPath}.checkpoint`)).toEqual(originalCheckpoint)
  })

  it('rejects source drift after planning without creating a target backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-standalone-drift-'))
    const sourcePath = join(root, 'legacy.sqlite')
    const targetPath = join(root, 'spaces', 'space-neutral', 'memories.jsonl')
    legacyDatabase(sourcePath)
    const target = await openMemoryArchive({ path: targetPath })
    await target.dispose()
    const plan = await planStandaloneMemoryMigrationV1({
      sourcePath,
      targetPath,
      context: PERSONAL_COMPANION_ACCESS,
      memoryKind: 'summary',
    })
    const database = new DatabaseSync(sourcePath)
    database.exec(`INSERT INTO memories VALUES
      ('legacy-c', '2026-01-04T00:00:00.000Z', 'Changed source row.', 'personal', 'confirmed')`)
    database.close()

    await expect(applyStandaloneMemoryMigrationV1({
      token: plan.token,
      confirmation: plan.confirmation,
      expectedSourceDigest: plan.sourceDigest,
      expectedTargetDigest: plan.targetDigest,
    })).rejects.toThrow('source changed')
    await expect(readFile(plan.backupPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
