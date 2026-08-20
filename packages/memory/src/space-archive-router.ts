import { isAbsolute, join } from 'node:path'
import type {
  CompanionMemoryArchive,
  MemoryRecallItemV1,
  MemoryRecallSnapshotV1,
  MemoryRetrievalRequestV1,
} from './contracts.js'
import type {
  ActiveSpaceResolutionV1,
  MemorySpaceCatalogV1,
  ResolveActiveSpaceRequestV1,
} from './space-catalog.js'

/** Active Space facade that keeps Archive selection outside model-controlled inputs. */
export interface ActiveSpaceMemoryV1 extends Omit<CompanionMemoryArchive, 'dispose' | 'retrieve'> {
  schemaVersion: 1
  kind: 'active'
  spaceId: string
  access: 'read' | 'read-write'
  bindingRevision: string
  retrieve(input: MemoryRetrievalRequestV1): Promise<MemorySpaceRecallSnapshotV1>
}

/** One recalled item retaining the authoritative Memory Space of its record. */
export interface MemorySpaceRecallItemV1 extends MemoryRecallItemV1 {
  sourceSpaceId: string
}

/** Model-visible recall receipt with exact Active Space and Binding revision. */
export interface MemorySpaceRecallSnapshotV1 extends Omit<MemoryRecallSnapshotV1, 'items'> {
  activeSpace: {
    spaceId: string
    access: 'read' | 'read-write'
    bindingRevision: string
  }
  items: MemorySpaceRecallItemV1[]
}

/** Result of resolving a DSH Session to one physically isolated Space Archive. */
export type MemorySpaceSessionResolutionV1 =
  | ActiveSpaceMemoryV1
  | Extract<ActiveSpaceResolutionV1, { kind: 'unavailable' }>

/** Public seam that owns Active Space resolution and per-Space Archive lifetime. */
export interface MemorySpaceArchiveRouterV1 {
  resolveSession(request: ResolveActiveSpaceRequestV1): Promise<MemorySpaceSessionResolutionV1>
  dispose(): Promise<void>
}

/** Catalog and private root required by the Space Archive Router. */
export interface MemorySpaceArchiveRouterOptions {
  catalog: MemorySpaceCatalogV1
  spacesRoot: string
}

/** Stable fail-closed codes surfaced by the Space Archive Router. */
export type MemorySpaceArchiveRouterErrorCode =
  | 'MEMORY_SPACE_READ_ONLY'
  | 'MEMORY_SPACE_OWNER_MISMATCH'
  | 'MEMORY_SPACE_ROUTER_DISPOSED'

/** Public routing failure with a stable machine-readable code. */
export class MemorySpaceArchiveRouterError extends Error {
  constructor(message: string, readonly code: MemorySpaceArchiveRouterErrorCode) {
    super(message)
    this.name = 'MemorySpaceArchiveRouterError'
  }
}

/** @internal Archive construction seam supplied by the package root. */
export type MemorySpaceArchiveOpener = (path: string) => Promise<CompanionMemoryArchive>

function requireOwner(ownerId: string, inputOwnerId: string): void {
  if (ownerId !== inputOwnerId) {
    throw new MemorySpaceArchiveRouterError(
      'Active Space Archive Owner mismatch',
      'MEMORY_SPACE_OWNER_MISMATCH',
    )
  }
}

function requireWrite(access: 'read' | 'read-write'): void {
  if (access !== 'read-write') {
    throw new MemorySpaceArchiveRouterError(
      'Active Space Archive is read-only',
      'MEMORY_SPACE_READ_ONLY',
    )
  }
}

class SpaceArchiveRouter implements MemorySpaceArchiveRouterV1 {
  readonly #archives = new Map<string, Promise<CompanionMemoryArchive>>()
  #disposed = false

  constructor(
    private readonly catalog: MemorySpaceCatalogV1,
    private readonly spacesRoot: string,
    private readonly openArchive: MemorySpaceArchiveOpener,
  ) {}

