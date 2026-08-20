import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openMemoryArchive } from '../src/index.js'
import { migrateLegacyMemoryDatabase, previewLegacyMemoryDatabase } from '../src/legacy-migration.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

function legacyDatabase(path: string): void {
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject_person_id TEXT,
      content TEXT NOT NULL,
      persona_summary TEXT,
      visibility TEXT NOT NULL,
      source_event_id TEXT,
      source_candidate_id TEXT,
      supersedes_memory_id TEXT,
      confidence REAL NOT NULL,
      importance REAL NOT NULL,
      half_life_days REAL NOT NULL,
      status TEXT NOT NULL
    );
    INSERT INTO memories VALUES
      ('old-1', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'semantic', 'owner',
       '用户喜欢凤凰单丛。', NULL, 'personal', NULL, NULL, NULL, 0.9, 0.8, 365, 'confirmed'),
      ('old-2', '2026-01-02T00:00:00.000Z', '2026-02-02T00:00:00.000Z', 'semantic', 'owner',
       '已经遗忘的内容。', NULL, 'confidential', NULL, NULL, NULL, 0.8, 0.5, 365, 'forgotten'),
      ('old-3', '2026-01-03T00:00:00.000Z', '2026-02-03T00:00:00.000Z', 'semantic', 'owner',
       '尚未确认的候选。', NULL, 'personal', NULL, NULL, NULL, 0.7, 0.5, 365, 'candidate');
  `)
  database.close()
}

describe('legacy MistyMoon memory migration', () => {
  it('previews an old database read-only and counts only confirmed memories as eligible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-legacy-preview-'))
    const path = join(root, 'legacy.db')
    legacyDatabase(path)

    expect(previewLegacyMemoryDatabase(path)).toEqual({
      sourcePath: resolve(path),
      compatible: true,
      totalMemories: 3,
      eligibleMemories: 1,
      skippedMemories: 2,
      warnings: [
        'Only confirmed legacy memories are eligible; candidate, superseded, and forgotten rows are skipped.',
        'Legacy vector indexes, graph data, events, sessions, and persona data are never copied.',
      ],
    })
  })

  it('imports only eligible content into the new archive and is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-legacy-import-'))
    const sourcePath = join(root, 'legacy.db')
    const targetPath = join(root, 'new', 'memories.jsonl')
    legacyDatabase(sourcePath)
    const archive = await openMemoryArchive({
      path: targetPath,
      createId: (() => { const ids = ['observation-1', 'new-memory-1']; return () => ids.shift() ?? 'unexpected-id' })(),
    })

    const first = await migrateLegacyMemoryDatabase({
      sourcePath, archive, context: PERSONAL_COMPANION_ACCESS, memoryKind: 'summary',
    })

    expect(first).toMatchObject({ importedMemories: 1, duplicateMemories: 0, skippedMemories: 2 })
    expect(archive.recall({ context: PERSONAL_COMPANION_ACCESS, query: '凤凰单丛' })).toEqual([
      expect.objectContaining({
        id: 'new-memory-1',
        content: '用户喜欢凤凰单丛。',
        createdAt: '2026-01-01T00:00:00.000Z',
        visibility: 'personal',
        sourceMessageId: 'legacy-mistymoon:old-1',
      }),
    ])
    const second = await migrateLegacyMemoryDatabase({
      sourcePath, archive, context: PERSONAL_COMPANION_ACCESS, memoryKind: 'summary',
    })
    expect(second).toMatchObject({ importedMemories: 0, duplicateMemories: 1, skippedMemories: 2 })
    const reopened = await openMemoryArchive({ path: targetPath })
    expect(reopened.recall({ context: PERSONAL_COMPANION_ACCESS, query: '凤凰单丛' })).toHaveLength(1)
  })
})
