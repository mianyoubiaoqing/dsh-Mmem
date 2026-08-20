const [identity, memory] = await Promise.all([
  import('../packages/identity/lib/index.js'),
  import('../packages/memory/lib/index.js'),
])

if (identity.name !== 'mistymoon-identity') {
  throw new Error(`unexpected identity plugin name: ${String(identity.name)}`)
}
if (memory.name !== 'mistymoon-memory') {
  throw new Error(`unexpected memory plugin name: ${String(memory.name)}`)
}

console.log('dsh-Mmem built plugin smoke passed')
