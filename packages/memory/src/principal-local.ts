import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalDshMemoryPrincipalResolver } from './principal.js'

/** Cordis plugin name for the bundled local DSH Memory principal Adapter. */
export const name = 'dsh-mmem-principal-local'

/** The local principal Adapter consumes only immutable DSH Agent/message inputs at call time. */
export const inject: never[] = []

/** Local single-Owner principal Adapter configuration. */
export interface Config {
  ownerId: string
}

/** Runtime schema for the local Memory principal Adapter. */
export const Config: z<Config> = z.object({
  ownerId: z.string().required(),
})

/** Provide the Memory-owned local DSH principal resolver. */
export function apply(ctx: Context, config: Config): void {
  const resolver = new LocalDshMemoryPrincipalResolver(config)
  ctx.effect(
    () => ctx.provide('dshMmemPrincipalResolver', resolver),
    'dsh-mmem: local DSH principal resolver',
  )
}
