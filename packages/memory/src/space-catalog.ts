import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
  createFileArchiveLeaseAdapter,
  type ArchiveLeaseAdapter,
} from './storage/index.js'

/** An Owner-governed Memory Space stored in the versioned catalog. */
export interface MemorySpaceV1 {
  schemaVersion: 1
  id: string
  ownerId: string
  name: string
  createdAt: string
}

/** Input for creating one independently governed Memory Space. */
export interface CreateMemorySpaceRequestV1 {
  ownerId: string
  name: string
}

/** Owner-filtered, content-free projection of the Memory Space Catalog. */
export interface MemorySpaceCatalogSnapshotV1 {
  schemaVersion: 1
  ownerId: string
  spaces: readonly MemorySpaceV1[]
}

/** Access granted by an Owner from one DSH Workspace to one Memory Space. */
export type DshWorkspaceBindingAccessV1 = 'read' | 'read-write'

/** Versioned binding keyed by the exact cwd persisted by a DSH SessionHeader. */
export interface DshWorkspaceBindingV1 {
  schemaVersion: 1
  ownerId: string
  dshWorkspaceCwd: string
  spaceId: string
  access: DshWorkspaceBindingAccessV1
  defaultWrite: boolean
  revision: string
  createdAt: string
}

/** Owner-filtered projection of DSH Workspace Bindings for Settings and audit. */
export interface DshWorkspaceBindingListV1 {
  schemaVersion: 1
  ownerId: string
  bindings: readonly DshWorkspaceBindingV1[]
}

/** Owner-authorized request to bind DSH Workspace evidence to a Memory Space. */
export interface BindDshWorkspaceRequestV1 {
  ownerId: string
  sessionHeader: Pick<SessionHeader, 'cwd'>
  spaceId: string
  access: DshWorkspaceBindingAccessV1
  defaultWrite: boolean
}

/** Request to select the default Active Space for one DSH Session. */
export interface ResolveActiveSpaceRequestV1 {
  ownerId: string
  sessionHeader: Pick<SessionHeader, 'cwd'>
  requestedSpaceId?: string
}

/** Fail-closed resolution of one DSH Session's Active Space. */
export type ActiveSpaceResolutionV1 =
  | {
      schemaVersion: 1
      kind: 'active'
      spaceId: string
      access: DshWorkspaceBindingAccessV1
      bindingRevision: string
    }
  | {
      schemaVersion: 1
      kind: 'unavailable'
      reason: 'missing-dsh-workspace' | 'default-write-space-unavailable' | 'requested-space-unavailable'
    }

/** Public seam for governing Memory Spaces independently from Archive records. */
export interface MemorySpaceCatalogV1 {
  createSpace(request: CreateMemorySpaceRequestV1): Promise<MemorySpaceV1>
  bindDshWorkspace(request: BindDshWorkspaceRequestV1): Promise<DshWorkspaceBindingV1>
  listBindings(request: { ownerId: string }): Promise<DshWorkspaceBindingListV1>
  resolveActiveSpace(request: ResolveActiveSpaceRequestV1): Promise<ActiveSpaceResolutionV1>
  inspect(request: { ownerId: string }): Promise<MemorySpaceCatalogSnapshotV1>
}

/** Owner-bound projection for creating Spaces and binding only the current DSH Workspace. */
export interface MemorySpaceSetupSnapshotV1 {
  schemaVersion: 1
  spaces: readonly MemorySpaceV1[]
  bindings: readonly DshWorkspaceBindingV1[]
}

