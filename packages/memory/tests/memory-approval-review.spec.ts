import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  MemoryApprovalReviewEvaluatorRegistryV1,
  createGovernedMemoryScheduledApprovalRunnerV1,
} from '../src/approval-review.js'
import { LocalDshMemoryPrincipalResolver } from '../src/principal.js'
import { createMemoryRuntimeSettingsManager, updateMemoryApprovalPolicy } from '../src/runtime-settings.js'
import { openMemorySpaceCatalog } from '../src/space-catalog.js'
import { openMemorySpaceArchiveRouter } from '../src/index.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-review-'))
  const settingsPath = join(root, 'settings.json')
  await updateMemoryApprovalPolicy(settingsPath, 8, {
    expectedRevision: 0,
    mode: 'scheduled-auto',
    timeZone: 'Asia/Shanghai',
    localTime: '03:30',
  })
  const settings = createMemoryRuntimeSettingsManager({ path: settingsPath, fallbackRecallLimit: 8 })
  const catalog = await openMemorySpaceCatalog({ path: join(root, 'catalog.json') })
  const router = await openMemorySpaceArchiveRouter({
    catalog,
    spacesRoot: join(root, 'spaces'),
  })
  const principalResolver = new LocalDshMemoryPrincipalResolver({ ownerId: 'owner-fixture' })
  const space = await catalog.createSpace({ ownerId: 'owner-fixture', name: 'Review Space' })
  const binding = await catalog.bindDshWorkspace({
    ownerId: 'owner-fixture',
    sessionHeader: { cwd: 'D:\\workspaces\\review-space' },
    spaceId: space.id,
    access: 'read-write',
    defaultWrite: true,
  })
  const archive = await router.resolveSession({
    ownerId: 'owner-fixture',
    sessionHeader: { cwd: binding.dshWorkspaceCwd },
    requestedSpaceId: space.id,
  })
  if (archive.kind !== 'active') throw new Error('expected active fixture Space')
  const evaluators = new MemoryApprovalReviewEvaluatorRegistryV1()
  const runner = createGovernedMemoryScheduledApprovalRunnerV1({
    principalResolver,
    catalog,
    router,
    settings,
    evaluators,
    maxCandidates: 20,
    minimumConfidence: 0.9,
  })
  return { settingsPath, settings, catalog, router, archive, evaluators, runner, space, binding }
}

const scheduledRequest = {
  schemaVersion: 1 as const,
  runId: 'scheduled-auto:r1:2026-08-21',
  policy: {
    schemaVersion: 1 as const,
    revision: 1,
    mode: 'scheduled-auto' as const,
    timeZone: 'Asia/Shanghai',
    localTime: '03:30',
  },
  slot: { localDate: '2026-08-21', dueAt: '2026-08-20T19:30:00.000Z' },
  signal: new AbortController().signal,
}

