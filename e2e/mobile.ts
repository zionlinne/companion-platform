import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createInvitations, initAdmin } from '../server/src/auth.ts'
import { loadConfig } from '../server/src/config.ts'
import { migrate, openDatabase } from '../server/src/db.ts'
import { startFixture } from '../server/src/fixture-provider.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-mobile-'))
const databasePath = path.join(dir, 'app.sqlite')
const dataDir = path.join(dir, 'data')
const shotDir = path.join(root, 'docs/evidence/mobile')
const artifactDir = '/opt/cursor/artifacts'
fs.mkdirSync(shotDir, { recursive: true })
fs.mkdirSync(artifactDir, { recursive: true })
const fixture = await startFixture()
const config = loadConfig(
  { NODE_ENV: 'test', DATABASE_URL: '' },
  {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    databasePath,
    databaseUrl: null,
    dataDir,
    staticDir: path.join(root, 'web/dist'),
    gatewayMode: 'fixture',
    allowGatewayFixture: true,
    fixtureBaseUrl: fixture.url,
    deepseekApiKey: 'sk-test-should-not-leak-9f3a',
    initiativePollMs: 0,
  }
)
const db = openDatabase(config)
await migrate(db)
const admin = await initAdmin(db, config, 'admin@example.com', 'AdminPassw0rd!123')
const invites = await createInvitations(db, admin.id, 2, 1, 'mobile')
await db.close()

