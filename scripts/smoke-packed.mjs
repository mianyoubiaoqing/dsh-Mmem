import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const packageRoot = join(root, 'packages', 'bundle')
const expectedName = '@mistymoon/dsh-mmem'
const outputIndex = process.argv.indexOf('--output')
const requestedOutput = outputIndex === -1 ? undefined : process.argv[outputIndex + 1]
if (outputIndex !== -1 && (requestedOutput === undefined || requestedOutput.startsWith('--'))) {
  fail('--output requires a repository-relative directory')
}
const forbiddenSegments = new Set([
  '.env',
  '.git',
  'coverage',
  'data',
  'docs',
  'private',
  'tests',
])

function fail(message) {
  throw new Error(`packed publication smoke: ${message}`)
}

function runNpm(args, options) {
  if (process.platform === 'win32') {
    return execFileSync(
      process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'npm', ...args],
      options,
    )
  }
  return execFileSync('npm', args, options)
}

function assertManifest(manifest) {
  if (manifest.name !== expectedName) fail(`expected package name ${expectedName}`)
  if (manifest.private === true) fail('public bundle must not be private')
  if (manifest.publishConfig?.access !== 'public') fail('scoped package must publish with public access')
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    fail('DSH bundle manifest must point to cordis.patch.yml')
  }
  const dependencySpecs = Object.values({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  })
  if (dependencySpecs.some(spec => typeof spec === 'string' && spec.startsWith('workspace:'))) {
    fail('published dependency graph must not contain workspace protocols')
  }
}

function assertPackedFiles(files) {
  const paths = new Set(files.map(file => file.path.replaceAll('\\', '/')))
  const allowedFiles = new Set(['LICENSE', 'README.md', 'cordis.patch.yml', 'package.json'])
  const allowedTrees = ['lib/memory/', 'lib/settings-ui/']
  for (const required of [
    'LICENSE',
    'README.md',
    'cordis.patch.yml',
    'lib/memory/index.js',
    'lib/memory/approval-schedule.js',
    'lib/memory/approval-scheduler.js',
    'lib/memory/principal.js',
    'lib/memory/principal-local.js',
    'lib/memory/settings-host.js',
    'lib/memory/settings-client.js',
    'lib/settings-ui/index.js',
    'lib/settings-ui/client.js',
    'package.json',
  ]) {
    if (!paths.has(required)) fail(`tarball is missing ${required}`)
  }
  for (const path of paths) {
    if (!allowedFiles.has(path) && !allowedTrees.some(prefix => path.startsWith(prefix))) {
      fail(`tarball contains unexpected publication path ${path}`)
    }
    const segments = path.toLowerCase().split('/')
    if (segments.some(segment => forbiddenSegments.has(segment))) {
      fail(`tarball contains forbidden path ${path}`)
    }
    if (/\.(?:jsonl|log|sqlite3?|tgz)$/iu.test(path)) {
      fail(`tarball contains private or generated artifact ${path}`)
    }
  }
}

async function installedFiles(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await installedFiles(path))
    else result.push(path)
  }
  return result
}

const temp = await mkdtemp(join(tmpdir(), 'dsh-mmem-pack-'))
try {
  const packDestination = requestedOutput === undefined ? temp : resolve(root, requestedOutput)
  if (requestedOutput !== undefined) {
    const relativeOutput = relative(root, packDestination)
    if (relativeOutput.startsWith('..') || isAbsolute(relativeOutput)) {
      fail('artifact output must stay inside the repository')
    }
  }
  await mkdir(packDestination, { recursive: true })

  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assertManifest(manifest)

  const packOutput = runNpm(
    ['pack', '--json', '--pack-destination', packDestination],
    { cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const packed = JSON.parse(packOutput)
  if (!Array.isArray(packed) || packed.length !== 1) fail('npm pack did not produce exactly one tarball')
  assertPackedFiles(packed[0].files)

  await writeFile(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  const tarball = join(packDestination, packed[0].filename)
  runNpm(
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      tarball,
      '@deepseek-ai/cordis@4.0.1',
      '@deepseek-ai/dsh-agent@0.1.0-rc.8',
      '@deepseek-ai/dsh-llm@0.1.0-rc.8',
      '@deepseek-ai/dsh-session@0.1.0-rc.8',
      '@deepseek-ai/dsh-tools@0.1.0-rc.8',
      'react@18.3.1',
    ],
    { cwd: temp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  )

  const installedPackage = join(temp, 'node_modules', '@mistymoon', 'dsh-mmem')
  const files = await installedFiles(installedPackage)
  if (files.some(path => path.split(sep).some(segment => forbiddenSegments.has(segment.toLowerCase())))) {
    fail('clean install contains a forbidden private path')
  }
  const client = await readFile(join(installedPackage, 'lib', 'settings-ui', 'client.js'), 'utf8')
  if (!client.includes('id: "@mistymoon/dsh-mmem/settings-ui"')) {
    fail('browser bundle does not register the public package subpath')
  }

  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `for (const specifier of [
        '${expectedName}',
        '${expectedName}/approval-schedule',
        '${expectedName}/approval-scheduler',
        '${expectedName}/principal',
        '${expectedName}/principal-local',
        '${expectedName}/settings-host',
        '${expectedName}/settings-client',
        '${expectedName}/settings-ui',
        '${expectedName}/settings-ui/client',
      ]) import.meta.resolve(specifier);
      const [schedule, principal, client, ui] = await Promise.all([
        import('${expectedName}/approval-schedule'),
        import('${expectedName}/principal-local'),
        import('${expectedName}/settings-client'),
        import('${expectedName}/settings-ui'),
      ]);
      if (typeof schedule.calculateMemoryApprovalScheduleV1 !== 'function') throw new Error('invalid approval schedule entry');
      if (principal.name !== 'dsh-mmem-principal-local') throw new Error('invalid principal Adapter entry');
      if (typeof client.createMemorySettingsClient !== 'function') throw new Error('invalid Settings client entry');
      if (ui.name !== 'dsh-mmem-settings-ui') throw new Error('invalid Settings UI entry');`,
    ],
    { cwd: temp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  )

  console.log(`dsh-Mmem packed publication smoke passed (${packed[0].filename})`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
