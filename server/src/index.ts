import http from 'node:http'
import { loadConfig } from './config.ts'
import { createApp } from './create-app.ts'
import { migrate, openDatabase } from './db.ts'
import { tickInitiative } from './initiative.ts'
import { createLogger } from './log.ts'

const config = loadConfig()
const db = openDatabase(config.databasePath)
migrate(db)
const log = createLogger()
const app = createApp({ db, config, log })
const server = http.createServer((req, res) => {
  void app.listener(req, res)
})

let ticking = false
if (config.initiativePollMs > 0) {
  setInterval(() => {
    if (ticking) return
    ticking = true
    void (async () => {
      try {
        const rows = db.prepare(`SELECT user_id FROM initiative_settings WHERE enabled = 1`).all() as Array<{ user_id: string }>
        for (const row of rows) {
          await tickInitiative({ db, config, log }, row.user_id)
        }
      } catch (error) {
        log.error('initiative_poll_failed', { name: error instanceof Error ? error.name : 'Error' })
      } finally {
        ticking = false
      }
    })()
  }, config.initiativePollMs).unref()
}

server.listen(config.port, config.host, () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.port
  log.info('listening', {
    host: config.host,
    port,
    gatewayMode: config.gatewayMode,
    gatewayConfigured: config.gatewayMode === 'fixture' || Boolean(config.deepseekApiKey),
  })
})
