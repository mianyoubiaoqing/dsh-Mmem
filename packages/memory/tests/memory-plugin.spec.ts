import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as IdentityPlugin from '@mistymoon/dsh-identity'
import { describe, expect, it } from 'vitest'
import * as MemoryPlugin from '../src/index.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

function sessionAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

describe('MistyMoon memory plugin', () => {
  it('extracts pending candidates only after a completed top-level Owner reply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-extraction-plugin-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, { path: join(root, 'memory.jsonl'), recallLimit: 4 })
    let calls = 0
    ctx.mistymoonMemoryCandidateExtraction.register({
      id: 'fixture-provider',
      version: '1.0.0',
      executionKind: 'local-deterministic',
      extract: async (request) => {
        calls += 1
        return {
          schemaVersion: 1,
          receipt: { kind: 'local-deterministic', implementationVersion: 'fixture-v1' },
          drafts: [{
            sourceMessageId: request.evidence[0]?.messageId,
            content: '中性自动候选。',
            visibility: 'personal',
            memoryKind: 'summary',
          }],
        }
      },
    })
    const session = Session.create(SessionId('memory-extraction-session'))
    const agent = sessionAgent(session)
    const owner = createUserMessage({
      content: [{ type: 'text', text: '我提供一个中性稳定事实。' }],
      source: { kind: 'user', rpcId: 'rpc-extraction' } as ReturnType<typeof createUserMessage>['source'],
    })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', owner, { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '中性回复。' }],
        source: { provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [] })

    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })

    expect(calls).toBe(1)
    expect(ctx.mistymoonMemory.listCandidates({ context: PERSONAL_COMPANION_ACCESS }))
      .toEqual([expect.objectContaining({ content: '中性自动候选。', status: 'pending' })])
  })

  it('logs the exact recalled-memory projection as a DSH plugin message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-plugin-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, { path: join(root, 'memory.jsonl'), recallLimit: 4 })
    expect(ctx.mistymoonMemory).toBeDefined()
    expect(ctx.mistymoonMemoryGovernance).toBeDefined()
    expect(ctx.mistymoonMemoryAdvancedRetrieval.plans()).toEqual([])
    expect(await ctx.mistymoonMemoryDerivedViews.invalidate([])).toEqual([])
    const session = Session.create(SessionId('memory-session'))
    const agent = sessionAgent(session)
    const remember = createUserMessage({
      content: [{ type: 'text', text: '请记住：我平时喜欢凤凰单丛。' }],
      source: { kind: 'user', rpcId: 'rpc-remember' } as ReturnType<typeof createUserMessage>['source'],
    })
    const ask = createUserMessage({
      content: [{ type: 'text', text: '以后喝什么茶好？' }],
      source: { kind: 'user', rpcId: 'rpc-ask' } as ReturnType<typeof createUserMessage>['source'],
    })
    session.append('turn/start', { turn: 1 })

    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [remember, ask], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [remember, ask] }),
    )
    if (decision.kind !== 'enter') throw new Error('memory plugin unexpectedly rejected the step')
    session.append('step/start', { turn: 1, step: 1 })
    for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })

    const projection = session.events.find(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'mistymoon-memory'
    )
    expect(projection?.type).toBe('user/message')
    if (projection?.type !== 'user/message') throw new Error('memory projection was not logged')
    const recalled = ctx.mistymoonMemory.recall({
      context: PERSONAL_COMPANION_ACCESS,
      query: '凤凰单丛',
      limit: 1,
    })[0]
    if (recalled === undefined) throw new Error('recalled fixture memory missing')
    expect(projection.data.content).toEqual([{
      type: 'text',
      text: 'Relevant confirmed companion memories. Use them only when relevant; '
        + 'do not reveal confidential details without owner intent:\n'
        + `- [memory:${recalled.id}; source:${recalled.sourceMessageId}; reason:mistymoon-bm25:bm25-term-match] `
        + '我平时喜欢凤凰单丛。',
    }])
    expect(projection.data.source).toMatchObject({
      kind: 'plugin',
      plugin: 'mistymoon-memory',
      form: 'snapshot',
    })
  })

  it('does not observe or recall companion memory for a depth-one child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-child-'))
    const path = join(root, 'memory.jsonl')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, { path, recallLimit: 4 })
    let extractionCalls = 0
    ctx.mistymoonMemoryCandidateExtraction.register({
      id: 'child-fixture-provider',
      version: '1.0.0',
      executionKind: 'local-deterministic',
      extract: async () => {
        extractionCalls += 1
        return { schemaVersion: 1, receipt: { kind: 'local-deterministic', implementationVersion: 'v1' }, drafts: [] }
      },
    })
    const id = SessionId('memory-child-session')
    const session = Session.create(id, [], {
      version: 0,
      id,
      createdAt: 1,
      origin: 'subagent',
      delegationDepth: 1,
    })
    const agent = sessionAgent(session)
    const childPrompt = createUserMessage({
      content: [{ type: 'text', text: '请记住：child 任务中的测试文本。' }],
      source: { kind: 'user', rpcId: 'rpc-shape-is-not-owner' } as ReturnType<typeof createUserMessage>['source'],
    })
    session.append('turn/start', { turn: 1 })

    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [childPrompt], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [childPrompt] }),
    )

    expect(decision).toEqual({ kind: 'enter', messages: [childPrompt] })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', childPrompt, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '中性 child 回复。' }],
        source: { provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    expect(extractionCalls).toBe(0)
    expect(ctx.mistymoonMemory.list({ context: PERSONAL_COMPANION_ACCESS })).toEqual([])
  })

  it('keeps the owner turn running while a v1 archive awaits explicit scope migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-migration-required-plugin-'))
    const path = join(root, 'memory.jsonl')
    await writeFile(path, `${JSON.stringify({
      schemaVersion: 1,
      id: 'legacy-memory-1',
      createdAt: '2026-08-18T00:00:00.000Z',
      content: '中性待迁移内容。',
      visibility: 'personal',
      sourceMessageId: 'legacy-source-1',
      status: 'confirmed',
    })}\n`, 'utf8')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, { path, recallLimit: 4 })
    const session = Session.create(SessionId('memory-migration-required-session'))
    const agent = sessionAgent(session)
    const ownerMessage = createUserMessage({
      content: [{ type: 'text', text: '请记住：这次请求不能阻断普通工作。' }],
      source: { kind: 'user', rpcId: 'rpc-migration-required' } as ReturnType<typeof createUserMessage>['source'],
    })
    session.append('turn/start', { turn: 1 })

    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [ownerMessage], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [ownerMessage] }),
    )

    expect(decision).toEqual({ kind: 'enter', messages: [ownerMessage] })
    expect(ctx.mistymoonMemory.inspection()).toMatchObject({ state: 'scope-migration-required' })
  })
})
