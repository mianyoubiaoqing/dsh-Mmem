/** Browser entry for the standalone dsh-Mmem Settings tab. */

import type { MemorySettingsRpcCallerV1 } from '@mistymoon/dsh-memory/settings-client'
import { DshMemorySettingsTab } from './MemorySettingsTab.js'
import { en, zh, type MemorySettingsLocaleKey } from './locales.js'

interface DshMemoryClientContextV1 {
  effect(register: () => void | (() => void), label: string): void
  get(name: 'connection'): { readonly rpc: MemorySettingsRpcCallerV1 }
  locale: {
    register(
      namespace: string,
      dictionaries: { zh: Record<MemorySettingsLocaleKey, string>; en: Record<MemorySettingsLocaleKey, string> },
    ): () => void
    bind(namespace: string): (key: MemorySettingsLocaleKey) => string
  }
  slots: {
    inject(name: 'settings.plugins.tab', register: () => unknown): void
    register(
      entry: {
        name: 'settings.plugins.tab'
        id: string
        order: number
        label: () => string
        locale: string
        inject: () => { rpc: MemorySettingsRpcCallerV1 }
      },
      component: typeof DshMemorySettingsTab,
    ): unknown
  }
}

/** Browser services required to mount the Settings tab. */
export const inject = ['slots', 'locale', 'connection']

const NS = 'settings.dsh-mmem'
const STYLE_ID = '@mistymoon/dsh-memory-settings-ui'

const CSS = `
.dsh-mmem-settings{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}
.dsh-mmem-settings h3,.dsh-mmem-settings p{margin:0}.dsh-mmem-settings>p{color:var(--dsw-alias-label-tertiary);font-size:13px}
.dsh-mmem-settings form{display:grid;grid-template-columns:minmax(180px,1fr) repeat(3,minmax(120px,auto)) auto;gap:8px;align-items:center}.dsh-mmem-settings form strong{grid-column:1/-1;font-size:14px}.dsh-mmem-settings input,.dsh-mmem-settings select{min-width:0;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;border-radius:7px;padding:7px 9px}
.dsh-mmem-settings fieldset{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}
.dsh-mmem-settings legend{padding:0 6px;font-size:14px;font-weight:600}.dsh-mmem-settings article{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px}
.dsh-mmem-settings article small{color:var(--dsw-alias-label-tertiary)}.dsh-mmem-settings article div{display:flex;justify-content:flex-end;gap:8px}
.dsh-mmem-settings button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;border-radius:7px;padding:6px 12px;cursor:pointer}.dsh-mmem-settings button:disabled{opacity:.5;cursor:not-allowed}
@media(max-width:760px){.dsh-mmem-settings form{grid-template-columns:1fr}.dsh-mmem-settings form strong{grid-column:auto}}
`

/** Register the standalone Memory page in DSH's Plugins settings section. */
export function apply(ctx: DshMemoryClientContextV1): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mmem-settings-ui: dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.pluginCss = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dsh-mmem-settings-ui: styles')

  const connection = ctx.get('connection')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'dsh-mmem',
    order: 6,
    label: () => t('tab'),
    locale: NS,
    inject: () => ({ rpc: connection.rpc }),
  }, DshMemorySettingsTab))
}

export type { DshMemorySettingsTabProps } from './MemorySettingsTab.js'
export type { MemorySettingsLocaleKey } from './locales.js'
