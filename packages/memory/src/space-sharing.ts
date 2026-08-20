import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MemoryVisibility } from './contracts.js'
import type { MemoryKind } from './domain.js'
import type { MemorySpaceCatalogV1 } from './space-catalog.js'
import {
  createFileArchiveLeaseAdapter,
  type ArchiveLeaseAdapter,
} from './storage/index.js'

/** Owner-level switch controlling whether recall may leave the Active Space. */
export type InterSpaceModeV1 = 'isolated' | 'selective' | 'federated'

/** One-way, read-only and non-transitive authority from Source Space to Target Space. */
export interface SpaceShareGrantV1 {
  id: string
  sourceSpaceId: string
  targetSpaceId: string
  memoryKinds: readonly MemoryKind[]
  visibilities: readonly MemoryVisibility[]
}

/** Explicit member list granting mutual recall in Federated mode. */
export interface SpaceFederationV1 {
  id: string
  name: string
  spaceIds: readonly string[]
}

/** Versioned Owner projection of cross-Space recall authority. */
export interface MemorySpaceSharingSnapshotV1 {
  schemaVersion: 1
  ownerId: string
  revision: string
  mode: InterSpaceModeV1
  grants: readonly SpaceShareGrantV1[]
  federations: readonly SpaceFederationV1[]
}

/** Exact-revision replacement of one Owner's complete sharing policy. */
export interface ReplaceMemorySpaceSharingPolicyRequestV1 {
  ownerId: string
  expectedRevision: string
  mode: InterSpaceModeV1
  grants: readonly SpaceShareGrantV1[]
  federations: readonly SpaceFederationV1[]
}

/** Receipt proving why one Source Space may contribute read-only recall. */
export type SpaceRecallAuthorizationV1 =
  | {
      kind: 'space-share-grant'
      relationId: string
      policyRevision: string
      memoryKinds: readonly MemoryKind[]
      visibilities: readonly MemoryVisibility[]
    }
  | {
      kind: 'space-federation'
      relationId: string
      policyRevision: string
    }

/** Authorized cross-Space source expansion for one Active Space. */
export interface AuthorizedSpaceRecallSourceV1 {
  sourceSpaceId: string
  authorization: SpaceRecallAuthorizationV1
}

/** Fail-closed result used by the Archive Router; local recall is intentionally omitted. */
export interface MemorySpaceRecallSourcesV1 {
  schemaVersion: 1
  ownerId: string
  activeSpaceId: string
  policyRevision: string
  mode: InterSpaceModeV1
  sources: readonly AuthorizedSpaceRecallSourceV1[]
}

/** Public governance seam for versioned cross-Space recall authority. */
export interface MemorySpaceSharingCatalogV1 {
  inspect(request: { ownerId: string }): Promise<MemorySpaceSharingSnapshotV1>
  replacePolicy(request: ReplaceMemorySpaceSharingPolicyRequestV1): Promise<MemorySpaceSharingSnapshotV1>
  resolveRecallSources(request: { ownerId: string; activeSpaceId: string }): Promise<MemorySpaceRecallSourcesV1>
}

/** Construction inputs for the separate sharing catalog. */
export interface OpenMemorySpaceSharingCatalogOptions {
  path: string
  spaces: MemorySpaceCatalogV1
  createRevision?: () => string
  leaseTimeoutMs?: number
  leaseStaleMs?: number
}

/** Stable fail-closed codes surfaced by the sharing seam. */
export type MemorySpaceSharingErrorCode =
  | 'MEMORY_SPACE_SHARING_REVISION_MISMATCH'
  | 'MEMORY_SPACE_SHARING_SPACE_UNAVAILABLE'
  | 'MEMORY_SPACE_SHARE_GRANT_INVALID'
  | 'MEMORY_SPACE_FEDERATION_INVALID'

/** Public sharing failure with a stable machine-readable code. */
export class MemorySpaceSharingError extends Error {
  constructor(message: string, readonly code: MemorySpaceSharingErrorCode) {
    super(message)
    this.name = 'MemorySpaceSharingError'
  }
}

interface MemorySpaceSharingDocumentV1 {
  schemaVersion: 1
  policies: readonly MemorySpaceSharingSnapshotV1[]
}

const MEMORY_KINDS: readonly MemoryKind[] = [
  'preference',
  'biographical',
  'boundary',
  'commitment',
  'relationship',
  'episode',
  'state',
  'summary',
]
const VISIBILITIES: readonly MemoryVisibility[] = ['personal', 'confidential']

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`invalid ${label}`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`invalid ${label}`)
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`invalid ${label}`)
  return value
}

function safeId(value: unknown, label: string): string {
  const id = nonEmpty(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) throw new Error(`invalid ${label}`)
  return id
}

function parseStringSet<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): readonly T[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => !allowed.includes(item as T))) {
    throw new Error(`invalid ${label}`)
  }
  const result = value as T[]
  if (new Set(result).size !== result.length) throw new Error(`invalid ${label}`)
  return [...result]
}

