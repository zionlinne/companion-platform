import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { initAdmin } from '../server/src/auth.ts'
import { loadConfig } from '../server/src/config.ts'
import { migrate, openDatabase } from '../server/src/db.ts'
import { startFixture } from '../server/src/fixture-provider.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-e2e-'))
const databasePath = path.join(dir, 'app.sqlite')
const dataDir = path.join(dir, 'data')
const fixture = await startFixture()
const config = loadConfig(
  { NODE_ENV: 'test' },
  {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    databasePath,
    dataDir,
    staticDir: path.join(root, 'web/dist'),
    gatewayMode: 'fixture',
    allowGatewayFixture: true,
    fixtureBaseUrl: fixture.url,
    deepseekApiKey: 'sk-test-should-not-leak-9f3a',
    allowTestClock: true,
    initiativePollMs: 0,
  }
)
const db = openDatabase(databasePath)
migrate(db)
await initAdmin(db, config, 'admin@example.com', 'AdminPassw0rd!123')
db.close()

const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '0',
    DATABASE_PATH: databasePath,
    DATA_DIR: dataDir,
    STATIC_DIR: path.join(root, 'web/dist'),
    MODEL_GATEWAY_MODE: 'fixture',
    ALLOW_GATEWAY_FIXTURE: '1',
    FIXTURE_BASE_URL: fixture.url,
    DEEPSEEK_API_KEY: 'sk-test-should-not-leak-9f3a',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

const baseUrl = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not listen')), 10000)
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
  child.on('exit', (code) => reject(new Error(`server exited ${code}`)))
})

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

try {
  const page = await browser.newPage()
  await page.goto(`${baseUrl}/login`)
  await page.getByTestId('email').fill('admin@example.com')
  await page.getByTestId('password').fill('AdminPassw0rd!123')
  await page.getByRole('button', { name: '登录' }).click()
  await page.getByTestId('workspace-entry').waitFor()
  await page.getByRole('link', { name: '管理' }).click()
  await page.getByTestId('invite-count').fill('2')
  await page.getByTestId('create-invites').click()
  await page.getByTestId('invite-code').first().waitFor()
  const codes = await page.getByTestId('invite-code').allTextContents()
  if (codes.length !== 2) throw new Error(`expected 2 invite codes, got ${codes.join(',')}`)
  await page.getByRole('button', { name: '退出' }).click()
  await page.getByRole('link', { name: '使用邀请码注册' }).click()
  await page.getByTestId('email').fill('owner@example.com')
  await page.getByTestId('password').fill('UserPassw0rd!123')
  await page.getByTestId('invitation').fill(codes[0])
  await page.getByRole('button', { name: '注册' }).click()
  await page.getByTestId('companion-entry').click()
  await page.getByRole('link', { name: '新建角色' }).click()
  await page.getByTestId('character-name').fill('林')
  await page.getByTestId('character-identity').fill('研究员')
  await page.getByTestId('character-style').fill('短句')
  await page.getByRole('button', { name: '保存人格' }).click()
  await page.getByRole('link', { name: '记忆' }).click()
  await page.getByTestId('memory-content').fill('COMPANION_MEMORY_PHRASE')
  await page.getByTestId('memory-source').fill('e2e')
  await page.getByRole('button', { name: '保存记忆' }).click()
  await page.getByTestId('memory-item').waitFor()
  await page.goto(`${baseUrl}/companion`)
  await page.getByRole('button', { name: '新对话' }).click()
  await page.getByTestId('gateway-banner').waitFor()
  const banner = await page.getByTestId('gateway-banner').innerText()
  if (!banner.includes('不是 DeepSeek')) throw new Error(`banner did not mark fixture: ${banner}`)
  await page.getByTestId('composer').fill('浏览器你好')
  await page.getByTestId('send').click()
  await page.getByText('fixture-reply:浏览器你好').waitFor({ timeout: 10000 })
  await page.getByRole('button', { name: '退出' }).click()
  await page.getByTestId('email').fill('owner@example.com')
  await page.getByTestId('password').fill('UserPassw0rd!123')
  await page.getByRole('button', { name: '登录' }).click()
  await page.getByTestId('companion-entry').click()
  await page.getByRole('link', { name: '记忆' }).click()
  await page.getByText('COMPANION_MEMORY_PHRASE').waitFor()
  await page.goto(`${baseUrl}/companion`)
  await page.getByRole('link', { name: '浏览器你好' }).click()
  await page.getByText('fixture-reply:浏览器你好').waitFor()
  const keyField = await page.locator('input[name="apiKey"], input[placeholder*="API"], input[placeholder*="Key"]').count()
  if (keyField !== 0) throw new Error('found a provider key field')
  const stored = await page.evaluate(() => JSON.stringify(localStorage))
  if (stored.includes('sk-test') || stored.includes('apiKey')) throw new Error(`localStorage leaked provider state: ${stored}`)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${baseUrl}/`)
  await page.getByTestId('workspace-entry').waitFor()
  await page.getByTestId('companion-entry').click()
  await page.getByRole('link', { name: '浏览器你好' }).click()
  const composer = await page.getByTestId('composer').boundingBox()
  if (!composer || composer.width < 200 || composer.width > 390) {
    throw new Error(`composer width ${composer?.width ?? 0} is outside the phone layout`)
  }
  console.log('e2e ok')
} finally {
  await browser.close()
  child.kill('SIGTERM')
  await fixture.close()
  fs.rmSync(dir, { recursive: true, force: true })
}
