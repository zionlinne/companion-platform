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
const db = openDatabase(config)
await migrate(db)
await initAdmin(db, config, 'admin@example.com', 'AdminPassw0rd!123')
await db.close()

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
  const shotDir = path.join(root, 'docs/evidence/screenshots')
  fs.mkdirSync(shotDir, { recursive: true })
  const shot = (name: string) => page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true })
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
  await shot('chat')
  await page.getByRole('button', { name: '退出' }).click()
  await page.getByTestId('email').fill('owner@example.com')
  await page.getByTestId('password').fill('UserPassw0rd!123')
  await page.getByRole('button', { name: '登录' }).click()
  await page.getByTestId('workspace-entry').waitFor()
  await shot('home')
  await page.getByTestId('companion-entry').click()
  await page.getByTestId('companion-quota').waitFor()
  await page.getByRole('link', { name: '记忆' }).click()
  await page.getByText('COMPANION_MEMORY_PHRASE').waitFor()
  await page.goto(`${baseUrl}/companion`)
  await page.getByRole('link', { name: '浏览器你好' }).click()
  await page.getByText('fixture-reply:浏览器你好').waitFor()
  const keyField = await page.locator('input[name="apiKey"], input[placeholder*="API"], input[placeholder*="Key"]').count()
  if (keyField !== 0) throw new Error('found a provider key field')
  const stored = await page.evaluate(() => JSON.stringify(localStorage))
  if (stored.includes('sk-test') || stored.includes('apiKey')) throw new Error(`localStorage leaked provider state: ${stored}`)
  await page.goto(`${baseUrl}/companion/new`)
  await page.getByTestId('template-example-notice').waitFor()
  const notice = await page.getByTestId('template-example-notice').innerText()
  if (!notice.includes('示例')) throw new Error(`template notice missing example mark: ${notice}`)
  await page.getByTestId('template-daily-companion').click()
  await page.getByTestId('character-name').fill('我的陪伴')
  await page.getByRole('button', { name: '保存人格' }).click()
  await page.getByTestId('export-character').waitFor()
  await page.waitForFunction(() => (document.querySelector('[data-testid="character-identity"]') as HTMLTextAreaElement | null)?.value.includes('日常'))
  await page.getByTestId('export-character').click()
  const card = await page.getByTestId('character-card-text').innerText()
  if (!card.includes('companion-platform-character')) throw new Error('character export missing kind')
  if (card.includes('memories') || card.includes('PACKAGE_EVENT')) throw new Error('character card included memory payload')
  await page.getByRole('link', { name: '记忆' }).click()
  const memoryPackage = JSON.stringify({
    kind: 'companion-platform-memory-package',
    version: 1,
    memories: [{
      category: 'event',
      content: 'PACKAGE_EVENT_KEEP',
      source: '旧日记',
      explicit: false,
      note: '年份不确定',
      createdAt: '2024-05-01T00:00:00.000Z',
      updatedAt: '2024-05-02T00:00:00.000Z',
    }],
  })
  await page.getByTestId('memory-import-text').fill(memoryPackage)
  await page.getByTestId('memory-import-preview').click()
  const importItem = page.getByTestId('import-item')
  await importItem.waitFor()
  await shot('memory-preview')
  const importText = await importItem.innerText()
  for (const expected of ['event', '未标为明确事实', '旧日记', '年份不确定', '2024-05-01']) {
    if (!importText.includes(expected)) throw new Error(`preview missing ${expected}: ${importText}`)
  }
  await page.getByTestId('memory-import-commit').click()
  await page.getByTestId('import-item').waitFor({ state: 'detached' })
  await page.getByTestId('memory-item').filter({ hasText: 'PACKAGE_EVENT_KEEP' }).waitFor()
  await page.getByTestId('memory-export').click()
  const exportedMemory = await page.getByTestId('memory-export-text').innerText()
  if (!exportedMemory.includes('PACKAGE_EVENT_KEEP') || !exportedMemory.includes('旧日记') || !exportedMemory.includes('年份不确定')) {
    throw new Error(`memory export lost fields: ${exportedMemory}`)
  }
  if (exportedMemory.includes('日常') || exportedMemory.includes('identity')) throw new Error('memory package included persona fields')
  await page.getByTestId('memory-import-text').fill(exportedMemory)
  await page.getByTestId('memory-import-preview').click()
  await page.getByTestId('import-duplicate').waitFor()
  await page.getByTestId('memory-import-commit').click()
  await page.getByTestId('import-duplicate').waitFor({ state: 'detached' })
  if (await page.getByTestId('memory-item').filter({ hasText: 'PACKAGE_EVENT_KEEP' }).count() !== 1) {
    throw new Error('repeat import wrote a second memory')
  }
  await page.goto(`${baseUrl}/companion/new`)
  await page.getByTestId('character-import-text').fill(card)
  await page.getByRole('button', { name: '导入为新角色' }).click()
  await page.waitForFunction(() => (document.querySelector('[data-testid="character-name"]') as HTMLInputElement | null)?.value === '我的陪伴')
  await page.goto(`${baseUrl}/companion`)
  const quota = await page.getByTestId('companion-quota').innerText()
  if (!/\/5/.test(quota)) throw new Error(`companion quota missing: ${quota}`)
  await page.locator('.panel', { hasText: '林' }).getByRole('link', { name: '人格' }).click()
  await page.waitForFunction(() => (document.querySelector('[data-testid="character-name"]') as HTMLInputElement | null)?.value === '林')
  await page.getByRole('checkbox', { name: '允许主动消息' }).check()
  await page.getByRole('button', { name: '保存人格' }).click()
  await page.getByTestId('export-character').waitFor()
  await page.goto(`${baseUrl}/workspace`)
  await shot('workspace')
  await page.getByRole('link', { name: '时间线' }).click()
  await page.getByTestId('timeline-title').fill('HAND_TIMELINE')
  await page.getByTestId('timeline-summary').fill('只授权这一条摘要')
  await page.getByRole('button', { name: '添加事件' }).click()
  await page.getByText('HAND_TIMELINE').waitFor()
  await shot('timeline')
  await page.goto(`${baseUrl}/workspace/grants`)
  await page.waitForFunction(() => Array.from((document.querySelector('[data-testid="grant-event"]') as HTMLSelectElement | null)?.options ?? []).some((option) => option.textContent === 'HAND_TIMELINE'))
  await page.getByTestId('grant-event').selectOption({ label: 'HAND_TIMELINE' })
  await page.getByTestId('grant-character').selectOption({ label: '林' })
  await page.getByTestId('grant-title').check()
  await page.getByRole('button', { name: '授权所选字段' }).click()
  await page.getByRole('button', { name: '撤销' }).waitFor()
  await shot('grant')
  await page.goto(`${baseUrl}/settings`)
  await page.getByRole('checkbox', { name: '开启' }).waitFor()
  await page.getByRole('checkbox', { name: '开启' }).check()
  await page.getByRole('button', { name: '保存主动消息' }).click()
  await page.getByText('主动消息设置已保存').waitFor()
  await page.getByTestId('initiative-tick').click()
  await page.getByText('已按已授权时间线检查主动消息').waitFor()
  await page.goto(`${baseUrl}/notifications`)
  await page.getByText('主动提醒：HAND_TIMELINE').waitFor()
  await shot('notification')
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
