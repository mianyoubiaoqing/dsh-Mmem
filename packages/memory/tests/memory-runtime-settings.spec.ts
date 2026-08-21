import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMemoryRuntimeSettings, updateMemoryApprovalPolicy } from '../src/runtime-settings.js'

describe('Memory runtime settings', () => {
  it('defaults to revision-zero manual approval when no Owner settings exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-settings-'))

    await expect(loadMemoryRuntimeSettings(join(root, 'settings.json'), 8)).resolves.toEqual({
      schemaVersion: 1,
      recallLimit: 8,
      approvalPolicy: {
        schemaVersion: 1,
        revision: 0,
        mode: 'manual',
      },
    })
  })

  it('persists an explicitly enabled scheduled-auto policy with a new revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-settings-'))
    const path = join(root, 'settings.json')

    await expect(updateMemoryApprovalPolicy(path, 8, {
      expectedRevision: 0,
      mode: 'scheduled-auto',
      timeZone: 'Asia/Shanghai',
      localTime: '03:30',
    })).resolves.toMatchObject({
      approvalPolicy: {
        schemaVersion: 1,
        revision: 1,
        mode: 'scheduled-auto',
        timeZone: 'Asia/Shanghai',
        localTime: '03:30',
      },
    })
    await expect(loadMemoryRuntimeSettings(path, 8)).resolves.toMatchObject({
      approvalPolicy: { revision: 1, mode: 'scheduled-auto' },
    })
  })

  it('fails closed when an approval policy update uses a stale revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-settings-'))
    const path = join(root, 'settings.json')
    await updateMemoryApprovalPolicy(path, 8, { expectedRevision: 0, mode: 'manual' })

    await expect(updateMemoryApprovalPolicy(path, 8, {
      expectedRevision: 0,
      mode: 'scheduled-auto',
      timeZone: 'Asia/Shanghai',
      localTime: '03:30',
    })).rejects.toMatchObject({ code: 'SETTINGS_REVISION_CONFLICT' })
    await expect(loadMemoryRuntimeSettings(path, 8)).resolves.toMatchObject({
      approvalPolicy: { revision: 1, mode: 'manual' },
    })
  })

  it('allows only one concurrent update from the same observed revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-settings-'))
    const path = join(root, 'settings.json')

    const results = await Promise.allSettled([
      updateMemoryApprovalPolicy(path, 8, { expectedRevision: 0, mode: 'manual' }),
      updateMemoryApprovalPolicy(path, 8, {
        expectedRevision: 0,
        mode: 'scheduled-auto',
        timeZone: 'Asia/Shanghai',
        localTime: '03:30',
      }),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([
      { reason: { code: 'SETTINGS_REVISION_CONFLICT' } },
    ])
  })

  it.each([
    { timeZone: 'not/a-zone', localTime: '03:30' },
    { timeZone: 'Asia/Shanghai', localTime: '24:00' },
  ])('rejects an invalid scheduled-auto clock: $timeZone $localTime', async ({ timeZone, localTime }) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-settings-'))

    await expect(updateMemoryApprovalPolicy(join(root, 'settings.json'), 8, {
      expectedRevision: 0,
      mode: 'scheduled-auto',
      timeZone,
      localTime,
    })).rejects.toThrow(/timeZone|localTime/u)
  })
})
