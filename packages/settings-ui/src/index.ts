/** Host marker for the independently bundled dsh-Mmem Settings UI. */

/** Cordis plugin name used to discover the matching browser entry. */
export const name = 'dsh-mmem-settings-ui'

/** The Host marker owns no data or transport; the Memory Settings Host owns RPC. */
export const inject: never[] = []

/** Register no Host behavior; loading this package makes its `/client` face available to DSH Web. */
export function apply(): void {}