/** Setup seam whose Owner is fixed by the trusted local Host Adapter. */
export interface MemorySpaceSetupV1 {
  inspect(sessionHeader: Pick<SessionHeader, 'cwd'>): Promise<MemorySpaceSetupSnapshotV1>
  createSpace(
    sessionHeader: Pick<SessionHeader, 'cwd'>,
    request: Omit<CreateMemorySpaceRequestV1, 'ownerId'>,
  ): Promise<MemorySpaceSetupSnapshotV1>
  bindCurrentDshWorkspace(
    sessionHeader: Pick<SessionHeader, 'cwd'>,
    request: Omit<BindDshWorkspaceRequestV1, 'ownerId' | 'sessionHeader'>,
  ): Promise<MemorySpaceSetupSnapshotV1>
}

/** Construction inputs for the versioned Memory Space Catalog. */
export interface OpenMemorySpaceCatalogOptions {
  path: string
  createId?: () => string
  now?: () => Date
  leaseTimeoutMs?: number
  leaseStaleMs?: number
}

/** Stable fail-closed codes surfaced by the Memory Space Catalog seam. */
export type MemorySpaceCatalogErrorCode =
  | 'DSH_WORKSPACE_UNAVAILABLE'
  | 'DEFAULT_WRITE_SPACE_ALREADY_BOUND'
  | 'MEMORY_SPACE_ID_INVALID'

/** Public Catalog failure with a stable machine-readable code. */
export class MemorySpaceCatalogError extends Error {
  constructor(message: string, readonly code: MemorySpaceCatalogErrorCode) {
    super(message)
    this.name = 'MemorySpaceCatalogError'
  }
}

interface MemorySpaceCatalogDocumentV1 {
  schemaVersion: 1
  spaces: readonly MemorySpaceV1[]
  bindings: readonly DshWorkspaceBindingV1[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`invalid Memory Space Catalog ${field}`)
  }
  return value
}

function memorySpaceId(value: unknown): string {
  const id = nonEmptyString(value, 'space id')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
    throw new MemorySpaceCatalogError(
      'Memory Space id must be one safe path segment',
      'MEMORY_SPACE_ID_INVALID',
    )
  }
  return id
}

function memorySpaceName(value: unknown): string {
  const name = nonEmptyString(value, 'space name').trim()
  if (name.length > 128) throw new Error('Memory Space name must not exceed 128 characters')
  return name
}

function isoTimestamp(value: unknown): string {
  const timestamp = nonEmptyString(value, 'createdAt')
  const parsed = new Date(timestamp)
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    throw new Error('invalid Memory Space Catalog createdAt')
  }
  return timestamp
}

/** Parse one untrusted Memory Space projection at RPC or persistence boundaries. */
export function parseMemorySpaceV1(value: unknown): MemorySpaceV1 {
  if (!isObject(value) || !hasExactKeys(value, ['schemaVersion', 'id', 'ownerId', 'name', 'createdAt'])
    || value.schemaVersion !== 1) {
    throw new Error('invalid Memory Space Catalog space')
  }
  return {
    schemaVersion: 1,
    id: memorySpaceId(value.id),
    ownerId: nonEmptyString(value.ownerId, 'space ownerId'),
    name: memorySpaceName(value.name),
    createdAt: isoTimestamp(value.createdAt),
  }
}

function dshWorkspaceCwd(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || !isAbsolute(value)) return undefined
  return value
}

function parseDshWorkspaceBindingV1(value: unknown): DshWorkspaceBindingV1 {
  if (!isObject(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'ownerId',
      'dshWorkspaceCwd',
      'spaceId',
      'access',
      'defaultWrite',
      'revision',
      'createdAt',
    ])
    || value.schemaVersion !== 1
    || (value.access !== 'read' && value.access !== 'read-write')
    || typeof value.defaultWrite !== 'boolean') {
    throw new Error('invalid DSH Workspace Binding')
  }
  const cwd = dshWorkspaceCwd(value.dshWorkspaceCwd)
  if (cwd === undefined) throw new Error('invalid DSH Workspace Binding cwd')
  if (value.defaultWrite && value.access !== 'read-write') {
    throw new Error('default DSH Workspace Binding must be read-write')
  }
  return {
    schemaVersion: 1,
    ownerId: nonEmptyString(value.ownerId, 'binding ownerId'),
    dshWorkspaceCwd: cwd,
    spaceId: memorySpaceId(value.spaceId),
    access: value.access,
    defaultWrite: value.defaultWrite,
    revision: nonEmptyString(value.revision, 'binding revision'),
    createdAt: isoTimestamp(value.createdAt),
  }
}