  #archive(spaceId: string): Promise<CompanionMemoryArchive> {
    const existing = this.#archives.get(spaceId)
    if (existing !== undefined) return existing
    const opened = this.openArchive(join(this.spacesRoot, spaceId, 'memories.jsonl'))
    this.#archives.set(spaceId, opened)
    return opened
  }

  #facade(
    ownerId: string,
    resolution: Extract<ActiveSpaceResolutionV1, { kind: 'active' }>,
    archive: CompanionMemoryArchive,
  ): ActiveSpaceMemoryV1 {
    const read = <T extends { context: { ownerId: string } }>(input: T): void => {
      requireOwner(ownerId, input.context.ownerId)
    }
    const write = <T extends { context: { ownerId: string } }>(input: T): void => {
      read(input)
      requireWrite(resolution.access)
    }
    return {
      ...resolution,
      inspection: () => archive.inspection(),
      observeExplicit: async input => {
        write(input)
        return archive.observeExplicit(input)
      },
      recall: input => {
        read(input)
        return archive.recall(input)
      },
      retrieve: async input => {
        read(input)
        const snapshot = await archive.retrieve(input)
        return {
          ...snapshot,
          activeSpace: {
            spaceId: resolution.spaceId,
            access: resolution.access,
            bindingRevision: resolution.bindingRevision,
          },
          items: snapshot.items.map(item => ({ ...item, sourceSpaceId: resolution.spaceId })),
        }
      },
      list: input => {
        read(input)
        return archive.list(input)
      },
      forget: async input => {
        write(input)
        return archive.forget(input)
      },
      replace: async input => {
        write(input)
        return archive.replace(input)
      },
      importConfirmed: async input => {
        write(input)
        return archive.importConfirmed(input)
      },
      propose: async input => {
        write(input)
        return archive.propose(input)
      },
      proposeExtracted: async input => {
        write(input)
        return archive.proposeExtracted(input)
      },
      listCandidates: input => {
        read(input)
        return archive.listCandidates(input)
      },
      assessCandidate: input => {
        read(input)
        return archive.assessCandidate(input)
      },
      editCandidate: async input => {
        write(input)
        return archive.editCandidate(input)
      },
      mergeCandidates: async input => {
        write(input)
        return archive.mergeCandidates(input)
      },
      listGovernanceAudit: input => {
        read(input)
        return archive.listGovernanceAudit(input)
      },
      manage: input => {
        read(input)
        return archive.manage(input)
      },
      sourceView: input => {
        read(input)
        return archive.sourceView(input)
      },
      batchDecide: async input => {
        write(input)
        return archive.batchDecide(input)
      },
      approveCandidate: async input => {
        write(input)
        return archive.approveCandidate(input)
      },
      rejectCandidate: async input => {
        write(input)
        return archive.rejectCandidate(input)
      },
      planLifecycle: input => {
        read(input)
        return archive.planLifecycle(input)
      },
      applyLifecycle: async input => {
        write(input)
        return archive.applyLifecycle(input)
      },
    }
  }

  async resolveSession(request: ResolveActiveSpaceRequestV1): Promise<MemorySpaceSessionResolutionV1> {
    if (this.#disposed) {
      throw new MemorySpaceArchiveRouterError(
        'Memory Space Archive Router is disposed',
        'MEMORY_SPACE_ROUTER_DISPOSED',
      )
    }
    const resolution = await this.catalog.resolveActiveSpace(request)
    if (resolution.kind === 'unavailable') return resolution
    const archive = await this.#archive(resolution.spaceId)
    return this.#facade(request.ownerId, resolution, archive)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const archives = [...this.#archives.values()]
    this.#archives.clear()
    await Promise.all(archives.map(async archive => (await archive).dispose()))
  }
}

/** @internal Construct a Router around the package's authoritative Archive opener. */
export function createMemorySpaceArchiveRouter(
  options: MemorySpaceArchiveRouterOptions,
  openArchive: MemorySpaceArchiveOpener,
): MemorySpaceArchiveRouterV1 {
  if (options.spacesRoot === '' || !isAbsolute(options.spacesRoot)) {
    throw new Error('Memory Space Archive root must be absolute')
  }
  return new SpaceArchiveRouter(options.catalog, options.spacesRoot, openArchive)
}
