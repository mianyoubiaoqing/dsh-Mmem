/** Private owner settings consumed by the memory plugin at request time. */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Current private runtime-settings document. */
export interface MemoryRuntimeSettings {
  schemaVersion: 1
  recallLimit: number
}

/** Default upper bound for one recalled-memory snapshot. */
export const DEFAULT_RECALL_LIMIT = 8

function recallLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 20) {
    throw new Error('memory settings recallLimit must be an integer from 1 through 20')
  }
  return value as number
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
  return { schemaVersion: 1, recallLimit: recallLimit(record.recallLimit) }
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
      return { schemaVersion: 1, recallLimit: recallLimit(fallbackRecallLimit) }
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