function parseCatalogDocument(value: unknown): MemorySpaceCatalogDocumentV1 {
  if (!isObject(value) || !hasExactKeys(value, ['schemaVersion', 'spaces', 'bindings'])
    || value.schemaVersion !== 1 || !Array.isArray(value.spaces) || !Array.isArray(value.bindings)) {
    throw new Error('invalid Memory Space Catalog document')
  }
  const spaces = value.spaces.map(parseMemorySpaceV1)
  if (new Set(spaces.map(space => space.id)).size !== spaces.length) {
    throw new Error('duplicate Memory Space Catalog space id')
  }
  const bindings = value.bindings.map(parseDshWorkspaceBindingV1)
  const spaceById = new Map(spaces.map(space => [space.id, space]))
  const bindingKeys = bindings.map(binding =>
    `${JSON.stringify(binding.ownerId)}:${JSON.stringify(binding.dshWorkspaceCwd)}:${JSON.stringify(binding.spaceId)}`)
  if (new Set(bindingKeys).size !== bindingKeys.length
    || bindings.some(binding => spaceById.get(binding.spaceId)?.ownerId !== binding.ownerId)) {
    throw new Error('invalid Memory Space Catalog binding relationship')
  }
  const defaultKeys = bindings
    .filter(binding => binding.defaultWrite)
    .map(binding => `${JSON.stringify(binding.ownerId)}:${JSON.stringify(binding.dshWorkspaceCwd)}`)
  if (new Set(defaultKeys).size !== defaultKeys.length) {
    throw new Error('duplicate default DSH Workspace Binding')
  }
  return { schemaVersion: 1, spaces, bindings }
}

async function readCatalog(path: string): Promise<MemorySpaceCatalogDocumentV1> {
  try {
    return parseCatalogDocument(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return { schemaVersion: 1, spaces: [], bindings: [] }
    throw error
  }
}

async function replaceCatalog(path: string, document: MemorySpaceCatalogDocumentV1): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch(error => {
      if (!isObject(error) || error.code !== 'ENOENT') throw error
    })
  }
}

async function ensureLeaseTarget(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'a')
  await handle.close()
}

const catalogLeaseAdapter = createFileArchiveLeaseAdapter()

class FileMemorySpaceCatalog implements MemorySpaceCatalogV1 {
  #document: MemorySpaceCatalogDocumentV1

  constructor(
    private readonly path: string,
    document: MemorySpaceCatalogDocumentV1,
    private readonly createId: () => string,
    private readonly now: () => Date,
    private readonly leaseAdapter: ArchiveLeaseAdapter,
    private readonly leaseTimeoutMs: number,
    private readonly leaseStaleMs: number,
  ) {
    this.#document = document
  }