const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '0',
    DATABASE_URL: '',
    DATABASE_PATH: databasePath,
    DATA_DIR: dataDir,
    STATIC_DIR: path.join(root, 'web/dist'),
    MODEL_GATEWAY_MODE: 'fixture',
    ALLOW_GATEWAY_FIXTURE: '1',
    FIXTURE_BASE_URL: fixture.url,
    DEEPSEEK_API_KEY: 'sk-test-should-not-leak-9f3a',
    INITIATIVE_POLL_MS: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const baseUrl = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not listen')), 15000)
  let buffer = ''
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString()
    const match = /"port":([1-9]\d*)/.exec(buffer)
    if (match) {
      clearTimeout(timer)
      resolve(`http://127.0.0.1:${match[1]}`)
    }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.on('exit', (code) => reject(new Error(`server exited ${code}: ${buffer}`)))
})

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const shot = async (name: string) => {
    const file = path.join(shotDir, `${name}.png`)
    await page.screenshot({ path: file, fullPage: true })
    fs.copyFileSync(file, path.join(artifactDir, `${name}.png`))
  }
  await page.goto(`${baseUrl}/login`)
  await page.getByTestId('first-run').waitFor()
  const guide = await page.getByTestId('first-run').innerText()
  const registration = await page.getByTestId('registration-state').innerText()
  if (!registration.includes('没有邀请码')) throw new Error(`registration copy missing invite requirement: ${registration}`)
  if (!guide.includes('邀请码') || !guide.includes('Workspace') || !guide.includes('没有供应商 Key')) {
    throw new Error(`first-run guide missing product steps: ${guide}`)
  }
  if (await page.locator('input[name="origin"], input[name="apiKey"], input[placeholder*="Key"]').count() !== 0) {
    throw new Error('ordinary login shows an origin or provider key field')
  }
  await shot('mobile-login')
  await page.getByTestId('email').fill('owner@example.com')
  await page.getByTestId('password').fill('UserPassw0rd!123')
  await page.context().setOffline(true)
  await page.getByRole('button', { name: '登录' }).click()
  await page.getByTestId('auth-error').waitFor()
  const offline = await page.getByTestId('auth-error').innerText()
  if (!offline.includes('连不上服务')) throw new Error(`offline copy missing: ${offline}`)
  await shot('mobile-offline')
  await page.context().setOffline(false)
  await page.goto(`${baseUrl}/register`)
  await page.getByTestId('email').fill('owner@example.com')
  await page.getByTestId('password').fill('UserPassw0rd!123')
  await page.getByTestId('invitation').fill(invites[0].code)
  await page.getByRole('button', { name: '注册' }).click()
  await page.getByTestId('workspace-entry').waitFor()
  await page.getByTestId('companion-entry').waitFor()
  if (await page.getByRole('link', { name: '管理' }).count() !== 0) throw new Error('ordinary user sees admin navigation')
  await shot('mobile-home')
  await page.getByTestId('workspace-entry').click()
  await page.getByTestId('empty-workspace').waitFor()
  await shot('mobile-workspace')
  await page.getByRole('link', { name: '陪伴' }).click()
  await page.getByTestId('empty-companions').waitFor()
  await page.getByRole('link', { name: '新建角色' }).click()
  await page.getByTestId('template-daily-companion').click()
  await page.getByTestId('character-name').fill('手机人格甲')
  await page.getByRole('button', { name: '保存人格' }).click()
  await page.getByTestId('export-character').waitFor()
  await shot('mobile-persona')
  await page.goto(`${baseUrl}/companion`)
  await page.getByRole('button', { name: '新对话' }).click()
  await page.getByTestId('gateway-banner').waitFor()
  const banner = await page.getByTestId('gateway-banner').innerText()
  if (!banner.includes('不是 DeepSeek')) throw new Error(`fixture was presented as a real model: ${banner}`)
  await page.getByTestId('empty-chat').waitFor()
  if (await page.getByTestId('attachment-file').count() !== 1) throw new Error('local sqlite build hid a working attachment control')
  await page.getByTestId('composer').fill('手机持久')
  await page.getByTestId('send').click()
  await page.getByText('fixture-reply:手机持久').waitFor({ timeout: 15000 })
  await shot('mobile-chat')
  await page.reload()
  await page.getByText('fixture-reply:手机持久').waitFor()
  await page.getByRole('link', { name: '记忆' }).click()
  await page.getByTestId('memory-content').fill('手机记忆甲')
  await page.getByTestId('memory-source').fill('手机')
  await page.getByRole('button', { name: '保存记忆' }).click()
  const memory = page.getByTestId('memory-item').filter({ hasText: '手机记忆甲' })
  await memory.waitFor()
  await shot('mobile-memory')
  await memory.getByRole('button', { name: '删除' }).click()
  await memory.waitFor({ state: 'detached' })
  const memoryPackage = JSON.stringify({
    kind: 'companion-platform-memory-package',
    version: 1,
    memories: [{ category: 'event', content: '手机导入乙', source: '旧日记', explicit: false, note: '待确认', createdAt: '2024-05-01T00:00:00.000Z', updatedAt: '2024-05-02T00:00:00.000Z' }],
  })
  await page.getByTestId('memory-import-text').fill(memoryPackage)
  await page.getByTestId('memory-import-preview').click()
  await page.getByTestId('import-item').waitFor()
  if (await page.getByTestId('memory-item').filter({ hasText: '手机导入乙' }).count() !== 0) {
    throw new Error('import preview wrote the memory before confirmation')
  }
  await shot('mobile-memory-preview')
  await page.getByTestId('memory-import-commit').click()
  await page.getByTestId('memory-item').filter({ hasText: '手机导入乙' }).waitFor()
  await page.goto(`${baseUrl}/settings`)
  const limit = await page.getByTestId('scheduler-limit').innerText()
  if (!limit.includes('休眠') || !limit.includes('没有放宽')) throw new Error(`scheduler copy missing: ${limit}`)
  await page.getByRole('button', { name: '退出' }).click()
  await page.getByRole('link', { name: '使用邀请码注册' }).click()
  await page.getByTestId('email').fill('other@example.com')
  await page.getByTestId('password').fill('UserPassw0rd!123')
  await page.getByTestId('invitation').fill(invites[1].code)
  await page.getByRole('button', { name: '注册' }).click()
  await page.getByTestId('companion-entry').click()
  await page.getByTestId('empty-companions').waitFor()
  if (await page.getByText('手机人格甲').count() !== 0) throw new Error('second account can see the first persona')
  if (await page.getByText('手机导入乙').count() !== 0) throw new Error('second account can see the first memory')
  await shot('mobile-isolation')
  const stored = await page.evaluate(() => JSON.stringify(localStorage))
  if (stored.includes('sk-test') || stored.includes('apiKey')) throw new Error(`localStorage leaked provider state: ${stored}`)
  console.log('mobile e2e ok')
} finally {
  await browser.close()
  child.kill('SIGTERM')
  await fixture.close()
  fs.rmSync(dir, { recursive: true, force: true })
}
