import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as PrincipalLocalPlugin from '../src/principal-local.js'
import { describe, expect, it } from 'vitest'
import * as MemoryPlugin from '../src/index.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

const signal = new AbortController().signal
const DENIED_TOOL_CASES = [
  ['memory_candidate_propose', { content: 'Child output must not become Owner memory.', visibility: 'personal' }],
  ['memory_candidate_list', {}],
  ['memory_candidate_approve', { candidateId: 'candidate-fixture' }],
  ['memory_candidate_reject', { candidateId: 'candidate-fixture' }],
  ['memory_list', {}],
  ['memory_forget', { memoryId: 'memory-fixture' }],
  ['memory_replace', { memoryId: 'memory-fixture', content: 'Replacement fixture.' }],
  ['memory_turn_expand', { candidateId: 'candidate-fixture' }],
] as const

async function execute(
  ctx: Context,
  name: string,
  args: unknown,
  callId: string,
  agent?: Agent,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ signal, callId: CallId(callId), name, arguments: args, agent })
}

function toolAgent(ctx: Context, idText: string, delegationDepth?: number, cwd?: string): Agent {
  const id = SessionId(idText)
  const session = Session.create(id, [], {
    version: 0,
    id,
    createdAt: 1,
    ...(cwd === undefined ? {} : { cwd }),
    ...(delegationDepth === undefined ? {} : { origin: 'subagent' as const, delegationDepth }),
  })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Owner governance request.' }],
    source: { kind: 'user', rpcId: `rpc-${idText}` } as ReturnType<typeof createUserMessage>['source'],
  }), { surfaceOp: 'append' })
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    status: 'running',
    ctx,
    send() {},
    followup() {},
    steer() {},
    inject() {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function value(result: ToolExecutionResult): unknown {
  if (result.isError) throw new Error(`expected successful memory tool result: ${JSON.stringify(result.content)}`)
  expect(result.isError).toBe(false)
  return result.value
}

describe('MistyMoon memory tools', () => {
  it('expands Turn Evidence only after its Candidate was recalled in the current Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-turn-expand-tool-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PrincipalLocalPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, { path: join(root, 'memories.jsonl'), recallLimit: 4 })
    const candidate = await ctx.mistymoonMemory.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'dsh-turn:expand-tool-source:1',
      content: '本轮摘要（未审核）：讨论蓝绿部署与回滚检查。',
      visibility: 'personal',
      memoryKind: 'summary',
      turnEvidence: {
        schemaVersion: 1,
        sessionId: 'expand-tool-source',
        turn: 1,
        userMessages: [{ messageId: 'expand-user', text: '讨论蓝绿部署。' }],
        assistantMessage: { messageId: 'expand-assistant', text: '需要检查回滚路径。' },
      },
    })
    const agent = toolAgent(ctx, 'expand-tool-reader')
    const query = createUserMessage({
      content: [{ type: 'text', text: '蓝绿部署的回滚检查是什么？' }],
      source: { kind: 'user', rpcId: 'rpc-expand-query' } as ReturnType<typeof createUserMessage>['source'],
    })
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [query], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [query] }),
    )
    if (decision.kind !== 'enter') throw new Error('expected provisional recall')

    expect(value(await execute(ctx, 'memory_turn_expand', {
      candidateId: candidate.id,
      cursor: 0,
    }, 'call-turn-expand', agent))).toMatchObject({
      evidence: {
        candidateId: candidate.id,
        cursor: 0,
        content: expect.stringContaining('需要检查回滚路径'),
      },
    })
  })

  it('lists memory from the Active Space of the tool Agent DSH Workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-space-tool-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
  await ctx.plugin(PrincipalLocalPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, {
      spaceCatalogPath: join(root, 'catalog.json'),
      spacesRoot: join(root, 'spaces'),
      recallLimit: 4,
    })
    const cwd = 'D:\\workspaces\\project-alpha'
    const space = await ctx.dshMmemSpaceCatalog.createSpace({
      ownerId: 'owner-fixture',
      name: 'Project Alpha',
    })
    await ctx.dshMmemSpaceCatalog.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader: { cwd },
      spaceId: space.id,
      access: 'read-write',
      defaultWrite: true,
    })
    const routed = await ctx.dshMmemSpaceRouter.resolveSession({
      ownerId: 'owner-fixture',
      sessionHeader: { cwd },
    })
    if (routed.kind !== 'active') throw new Error('expected an Active Space')
    await routed.observeExplicit({
      context: PERSONAL_COMPANION_ACCESS,
      memoryKind: 'summary',
      sourceMessageId: 'message-space-tool-1',
      text: '请记住：Project Alpha 使用蓝绿部署。',
    })

    const agent = toolAgent(ctx, 'space-tool-agent', undefined, cwd)
    const listed = value(await execute(ctx, 'memory_list', { query: '蓝绿部署' }, 'call-space-list', agent))
    expect(listed).toEqual({
      memories: [expect.objectContaining({ content: 'Project Alpha 使用蓝绿部署。' })],
    })
  })

  it.each(DENIED_TOOL_CASES)('denies depth-one child access to %s without changing the archive', async (toolName, args) => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-child-tool-'))
    const path = join(root, 'memories.jsonl')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PrincipalLocalPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, { path, recallLimit: 4 })
    const child = toolAgent(ctx, 'memory-child-tool-agent', 1)

    const result = await execute(ctx, toolName, args, `child-${toolName}`, child)

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('authenticated Owner request')
    expect(ctx.mistymoonMemory.list({ context: PERSONAL_COMPANION_ACCESS })).toEqual([])
    expect(ctx.mistymoonMemory.listCandidates({ context: PERSONAL_COMPANION_ACCESS })).toEqual([])
  })

  it('lets the owner list, replace, and forget memories through DSH tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-tools-'))
    const path = join(root, 'memories.jsonl')
    const ids = ['observation-1', 'memory-1']
    const archive = await MemoryPlugin.openMemoryArchive({ path, createId: () => ids.shift() ?? 'unexpected-id' })
    await archive.observeExplicit({
      context: PERSONAL_COMPANION_ACCESS,
      memoryKind: 'preference',
      sourceMessageId: 'message-1',
      text: '请记住：我喜欢红茶。',
    })
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PrincipalLocalPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, { path, recallLimit: 4 })
    const agent = toolAgent(ctx, 'memory-owner-tools-agent')

    const listed = value(await execute(ctx, 'memory_list', { query: '红茶' }, 'call-list', agent))
    expect(listed).toEqual({
      memories: [expect.objectContaining({ id: 'memory-1', content: '我喜欢红茶。', status: 'confirmed' })],
    })

    const replaced = value(await execute(ctx, 'memory_replace', {
      memoryId: 'memory-1',
      content: '我现在更喜欢凤凰单丛。',
    }, 'call-replace', agent)) as { memory: { id: string } }
    expect(replaced).toEqual({
      memory: expect.objectContaining({ content: '我现在更喜欢凤凰单丛。', status: 'confirmed' }),
    })

    const forgotten = value(await execute(ctx, 'memory_forget', {
      memoryId: replaced.memory.id,
    }, 'call-forget', agent))
    expect(forgotten).toEqual({
      memory: expect.objectContaining({ id: replaced.memory.id, status: 'forgotten' }),
    })

    expect(value(await execute(ctx, 'memory_list', {}, 'call-list-final', agent))).toEqual({ memories: [] })
  })

  it('requires an explicit owner review before a proposed memory becomes active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-review-tools-'))
    const path = join(root, 'memories.jsonl')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PrincipalLocalPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, { path, recallLimit: 4 })
    const agent = toolAgent(ctx, 'memory-owner-review-agent')

    const proposed = value(await execute(ctx, 'memory_candidate_propose', {
      content: '主人通常在周末整理书桌。',
      visibility: 'personal',
    }, 'call-propose', agent)) as { candidate: { id: string } }
    expect(proposed).toEqual({
      candidate: expect.objectContaining({ content: '主人通常在周末整理书桌。', status: 'pending' }),
    })
    expect(value(await execute(ctx, 'memory_candidate_list', {}, 'call-candidate-list', agent))).toEqual({
      candidates: [expect.objectContaining({ id: proposed.candidate.id, status: 'pending' })],
    })
    expect(value(await execute(ctx, 'memory_list', { query: '周末' }, 'call-memory-list', agent))).toEqual({ memories: [] })

    const approved = value(await execute(ctx, 'memory_candidate_approve', {
      candidateId: proposed.candidate.id,
    }, 'call-approve', agent))
    expect(approved).toEqual({
      memory: expect.objectContaining({ content: '主人通常在周末整理书桌。', status: 'confirmed' }),
    })
    expect(value(await execute(ctx, 'memory_candidate_list', {}, 'call-candidate-list-final', agent))).toEqual({ candidates: [] })
    expect(value(await execute(ctx, 'memory_list', { query: '周末' }, 'call-memory-list-final', agent))).toEqual({
      memories: [expect.objectContaining({ content: '主人通常在周末整理书桌。' })],
    })
  })
})
