import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseAppOrigin } from './www/origin-policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const casesPath = path.join(root, 'mobile/origin-cases.tsv')

function cases() {
  return readFileSync(casesPath, 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [debug, raw, ok, origin, reason] = line.split('\t')
      return { debug: debug === 'true', raw, ok: ok === 'true', origin, reason }
    })
}

test('app origin policy matches the shared cases', () => {
  const rows = cases()
  assert.ok(rows.length >= 20)
  for (const row of rows) {
    const decision = parseAppOrigin(row.raw, row.debug)
    assert.equal(decision.ok, row.ok, JSON.stringify(row))
    assert.equal(decision.ok ? decision.origin : '', row.origin, JSON.stringify(row))
    assert.equal(decision.ok ? '' : decision.reason, row.reason, JSON.stringify(row))
  }
})

test('java origin policy matches the same cases', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'origin-policy-'))
  const sources = [
    path.join(root, 'mobile/java/app/deepcompanion/shell/OriginPolicy.java'),
    path.join(root, 'mobile/javatest/app/deepcompanion/shell/OriginPolicyTest.java'),
  ]
  const compiled = spawnSync('javac', ['-d', out, ...sources], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  const ran = spawnSync('java', ['-cp', out, 'app.deepcompanion.shell.OriginPolicyTest', casesPath], { encoding: 'utf8' })
  assert.equal(ran.status, 0, ran.stderr || ran.stdout)
})

test('debug cleartext stays off the release manifest and the shell has no baked endpoint', () => {
  const manifest = readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8')
  const debugXml = readFileSync(path.join(root, 'android/app/src/debug/res/xml/network_security_config.xml'), 'utf8')
  const config = readFileSync(path.join(root, 'capacitor.config.ts'), 'utf8')
  const shell = readFileSync(path.join(root, 'mobile/www/setup.js'), 'utf8')
  const ios = readFileSync(path.join(root, 'ios/App/App/Info.plist'), 'utf8')
  assert.match(manifest, /android:usesCleartextTraffic="false"/)
  assert.equal(manifest.includes('networkSecurityConfig'), false)
  assert.equal(manifest.includes('allowBackup="true"'), false)
  assert.match(debugXml, /base-config cleartextTrafficPermitted="false"/)
  assert.match(debugXml, /<certificates src="system" \/>/)
  assert.equal(debugXml.includes('src="user"'), false)
  for (const host of ['127.0.0.1', 'localhost', '10.0.2.2']) assert.match(debugXml, new RegExp(host.replaceAll('.', '\\.')))
  assert.equal(existsSync(path.join(root, 'android/app/src/release/res/xml/network_security_config.xml')), false)
  assert.equal(config.includes('server.url'), false)
  assert.equal(config.includes('allowMixedContent: true'), false)
  assert.equal(shell.includes('localStorage'), false)
  assert.equal(ios.includes('NSAllowsArbitraryLoads'), false)
  const activity = readFileSync(path.join(root, 'android/app/src/main/java/app/deepcompanion/shell/MainActivity.java'), 'utf8')
  assert.equal(activity.includes('DEEPSEEK_API_KEY'), false)
  assert.equal(activity.includes('TrustManager'), false)
  assert.equal(activity.includes('https://'), false)
})