  async #mutate<T>(
    action: (document: MemorySpaceCatalogDocumentV1) => {
      document: MemorySpaceCatalogDocumentV1
      result: T
    },
  ): Promise<T> {
    const leaseTarget = `${this.path}.lease-target`
    await ensureLeaseTarget(leaseTarget)
    return this.leaseAdapter.withExclusiveLease(
      leaseTarget,
      this.leaseTimeoutMs,
      async lease => {
        const mutation = action(await readCatalog(this.path))
        await replaceCatalog(this.path, mutation.document)
        lease.assertHeld()
        this.#document = mutation.document
        return mutation.result
      },
      this.leaseStaleMs,
    )
  }

  async #refresh(): Promise<void> {
    this.#document = await readCatalog(this.path)
  }

  async createSpace(request: CreateMemorySpaceRequestV1): Promise<MemorySpaceV1> {
    return this.#mutate(document => {
      const ownerId = nonEmptyString(request.ownerId, 'space ownerId')
      const name = memorySpaceName(request.name)
      const existing = document.spaces.find(space => space.ownerId === ownerId && space.name === name)
      if (existing !== undefined) return { document, result: { ...existing } }
      const space: MemorySpaceV1 = {
        schemaVersion: 1,
        id: memorySpaceId(this.createId()),
        ownerId,
        name,
        createdAt: isoTimestamp(this.now().toISOString()),
      }
      if (document.spaces.some(existing => existing.id === space.id)) {
        throw new Error('duplicate Memory Space Catalog space id')
      }
      return {
        document: {
          schemaVersion: 1,
          spaces: [...document.spaces, space],
          bindings: document.bindings,
        },
        result: { ...space },
      }
    })
  }

  async bindDshWorkspace(request: BindDshWorkspaceRequestV1): Promise<DshWorkspaceBindingV1> {
    const ownerId = nonEmptyString(request.ownerId, 'binding ownerId')
    const spaceId = memorySpaceId(request.spaceId)
    const cwd = dshWorkspaceCwd(request.sessionHeader.cwd)
    if (cwd === undefined) {
      throw new MemorySpaceCatalogError(
        'DSH Workspace is unavailable from SessionHeader.cwd',
        'DSH_WORKSPACE_UNAVAILABLE',
      )
    }
    if (request.access !== 'read' && request.access !== 'read-write') {
      throw new Error('invalid DSH Workspace Binding access')
    }
    if (request.defaultWrite && request.access !== 'read-write') {
      throw new Error('default DSH Workspace Binding must be read-write')
    }
    return this.#mutate(document => {
      if (!document.spaces.some(space => space.id === spaceId && space.ownerId === ownerId)) {
        throw new Error('Memory Space is unavailable for Owner')
      }
      const existing = document.bindings.find(binding => binding.ownerId === ownerId
        && binding.dshWorkspaceCwd === cwd && binding.spaceId === spaceId)
      if (existing !== undefined) {
        if (existing.access === request.access && existing.defaultWrite === request.defaultWrite) {
          return { document, result: { ...existing } }
        }
        throw new Error('DSH Workspace Binding already exists with different access')
      }
      if (request.defaultWrite && document.bindings.some(binding => binding.ownerId === ownerId
        && binding.dshWorkspaceCwd === cwd && binding.defaultWrite)) {
        throw new MemorySpaceCatalogError(
          'default DSH Workspace Binding already exists',
          'DEFAULT_WRITE_SPACE_ALREADY_BOUND',
        )
      }
      const binding: DshWorkspaceBindingV1 = {
        schemaVersion: 1,
        ownerId,
        dshWorkspaceCwd: cwd,
        spaceId,
        access: request.access,
        defaultWrite: request.defaultWrite,
        revision: nonEmptyString(this.createId(), 'binding revision'),
        createdAt: isoTimestamp(this.now().toISOString()),
      }
      return {
        document: {
          schemaVersion: 1,
          spaces: document.spaces,
          bindings: [...document.bindings, binding],
        },
        result: { ...binding },
      }
    })
  }

  async listBindings(request: { ownerId: string }): Promise<DshWorkspaceBindingListV1> {
    const ownerId = nonEmptyString(request.ownerId, 'binding list ownerId')
    await this.#refresh()
    return {
      schemaVersion: 1,
      ownerId,
      bindings: this.#document.bindings
        .filter(binding => binding.ownerId === ownerId)
        .map(binding => ({ ...binding })),
    }
  }

  async resolveActiveSpace(request: ResolveActiveSpaceRequestV1): Promise<ActiveSpaceResolutionV1> {
    const ownerId = nonEmptyString(request.ownerId, 'resolution ownerId')
    const cwd = dshWorkspaceCwd(request.sessionHeader.cwd)
    if (cwd === undefined) {
      return { schemaVersion: 1, kind: 'unavailable', reason: 'missing-dsh-workspace' }
    }
    await this.#refresh()
    const requestedSpaceId = request.requestedSpaceId === undefined
      ? undefined
      : memorySpaceId(request.requestedSpaceId)
    const binding = this.#document.bindings.find(candidate => candidate.ownerId === ownerId
      && candidate.dshWorkspaceCwd === cwd
      && (requestedSpaceId === undefined ? candidate.defaultWrite : candidate.spaceId === requestedSpaceId))
    if (binding === undefined) {
      return {
        schemaVersion: 1,
        kind: 'unavailable',
        reason: requestedSpaceId === undefined
          ? 'default-write-space-unavailable'
          : 'requested-space-unavailable',
      }
    }
    return {
      schemaVersion: 1,
      kind: 'active',
      spaceId: binding.spaceId,
      access: binding.access,
      bindingRevision: binding.revision,
    }
  }

  async inspect(request: { ownerId: string }): Promise<MemorySpaceCatalogSnapshotV1> {
    const ownerId = nonEmptyString(request.ownerId, 'inspection ownerId')
    await this.#refresh()
    return {
      schemaVersion: 1,
      ownerId,
      spaces: this.#document.spaces
        .filter(space => space.ownerId === ownerId)
        .map(space => ({ ...space })),
    }
  }
}

