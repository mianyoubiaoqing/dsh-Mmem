const [identity, memory, settingsHost, settingsClient] = await Promise.all([
  import('../packages/identity/lib/index.js'),
  import('../packages/memory/lib/index.js'),
  import('../packages/memory/lib/settings-host.js'),
  import('../packages/memory/lib/settings-client.js'),
])

if (identity.name !== 'mistymoon-identity') {
  throw new Error(`unexpected identity plugin name: ${String(identity.name)}`)
}
if (memory.name !== 'mistymoon-memory') {
  throw new Error(`unexpected memory plugin name: ${String(memory.name)}`)
}
if (typeof memory.openMemorySpaceCatalog !== 'function') {
  throw new Error('built memory plugin is missing openMemorySpaceCatalog')
}
if (typeof memory.openMemorySpaceArchiveRouter !== 'function') {
  throw new Error('built memory plugin is missing openMemorySpaceArchiveRouter')
}
if (settingsHost.name !== 'dsh-mmem-settings-host') {
  throw new Error(`unexpected Memory Settings Host plugin name: ${String(settingsHost.name)}`)
}
if (typeof settingsClient.createMemorySettingsClient !== 'function') {
  throw new Error('built Memory package is missing createMemorySettingsClient')
}

console.log('dsh-Mmem built plugin smoke passed')