function parseGrant(value: unknown): SpaceShareGrantV1 {
  const grant = object(value, 'Space Share Grant')
  exactKeys(grant, ['id', 'sourceSpaceId', 'targetSpaceId', 'memoryKinds', 'visibilities'], 'Space Share Grant')
  const sourceSpaceId = safeId(grant.sourceSpaceId, 'Source Space id')
  const targetSpaceId = safeId(grant.targetSpaceId, 'Target Space id')
  if (sourceSpaceId === targetSpaceId) {
    throw new MemorySpaceSharingError('Space Share Grant cannot target its Source Space', 'MEMORY_SPACE_SHARE_GRANT_INVALID')
  }
  return {
    id: safeId(grant.id, 'Space Share Grant id'),
    sourceSpaceId,
    targetSpaceId,
    memoryKinds: parseStringSet(grant.memoryKinds, MEMORY_KINDS, 'Space Share Grant memoryKinds'),
    visibilities: parseStringSet(grant.visibilities, VISIBILITIES, 'Space Share Grant visibilities'),
  }
}

function parseFederation(value: unknown): SpaceFederationV1 {
  const federation = object(value, 'Space Federation')
  exactKeys(federation, ['id', 'name', 'spaceIds'], 'Space Federation')
  if (!Array.isArray(federation.spaceIds) || federation.spaceIds.length < 2) {
    throw new MemorySpaceSharingError('Space Federation requires at least two Spaces', 'MEMORY_SPACE_FEDERATION_INVALID')
  }
  const spaceIds = federation.spaceIds.map(id => safeId(id, 'Space Federation member id'))
  if (new Set(spaceIds).size !== spaceIds.length) {
    throw new MemorySpaceSharingError('Space Federation members must be unique', 'MEMORY_SPACE_FEDERATION_INVALID')
  }
  return {
    id: safeId(federation.id, 'Space Federation id'),
    name: nonEmpty(federation.name, 'Space Federation name'),
    spaceIds,
  }
}

function parseSnapshot(value: unknown): MemorySpaceSharingSnapshotV1 {
  const policy = object(value, 'Memory Space sharing policy')
  exactKeys(policy, ['schemaVersion', 'ownerId', 'revision', 'mode', 'grants', 'federations'], 'Memory Space sharing policy')
  if (policy.schemaVersion !== 1
    || (policy.mode !== 'isolated' && policy.mode !== 'selective' && policy.mode !== 'federated')
    || !Array.isArray(policy.grants) || !Array.isArray(policy.federations)) {
    throw new Error('invalid Memory Space sharing policy')
  }
  const grants = policy.grants.map(parseGrant)
  const federations = policy.federations.map(parseFederation)
  if (new Set(grants.map(grant => grant.id)).size !== grants.length
    || new Set(federations.map(federation => federation.id)).size !== federations.length) {
    throw new Error('duplicate Memory Space sharing relation id')
  }
  const federationMembers = federations.flatMap(federation => federation.spaceIds)
  if (new Set(federationMembers).size !== federationMembers.length) {
    throw new MemorySpaceSharingError('one Space may belong to at most one Federation', 'MEMORY_SPACE_FEDERATION_INVALID')
  }
  return {
    schemaVersion: 1,
    ownerId: nonEmpty(policy.ownerId, 'Memory Space sharing Owner'),
    revision: nonEmpty(policy.revision, 'Memory Space sharing revision'),
    mode: policy.mode,
    grants,
    federations,
  }
}

function parseDocument(value: unknown): MemorySpaceSharingDocumentV1 {
  const document = object(value, 'Memory Space sharing document')
  exactKeys(document, ['schemaVersion', 'policies'], 'Memory Space sharing document')
  if (document.schemaVersion !== 1 || !Array.isArray(document.policies)) {
    throw new Error('invalid Memory Space sharing document')
  }
  const policies = document.policies.map(parseSnapshot)
  if (new Set(policies.map(policy => policy.ownerId)).size !== policies.length) {
    throw new Error('duplicate Memory Space sharing Owner policy')
  }
  return { schemaVersion: 1, policies }
}

async function readDocument(path: string): Promise<MemorySpaceSharingDocumentV1> {
  try {
    return parseDocument(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (objectCode(error) === 'ENOENT') return { schemaVersion: 1, policies: [] }
    throw error
  }
}

function objectCode(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? (value as { code?: unknown }).code : undefined
}

async function replaceDocument(path: string, document: MemorySpaceSharingDocumentV1): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch(error => {
      if (objectCode(error) !== 'ENOENT') throw error
    })
  }
}

async function ensureLeaseTarget(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'a')
  await handle.close()
}

function defaultPolicy(ownerId: string): MemorySpaceSharingSnapshotV1 {
  return { schemaVersion: 1, ownerId, revision: '0', mode: 'isolated', grants: [], federations: [] }
}

const leaseAdapter = createFileArchiveLeaseAdapter()

class FileMemorySpaceSharingCatalog implements MemorySpaceSharingCatalogV1 {
  constructor(
    private readonly path: string,
    private readonly spaces: MemorySpaceCatalogV1,
    private readonly createRevision: () => string,
    private readonly archiveLease: ArchiveLeaseAdapter,
    private readonly leaseTimeoutMs: number,
    private readonly leaseStaleMs: number,
  ) {}