/** Open a versioned Memory Space Catalog without creating a DSH Workspace identity. */
export async function openMemorySpaceCatalog(
  options: OpenMemorySpaceCatalogOptions,
): Promise<MemorySpaceCatalogV1> {
  const path = nonEmptyString(options.path, 'path')
  return new FileMemorySpaceCatalog(
    path,
    await readCatalog(path),
    options.createId ?? randomUUID,
    options.now ?? (() => new Date()),
    catalogLeaseAdapter,
    options.leaseTimeoutMs ?? 30_000,
    options.leaseStaleMs ?? 120_000,
  )
}

/** Bind Space setup to one trusted Owner and exact cwd evidence from each live Session. */
export function createMemorySpaceSetup(
  ownerId: string,
  catalog: MemorySpaceCatalogV1,
): MemorySpaceSetupV1 {
  const trustedOwnerId = nonEmptyString(ownerId, 'Memory Space setup Owner')
  const inspect = async (
    sessionHeader: Pick<SessionHeader, 'cwd'>,
  ): Promise<MemorySpaceSetupSnapshotV1> => {
    const cwd = dshWorkspaceCwd(sessionHeader.cwd)
    if (cwd === undefined) {
      throw new MemorySpaceCatalogError(
        'DSH Workspace is unavailable from SessionHeader.cwd',
        'DSH_WORKSPACE_UNAVAILABLE',
      )
    }
    const [spaceSnapshot, bindingSnapshot] = await Promise.all([
      catalog.inspect({ ownerId: trustedOwnerId }),
      catalog.listBindings({ ownerId: trustedOwnerId }),
    ])
    return {
      schemaVersion: 1,
      spaces: spaceSnapshot.spaces,
      bindings: bindingSnapshot.bindings.filter(binding => binding.dshWorkspaceCwd === cwd),
    }
  }
  return {
    inspect,
    async createSpace(sessionHeader, request) {
      await inspect(sessionHeader)
      await catalog.createSpace({ ownerId: trustedOwnerId, name: request.name })
      return inspect(sessionHeader)
    },
    async bindCurrentDshWorkspace(sessionHeader, request) {
      await catalog.bindDshWorkspace({
        ownerId: trustedOwnerId,
        sessionHeader,
        spaceId: request.spaceId,
        access: request.access,
        defaultWrite: request.defaultWrite,
      })
      return inspect(sessionHeader)
    },
  }
}
