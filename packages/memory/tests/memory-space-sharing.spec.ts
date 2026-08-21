import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  openMemorySpaceCatalog,
  openMemorySpaceSharingCatalog,
} from '../src/index.js'

describe('MemorySpaceSharingCatalogV1', () => {
  it('defaults every Owner to an isolated revision-zero policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-space-sharing-'))
    const spaces = await openMemorySpaceCatalog({ path: join(root, 'spaces.json') })
    const sharing = await openMemorySpaceSharingCatalog({
      path: join(root, 'sharing.json'),
      spaces,
    })

    await expect(sharing.inspect({ ownerId: 'owner-fixture' })).resolves.toEqual({
      schemaVersion: 1,
      ownerId: 'owner-fixture',
      revision: '0',
      mode: 'isolated',
      grants: [],
      federations: [],
    })
  })

  it('persists a selective one-way read grant and resolves only its Source Space', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-selective-sharing-'))
    const ids = ['space-source', 'space-target', 'space-unrelated']
    const spaces = await openMemorySpaceCatalog({
      path: join(root, 'spaces.json'),
      createId: () => ids.shift() ?? 'unexpected-space',
      now: () => new Date('2026-08-21T20:00:00.000Z'),
    })
    for (const name of ['Source', 'Target', 'Unrelated']) {
      await spaces.createSpace({ ownerId: 'owner-fixture', name })
    }
    const path = join(root, 'sharing.json')
    const sharing = await openMemorySpaceSharingCatalog({
      path,
      spaces,
      createRevision: () => 'sharing-v1',
    })

    await expect(sharing.replacePolicy({
      ownerId: 'owner-fixture',
      expectedRevision: '0',
      mode: 'selective',
      grants: [{
        id: 'grant-source-to-target',
        sourceSpaceId: 'space-source',
        targetSpaceId: 'space-target',
        memoryKinds: ['preference', 'summary'],
        visibilities: ['personal'],
      }],
      federations: [],
    })).resolves.toMatchObject({ revision: 'sharing-v1', mode: 'selective' })

    const reopened = await openMemorySpaceSharingCatalog({ path, spaces })
    await expect(reopened.resolveRecallSources({
      ownerId: 'owner-fixture',
      activeSpaceId: 'space-target',
    })).resolves.toEqual({
      schemaVersion: 1,
      ownerId: 'owner-fixture',
      activeSpaceId: 'space-target',
      policyRevision: 'sharing-v1',
      mode: 'selective',
      sources: [{
        sourceSpaceId: 'space-source',
        authorization: {
          kind: 'space-share-grant',
          relationId: 'grant-source-to-target',
          policyRevision: 'sharing-v1',
          memoryKinds: ['preference', 'summary'],
          visibilities: ['personal'],
        },
      }],
    })
  })

  it('expands only explicit members of the Active Space Federation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-federated-sharing-'))
    const ids = ['space-a', 'space-b', 'space-outside']
    const spaces = await openMemorySpaceCatalog({
      path: join(root, 'spaces.json'),
      createId: () => ids.shift() ?? 'unexpected-space',
      now: () => new Date('2026-08-21T21:00:00.000Z'),
    })
    for (const name of ['A', 'B', 'Outside']) {
      await spaces.createSpace({ ownerId: 'owner-fixture', name })
    }
    const sharing = await openMemorySpaceSharingCatalog({
      path: join(root, 'sharing.json'),
      spaces,
      createRevision: () => 'sharing-federated-v1',
    })
    await sharing.replacePolicy({
      ownerId: 'owner-fixture',
      expectedRevision: '0',
      mode: 'federated',
      grants: [],
      federations: [{
        id: 'federation-projects',
        name: 'Projects',
        spaceIds: ['space-a', 'space-b'],
      }],
    })

    await expect(sharing.resolveRecallSources({
      ownerId: 'owner-fixture',
      activeSpaceId: 'space-a',
    })).resolves.toMatchObject({
      mode: 'federated',
      sources: [{
        sourceSpaceId: 'space-b',
        authorization: {
          kind: 'space-federation',
          relationId: 'federation-projects',
          policyRevision: 'sharing-federated-v1',
        },
      }],
    })
  })

  it('never follows a chain of selective grants transitively', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-non-transitive-sharing-'))
    const ids = ['space-a', 'space-b', 'space-c']
    const spaces = await openMemorySpaceCatalog({
      path: join(root, 'spaces.json'),
      createId: () => ids.shift() ?? 'unexpected-space',
    })
    for (const name of ['A', 'B', 'C']) await spaces.createSpace({ ownerId: 'owner-fixture', name })
    const sharing = await openMemorySpaceSharingCatalog({
      path: join(root, 'sharing.json'),
      spaces,
      createRevision: () => 'sharing-chain-v1',
    })
    await sharing.replacePolicy({
      ownerId: 'owner-fixture',
      expectedRevision: '0',
      mode: 'selective',
      grants: [
        {
          id: 'grant-a-to-b',
          sourceSpaceId: 'space-a',
          targetSpaceId: 'space-b',
          memoryKinds: ['summary'],
          visibilities: ['personal'],
        },
        {
          id: 'grant-b-to-c',
          sourceSpaceId: 'space-b',
          targetSpaceId: 'space-c',
          memoryKinds: ['summary'],
          visibilities: ['personal'],
        },
      ],
      federations: [],
    })

    await expect(sharing.resolveRecallSources({
      ownerId: 'owner-fixture',
      activeSpaceId: 'space-c',
    })).resolves.toMatchObject({
      sources: [{ sourceSpaceId: 'space-b' }],
    })
  })

  it('rejects a stale whole-policy replacement without changing the current policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-sharing-revision-'))
    const spaces = await openMemorySpaceCatalog({ path: join(root, 'spaces.json') })
    const sharing = await openMemorySpaceSharingCatalog({
      path: join(root, 'sharing.json'),
      spaces,
      createRevision: () => 'sharing-v1',
    })
    await sharing.replacePolicy({
      ownerId: 'owner-fixture',
      expectedRevision: '0',
      mode: 'isolated',
      grants: [],
      federations: [],
    })

    await expect(sharing.replacePolicy({
      ownerId: 'owner-fixture',
      expectedRevision: '0',
      mode: 'federated',
      grants: [],
      federations: [],
    })).rejects.toMatchObject({ code: 'MEMORY_SPACE_SHARING_REVISION_MISMATCH' })
    await expect(sharing.inspect({ ownerId: 'owner-fixture' })).resolves.toMatchObject({
      revision: 'sharing-v1',
      mode: 'isolated',
    })
  })

  it('rejects ambiguous duplicate grants between the same Source and Target Spaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-duplicate-grants-'))
    const ids = ['space-source', 'space-target']
    const spaces = await openMemorySpaceCatalog({
      path: join(root, 'spaces.json'),
      createId: () => ids.shift() ?? 'unexpected-space',
    })
    await spaces.createSpace({ ownerId: 'owner-fixture', name: 'Source' })
    await spaces.createSpace({ ownerId: 'owner-fixture', name: 'Target' })
    const sharing = await openMemorySpaceSharingCatalog({
      path: join(root, 'sharing.json'),
      spaces,
    })

    await expect(sharing.replacePolicy({
      ownerId: 'owner-fixture',
      expectedRevision: '0',
      mode: 'selective',
      grants: [
        {
          id: 'grant-preference',
          sourceSpaceId: 'space-source',
          targetSpaceId: 'space-target',
          memoryKinds: ['preference'],
          visibilities: ['personal'],
        },
        {
          id: 'grant-summary',
          sourceSpaceId: 'space-source',
          targetSpaceId: 'space-target',
          memoryKinds: ['summary'],
          visibilities: ['personal'],
        },
      ],
      federations: [],
    })).rejects.toMatchObject({ code: 'MEMORY_SPACE_SHARE_GRANT_INVALID' })
  })
})