describe('Governed scheduled approval runner', () => {
  it('commits a high-confidence DSH Session recommendation after exact revalidation', async () => {
    const target = await fixture()
    const candidate = await target.archive.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'source-review-1',
      content: 'Owner prefers concise neutral summaries.',
      visibility: 'personal',
      memoryKind: 'preference',
    })
    target.evaluators.register({
      id: 'dsh-review-fixture',
      version: '1',
      evaluate: async request => ({
        schemaVersion: 1,
        candidateId: request.candidate.id,
        decision: 'approve',
        confidence: 0.97,
        reasonCode: 'supported',
        receipt: {
          schemaVersion: 1,
          sessionId: 'review-session-1',
          requestMessageId: 'review-request-1',
          responseMessageId: 'review-response-1',
          requestSeq: 3,
          responseSeq: 8,
          provider: 'fixture-provider',
          model: 'fixture-model',
        },
      }),
    })

    await expect(target.runner.run(scheduledRequest)).resolves.toMatchObject({
      reviewedCandidates: 1,
      approvedCandidates: 1,
      rejectedCandidates: 0,
      deferredCandidates: 0,
      reviewReceipts: [{ candidateId: candidate.id, responseMessageId: 'review-response-1' }],
    })
    expect(target.archive.listCandidates({
      context: PERSONAL_COMPANION_ACCESS,
      includeResolved: true,
    })).toMatchObject([{ id: candidate.id, status: 'approved' }])
    expect(target.archive.list({ context: PERSONAL_COMPANION_ACCESS })).toMatchObject([{
      sourceCandidateId: candidate.id,
      sourceMessageId: 'review-response-1',
    }])
  })

  it('defers when the policy revision changes while the evaluator is running', async () => {
    const target = await fixture()
    const candidate = await target.archive.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'source-review-2',
      content: 'Owner prefers explicit review boundaries.',
      visibility: 'personal',
      memoryKind: 'preference',
    })
    target.evaluators.register({
      id: 'dsh-review-fixture',
      version: '1',
      evaluate: async () => {
        await updateMemoryApprovalPolicy(target.settingsPath, 8, { expectedRevision: 1, mode: 'manual' })
        return {
          schemaVersion: 1,
          candidateId: candidate.id,
          decision: 'approve',
          confidence: 0.99,
          reasonCode: 'supported',
          receipt: {
            schemaVersion: 1,
            sessionId: 'review-session-2',
            requestMessageId: 'review-request-2',
            responseMessageId: 'review-response-2',
            requestSeq: 3,
            responseSeq: 8,
            provider: 'fixture-provider',
            model: 'fixture-model',
          },
        }
      },
    })

    await expect(target.runner.run(scheduledRequest)).resolves.toMatchObject({
      reviewedCandidates: 1,
      approvedCandidates: 0,
      rejectedCandidates: 0,
      deferredCandidates: 1,
    })
    expect(target.archive.listCandidates({ context: PERSONAL_COMPANION_ACCESS })).toMatchObject([
      { id: candidate.id, status: 'pending' },
    ])
  })

  it('defers blocking deterministic conflicts without asking the model to choose a resolution', async () => {
    const target = await fixture()
    const original = await target.archive.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'source-original',
      content: 'The deployment uses a neutral blue theme.',
      visibility: 'personal',
      memoryKind: 'state',
    })
    await target.archive.approveCandidate({
      context: PERSONAL_COMPANION_ACCESS,
      candidateId: original.id,
      sourceMessageId: 'manual-original-approval',
    })
    const duplicate = await target.archive.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'source-duplicate',
      content: 'The deployment uses a neutral blue theme.',
      visibility: 'personal',
      memoryKind: 'state',
    })
    const evaluate = vi.fn()
    target.evaluators.register({ id: 'dsh-review-fixture', version: '1', evaluate })

    await expect(target.runner.run(scheduledRequest)).resolves.toMatchObject({
      reviewedCandidates: 1,
      approvedCandidates: 0,
      rejectedCandidates: 0,
      deferredCandidates: 1,
    })
    expect(evaluate).not.toHaveBeenCalled()
    expect(target.archive.listCandidates({ context: PERSONAL_COMPANION_ACCESS })).toMatchObject([
      { id: duplicate.id, status: 'pending' },
    ])
  })

  it('supplies temporary Source Turn evidence before auto-approving a model-compressed summary', async () => {
    const target = await fixture()
    const candidate = await target.archive.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'dsh-turn:source-summary:1',
      content: '本轮摘要（未审核，模型压缩）：讨论灰度发布与回滚检查。',
      visibility: 'personal',
      memoryKind: 'summary',
      extraction: {
        schemaVersion: 1,
        providerId: 'dsh-turn-summary',
        providerVersion: '1',
        receipt: { kind: 'dsh-session', sessionId: 'summary-session', requestSeq: 2, responseSeq: 5 },
      },
      turnEvidence: {
        schemaVersion: 1,
        sessionId: 'source-summary',
        turn: 1,
        userMessages: [{ messageId: 'source-user', text: '讨论灰度发布。' }],
        assistantMessage: { messageId: 'source-assistant', text: '保留回滚检查点。' },
      },
    })
    const evaluate = vi.fn(async () => ({
      schemaVersion: 1,
      candidateId: candidate.id,
      decision: 'approve',
      confidence: 0.97,
      reasonCode: 'supported',
      receipt: {
        schemaVersion: 1,
        sessionId: 'review-model-summary',
        requestMessageId: 'review-model-summary-request',
        responseMessageId: 'review-model-summary-response',
        requestSeq: 3,
        responseSeq: 8,
        provider: 'fixture-provider',
        model: 'fixture-model',
      },
    }))
    target.evaluators.register({ id: 'dsh-review-fixture', version: '1', evaluate })

    await expect(target.runner.run(scheduledRequest)).resolves.toMatchObject({ approvedCandidates: 1 })
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      turnEvidence: expect.stringContaining('[user:source-user] 讨论灰度发布。'),
    }))
  })

  it('defers a model-compressed summary when its temporary Source Turn evidence is unavailable', async () => {
    const target = await fixture()
    await target.archive.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'model-summary-without-evidence',
      content: '本轮摘要（未审核，模型压缩）：不可验证的摘要。',
      visibility: 'personal',
      memoryKind: 'summary',
      extraction: {
        schemaVersion: 1,
        providerId: 'dsh-turn-summary',
        providerVersion: '1',
        receipt: { kind: 'dsh-session', sessionId: 'summary-session', requestSeq: 2, responseSeq: 5 },
      },
    })
    const evaluate = vi.fn()
    target.evaluators.register({ id: 'dsh-review-fixture', version: '1', evaluate })

    await expect(target.runner.run(scheduledRequest)).resolves.toMatchObject({
      approvedCandidates: 0,
      deferredCandidates: 1,
    })
    expect(evaluate).not.toHaveBeenCalled()
  })
})
