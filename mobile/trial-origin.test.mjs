import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assessTrialOrigin } from './trial-origin.mjs'

test('trial origin stays blocked without a real https host', () => {
  for (const raw of [
    '',
    '   ',
    'http://127.0.0.1:8787',
    'https://localhost',
    'https://example.com',
    'https://app.example.net',
    'https://placeholder.deepcompanion.app',
    'https://user:pass@chat.deepcompanion.app',
    'https://chat.deepcompanion.app/app',
    'https://chat.deepcompanion.app/?x=1',
    'not a url',
  ]) {
    const decision = assessTrialOrigin(raw)
    assert.equal(decision.ok, false, raw)
    assert.equal(decision.status, 'BLOCKED', raw)
  }
  const ready = assessTrialOrigin('https://chat.deepcompanion.app')
  assert.equal(ready.ok, true)
  assert.equal(ready.origin, 'https://chat.deepcompanion.app')
})

test('trial build command exits blocked when the origin is unset', () => {
  const result = spawnSync(process.execPath, ['mobile/trial-origin.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, COMPANION_PUBLIC_ORIGIN: '' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 2)
  assert.match(`${result.stderr}`, /BLOCKED/)
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /BEGIN CERTIFICATE|sk-/)
})
