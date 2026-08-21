/** Browser entry for the standalone dsh-Mmem Settings tab. */

import type { MemorySettingsRpcCallerV1 } from '@mistymoon/dsh-memory/settings-client'
import { DshMemorySettingsTab } from './MemorySettingsTab.js'
import {
  MemoryExplorerButton,
  MemoryExplorerController,
  MemoryExplorerOverlay,
} from './MemoryExplorer.js'
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
    inject(
      name: 'settings.plugins.tab' | 'sidebar.footer.action' | 'shell.overlay',
      register: () => unknown,
    ): void
    register(
      entry: {
        name: 'settings.plugins.tab' | 'sidebar.footer.action' | 'shell.overlay'
        id: string
        order?: number
        label?: () => string
        locale?: string
        inject?: () => Record<string, unknown>
      },
      component: unknown,
    ): unknown
  }
}

/** Browser services required to mount the Settings tab. */
export const inject = ['slots', 'locale', 'connection']

const NS = 'settings.dsh-mmem'
const STYLE_ID = '@mistymoon/dsh-memory-settings-ui'

const CSS = `
.dsh-mmem-settings{box-sizing:border-box;width:100%;max-width:980px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:18px;padding:4px 2px 32px}
.dsh-mmem-settings h2,.dsh-mmem-settings h3,.dsh-mmem-settings p{margin:0}.dsh-mmem-settings>p{color:var(--dsw-alias-label-tertiary);font-size:13px}
.dsh-mmem-settings>header{display:flex;flex-direction:column;gap:6px;padding:4px 0}.dsh-mmem-settings>header h2{font-size:22px}.dsh-mmem-settings>header p{max-width:720px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.dsh-mmem-settings form{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}.dsh-mmem-settings form strong{width:100%;font-size:15px}.dsh-mmem-settings form>label{min-width:180px;flex:1;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-secondary);font-size:13px}
.dsh-mmem-settings input,.dsh-mmem-settings select,.dsh-mmem-settings textarea{box-sizing:border-box;min-width:0;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;border-radius:9px;padding:9px 11px;outline:none}.dsh-mmem-settings input:focus,.dsh-mmem-settings select:focus,.dsh-mmem-settings textarea:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)}.dsh-mmem-settings textarea{width:100%;min-height:100px;resize:vertical}
.dsh-mmem-settings fieldset{min-width:0;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:14px;box-shadow:0 1px 2px #0000000a}
.dsh-mmem-settings legend{padding:0 8px;font-size:15px;font-weight:650}.dsh-mmem-settings article{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:11px;padding:14px;display:flex;flex-direction:column;gap:10px}.dsh-mmem-settings article small{color:var(--dsw-alias-label-tertiary)}.dsh-mmem-settings article>div{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px}
.dsh-mmem-settings button,.dsh-mmem-explorer button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;border-radius:9px;padding:8px 14px;cursor:pointer;transition:background .15s ease,border-color .15s ease,transform .15s ease}.dsh-mmem-settings button:hover,.dsh-mmem-explorer button:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-mmem-settings button:active,.dsh-mmem-explorer button:active{transform:translateY(1px)}.dsh-mmem-settings button:disabled,.dsh-mmem-explorer button:disabled{opacity:.45;cursor:not-allowed;transform:none}
.dsh-mmem-switch{min-width:unset!important;flex:0 auto!important;display:inline-flex!important;flex-direction:row!important;align-items:center;gap:8px!important;color:var(--dsw-alias-label-secondary);cursor:pointer}.dsh-mmem-switch input{appearance:none;width:38px;height:22px;border:0;padding:0;border-radius:999px;background:var(--dsw-alias-border-l3);position:relative;cursor:pointer;transition:background .18s ease}.dsh-mmem-switch input:before{content:"";width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0004;position:absolute;left:3px;top:3px;transition:transform .18s ease}.dsh-mmem-switch input:checked{background:var(--dsw-alias-state-business-primary)}.dsh-mmem-switch input:checked:before{transform:translateX(16px)}
.dsh-mmem-relationship-hint{flex:1 1 260px;line-height:1.5}
.dsh-mmem-explorer-trigger{box-sizing:border-box;width:100%;min-width:36px;height:36px;border:0;background:transparent;color:var(--dsw-alias-label-primary);border-radius:9px;display:flex;align-items:center;justify-content:center;gap:9px;padding:0 10px;cursor:pointer}.dsh-mmem-explorer-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-mmem-explorer-icon{font-size:21px;line-height:1}
.dsh-mmem-explorer-backdrop{position:absolute;inset:0;z-index:60;pointer-events:auto;background:#080b1088;backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:24px}
.dsh-mmem-explorer{box-sizing:border-box;width:min(1080px,96vw);height:min(760px,92vh);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:18px;box-shadow:0 24px 80px #0007;display:flex;flex-direction:column;overflow:hidden}.dsh-mmem-explorer>header{flex:none;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:20px 24px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-mmem-explorer>header h2{margin:0;font-size:22px}.dsh-mmem-explorer>header small{color:var(--dsw-alias-label-tertiary)}.dsh-mmem-explorer>header>button{width:36px;height:36px;padding:0;font-size:24px;border:0;background:transparent}
.dsh-mmem-explorer-toolbar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 24px}.dsh-mmem-explorer-toolbar>input{box-sizing:border-box;min-width:220px;max-width:520px;flex:1;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:10px;padding:10px 12px;font:inherit}.dsh-mmem-segmented{display:flex;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:3px}.dsh-mmem-segmented button{border:0;background:transparent;padding:7px 16px}.dsh-mmem-segmented button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 4px #0002}
.dsh-mmem-directory{min-height:0;flex:1;overflow:auto;padding:2px 24px 24px;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));align-content:start;gap:14px}.dsh-mmem-directory-group{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:13px;padding:14px;display:flex;flex-direction:column;gap:10px}.dsh-mmem-directory-group h3{margin:0;display:flex;justify-content:space-between;font-size:15px}.dsh-mmem-directory-group h3 span{color:var(--dsw-alias-label-tertiary);font-weight:400}.dsh-mmem-directory-group article{background:var(--dsw-alias-bg-layer-1);border-radius:9px;padding:12px}.dsh-mmem-directory-group p{margin:0 0 7px;line-height:1.55}.dsh-mmem-directory-group small{color:var(--dsw-alias-label-tertiary)}
.dsh-mmem-graph-wrap{min-height:0;flex:1;overflow:auto;padding:0 24px 24px;display:flex;flex-direction:column}.dsh-mmem-range{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary);font-size:13px}.dsh-mmem-range input{accent-color:var(--dsw-alias-state-business-primary)}.dsh-mmem-graph{width:100%;min-height:430px;flex:1;border:1px solid var(--dsw-alias-border-l2);background:radial-gradient(circle at center,var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-3));border-radius:14px}.dsh-mmem-graph line{stroke:var(--dsw-alias-label-tertiary);stroke-width:2}.dsh-mmem-graph .relation-contradicts{stroke:#df5b5b;stroke-dasharray:7 5}.dsh-mmem-graph .relation-elaborates{stroke:var(--dsw-alias-state-business-primary)}.dsh-mmem-graph circle{fill:var(--dsw-alias-button-elevated-fill);stroke:var(--dsw-alias-state-business-primary);stroke-width:2}.dsh-mmem-graph text{fill:var(--dsw-alias-label-secondary);font-size:11px}.dsh-mmem-graph-legend{display:flex;flex-wrap:wrap;gap:14px;margin:10px 0 0;padding:0;list-style:none;color:var(--dsw-alias-label-secondary);font-size:13px}.dsh-mmem-empty{margin:auto;padding:32px;text-align:center;color:var(--dsw-alias-label-secondary)}
@media(max-width:760px){.dsh-mmem-settings{padding-bottom:20px}.dsh-mmem-settings form{align-items:stretch;flex-direction:column}.dsh-mmem-settings form>label{width:100%;min-width:0}.dsh-mmem-explorer-backdrop{padding:0}.dsh-mmem-explorer{width:100vw;height:100vh;border-radius:0}.dsh-mmem-explorer-toolbar{align-items:stretch;flex-direction:column}.dsh-mmem-explorer-toolbar>input{width:100%;max-width:none}.dsh-mmem-segmented button{flex:1}.dsh-mmem-directory{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){.dsh-mmem-settings button,.dsh-mmem-explorer button,.dsh-mmem-switch input,.dsh-mmem-switch input:before{transition:none}}
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
  const explorer = new MemoryExplorerController()
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'dsh-mmem',
    order: 6,
    label: () => t('tab'),
    locale: NS,
    inject: () => ({ rpc: connection.rpc }),
  }, DshMemorySettingsTab))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-mmem-explorer-trigger',
    order: 6,
    inject: () => ({ controller: explorer, t }),
  }, MemoryExplorerButton))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-mmem-explorer-overlay',
    order: 6,
    inject: () => ({ controller: explorer, rpc: connection.rpc, t }),
  }, MemoryExplorerOverlay))
}

export type { DshMemorySettingsTabProps } from './MemorySettingsTab.js'
export type { MemorySettingsLocaleKey } from './locales.js'
