import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadMemoryTurnSummarySettingsV1,
  updateMemoryTurnSummaryPolicyV1,
} from '../src/runtime-settings.js'
import { defaultMemoryTurnSummaryPolicyV1 } from '../src/turn-summary-policy.js'

describe('Memory turn-summary policy', () => {
  it('defaults every Memory Space to deterministic local compression', () => {
    expect(defaultMemoryTurnSummaryPolicyV1()).toEqual({
      schemaVersion: 1,
      revision: 0,
      mode: 'local-deterministic',
    })
  })

  it('persists an explicit DSH model route for only the selected Memory Space', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-turn-summary-settings-'))
    const path = join(root, 'turn-summary.json')

    await expect(updateMemoryTurnSummaryPolicyV1(path, 'space-project', {
      expectedRevision: 0,
      mode: 'dsh-model',
      provider: 'configured-provider',
      model: 'configured-model',
    })).resolves.toMatchObject({
      schemaVersion: 1,
      revision: 1,
      mode: 'dsh-model',
      provider: 'configured-provider',
      model: 'configured-model',
    })
    const settings = await loadMemoryTurnSummarySettingsV1(path)
    expect(settings.spaces['space-project']).toMatchObject({ revision: 1, mode: 'dsh-model' })
    expect(settings.spaces['space-private']).toBeUndefined()
  })

  it('fails closed on a stale per-Space policy revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-turn-summary-settings-'))
    const path = join(root, 'turn-summary.json')
    await updateMemoryTurnSummaryPolicyV1(path, 'space-project', {
      expectedRevision: 0,
      mode: 'dsh-model',
    })

    await expect(updateMemoryTurnSummaryPolicyV1(path, 'space-project', {
      expectedRevision: 0,
      mode: 'local-deterministic',
    })).rejects.toMatchObject({ code: 'SETTINGS_REVISION_CONFLICT' })
  })

  it('rejects unknown fields and blank model routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-turn-summary-settings-'))
    const path = join(root, 'turn-summary.json')

    await expect(updateMemoryTurnSummaryPolicyV1(path, 'space-project', {
      expectedRevision: 0,
      mode: 'dsh-model',
      provider: '   ',
    })).rejects.toThrow(/provider/u)
    await expect(updateMemoryTurnSummaryPolicyV1(path, 'space-project', {
      expectedRevision: 0,
      mode: 'local-deterministic',
      extra: true,
    })).rejects.toThrow(/unknown/u)
  })
})