  async inspect(request: { ownerId: string }): Promise<MemorySpaceSharingSnapshotV1> {
    const ownerId = nonEmpty(request.ownerId, 'Memory Space sharing Owner')
    const document = await readDocument(this.path)
    return structuredClone(document.policies.find(policy => policy.ownerId === ownerId) ?? defaultPolicy(ownerId))
  }

  async replacePolicy(request: ReplaceMemorySpaceSharingPolicyRequestV1): Promise<MemorySpaceSharingSnapshotV1> {
    const candidate = parseSnapshot({
      schemaVersion: 1,
      ownerId: request.ownerId,
      revision: safeId(this.createRevision(), 'Memory Space sharing revision'),
      mode: request.mode,
      grants: request.grants,
      federations: request.federations,
    })
    const ownerSpaces = await this.spaces.inspect({ ownerId: candidate.ownerId })
    const available = new Set(ownerSpaces.spaces.map(space => space.id))
    const referenced = [
      ...candidate.grants.flatMap(grant => [grant.sourceSpaceId, grant.targetSpaceId]),
      ...candidate.federations.flatMap(federation => federation.spaceIds),
    ]
    if (referenced.some(spaceId => !available.has(spaceId))) {
      throw new MemorySpaceSharingError(
        'Memory Space sharing relation references an unavailable Space',
        'MEMORY_SPACE_SHARING_SPACE_UNAVAILABLE',
      )
    }
    const leaseTarget = `${this.path}.lease-target`
    await ensureLeaseTarget(leaseTarget)
    return this.archiveLease.withExclusiveLease(
      leaseTarget,
      this.leaseTimeoutMs,
      async lease => {
        const document = await readDocument(this.path)
        const current = document.policies.find(policy => policy.ownerId === candidate.ownerId)
          ?? defaultPolicy(candidate.ownerId)
        if (current.revision !== request.expectedRevision) {
          throw new MemorySpaceSharingError(
            'Memory Space sharing policy revision changed',
            'MEMORY_SPACE_SHARING_REVISION_MISMATCH',
          )
        }
        const next: MemorySpaceSharingDocumentV1 = {
          schemaVersion: 1,
          policies: [
            ...document.policies.filter(policy => policy.ownerId !== candidate.ownerId),
            candidate,
          ],
        }
        await replaceDocument(this.path, next)
        lease.assertHeld()
        return structuredClone(candidate)
      },
      this.leaseStaleMs,
    )
  }

  async resolveRecallSources(request: { ownerId: string; activeSpaceId: string }): Promise<MemorySpaceRecallSourcesV1> {
    const ownerId = nonEmpty(request.ownerId, 'Memory Space sharing Owner')
    const activeSpaceId = safeId(request.activeSpaceId, 'Active Space id')
    const ownerSpaces = await this.spaces.inspect({ ownerId })
    if (!ownerSpaces.spaces.some(space => space.id === activeSpaceId)) {
      throw new MemorySpaceSharingError(
        'Active Space is unavailable for Owner',
        'MEMORY_SPACE_SHARING_SPACE_UNAVAILABLE',
      )
    }
    const policy = await this.inspect({ ownerId })
    const selectiveSources: AuthorizedSpaceRecallSourceV1[] = policy.grants
          .filter(grant => grant.targetSpaceId === activeSpaceId)
          .map(grant => ({
            sourceSpaceId: grant.sourceSpaceId,
            authorization: {
              kind: 'space-share-grant',
              relationId: grant.id,
              policyRevision: policy.revision,
              memoryKinds: [...grant.memoryKinds],
              visibilities: [...grant.visibilities],
            },
          }))
    const federation = policy.federations.find(candidate => candidate.spaceIds.includes(activeSpaceId))
    const federatedSources: AuthorizedSpaceRecallSourceV1[] = federation === undefined
      ? []
      : federation.spaceIds
          .filter(spaceId => spaceId !== activeSpaceId)
          .map(sourceSpaceId => ({
            sourceSpaceId,
            authorization: {
              kind: 'space-federation',
              relationId: federation.id,
              policyRevision: policy.revision,
            },
          }))
    const sources = policy.mode === 'selective'
      ? selectiveSources
      : policy.mode === 'federated'
        ? federatedSources
        : []
    return {
      schemaVersion: 1,
      ownerId,
      activeSpaceId,
      policyRevision: policy.revision,
      mode: policy.mode,
      sources,
    }
  }
}

/** Open the Owner-governed sharing catalog without changing Workspace Bindings. */
export async function openMemorySpaceSharingCatalog(
  options: OpenMemorySpaceSharingCatalogOptions,
): Promise<MemorySpaceSharingCatalogV1> {
  const path = nonEmpty(options.path, 'Memory Space sharing path')
  await readDocument(path)
  return new FileMemorySpaceSharingCatalog(
    path,
    options.spaces,
    options.createRevision ?? randomUUID,
    leaseAdapter,
    options.leaseTimeoutMs ?? 30_000,
    options.leaseStaleMs ?? 120_000,
  )
}
