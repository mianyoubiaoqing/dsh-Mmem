/**
 * Read-only migration support for the pre-DSH MistyMoon SQLite memory store.
 * @module @mistymoon/dsh-memory/legacy-migration
 */

import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  CompanionMemoryArchive,
  MemoryAccessContextV1,
  MemoryKind,
  MemoryVisibility,
} from './index.js'

/** Result of inspecting a legacy MistyMoon database without changing either store. */
export interface LegacyMemoryPreview {
  sourcePath: string
  compatible: boolean
  totalMemories: number
  eligibleMemories: number
  skippedMemories: number
  warnings: string[]
}

/** Inputs for an explicitly approved migration into the new private archive. */
export interface LegacyMemoryMigrationOptions {
  sourcePath: string
  archive: CompanionMemoryArchive
  /** Explicit trusted target domain; legacy content is never used to infer it. */
  context: MemoryAccessContextV1
  /** Explicit default applied uniformly; legacy content is never classified automatically. */
  memoryKind: MemoryKind
}

/** Completed import counts alongside the source preview. */
export interface LegacyMemoryMigrationResult extends LegacyMemoryPreview {
  importedMemories: number
  duplicateMemories: number
}

interface LegacyMemoryRow {
  id: string
  created_at: string
  content: string
  visibility: string
}

const COMPATIBLE_COLUMNS = new Set([
  'id',
  'created_at',
  'content',
  'visibility',
  'status',
])

const WARNINGS = [
  'Only confirmed legacy memories are eligible; candidate, superseded, and forgotten rows are skipped.',
  'Legacy vector indexes, graph data, events, sessions, and persona data are never copied.',
]

function hasTable(database: DatabaseSync, table: string): boolean {
  return database.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table) !== undefined
}

function tableColumns(database: DatabaseSync, table: 'memories'): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name),
  )
}

function count(database: DatabaseSync, where = ''): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM memories${where}`).get() as { count: number | bigint }
  return Number(row.count)
}

/**
 * Inspect the old MistyMoon `memories` table through SQLite read-only mode.
 * @param sourcePath - Path to the legacy SQLite database.
 * @returns Compatibility and eligible-row counts; no data is copied.
 */
export function previewLegacyMemoryDatabase(sourcePath: string): LegacyMemoryPreview {
  const path = resolve(sourcePath)
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const columns = hasTable(database, 'memories') ? tableColumns(database, 'memories') : new Set<string>()
    const compatible = [...COMPATIBLE_COLUMNS].every(column => columns.has(column))
    if (!compatible) {
      return {
        sourcePath: path,
        compatible: false,
        totalMemories: 0,
        eligibleMemories: 0,
        skippedMemories: 0,
        warnings: ['The database does not contain a compatible legacy memories table.', ...WARNINGS],
      }
    }
    const totalMemories = count(database)
    const eligibleMemories = count(database, ' WHERE status = \'confirmed\'')
    return {
      sourcePath: path,
      compatible: true,
      totalMemories,
      eligibleMemories,
      skippedMemories: totalMemories - eligibleMemories,
      warnings: [...WARNINGS],
    }
  } finally {
    database.close()
  }
}

function importedVisibility(value: string): MemoryVisibility {
  return value === 'confidential' || value === 'owner_only' ? 'confidential' : 'personal'
}

/**
 * Copy confirmed legacy memory text into a new append-only archive.
 * The SQLite source is opened read-only; sessions, persona, graph, embeddings,
 * events, and all non-confirmed memory rows remain untouched and uncopied.
 * @param options - Approved source database and destination archive.
 * @returns Source and idempotent import counts.
 */
export async function migrateLegacyMemoryDatabase(
  options: LegacyMemoryMigrationOptions,
): Promise<LegacyMemoryMigrationResult> {
  const preview = previewLegacyMemoryDatabase(options.sourcePath)
  if (!preview.compatible) throw new Error('legacy MistyMoon database does not contain a compatible memories table')
  const database = new DatabaseSync(preview.sourcePath, { readOnly: true })
  let importedMemories = 0
  let duplicateMemories = 0
  try {
    const rows = database.prepare(`
      SELECT id, created_at, content, visibility
      FROM memories
      WHERE status = 'confirmed'
      ORDER BY created_at ASC, id ASC
    `).all() as unknown as LegacyMemoryRow[]
    for (const row of rows) {
      const result = await options.archive.importConfirmed({
        context: options.context,
        memoryKind: options.memoryKind,
        sourceMessageId: `legacy-mistymoon:${row.id}`,
        content: row.content,
        createdAt: row.created_at,
        visibility: importedVisibility(row.visibility),
      })
      if (result.imported) importedMemories += 1
      else duplicateMemories += 1
    }
  } finally {
    database.close()
  }
  return { ...preview, importedMemories, duplicateMemories }
}
