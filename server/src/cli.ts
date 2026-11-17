import { loadConfig } from './config.ts'
import { createInvitations, initAdmin } from './auth.ts'
import { migrate, openDatabase } from './db.ts'

const [command, ...args] = process.argv.slice(2)
const config = loadConfig()
const db = openDatabase(config)
const applied = await migrate(db)

if (command === 'migrate') {
  console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Migrations already applied')
} else if (command === 'init-admin') {
  const email = process.env.ADMIN_EMAIL ?? ''
  const password = process.env.ADMIN_PASSWORD ?? ''
  if (!email || !password) {
    console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD in the environment. The password is not read from a file in the repository.')
    process.exitCode = 1
  } else {
    await initAdmin(db, config, email, password)
    console.log(`Administrator created for ${email}. The password was not printed.`)
  }
} else if (command === 'invite') {
  const countFlag = args.indexOf('--count')
  const count = countFlag >= 0 ? Number(args[countFlag + 1]) : 1
  const admin = await db.get<{ id: string }>(`SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL`)
  if (!admin) {
    console.error('Create an administrator before issuing invitations.')
    process.exitCode = 1
  } else {
    const created = await createInvitations(db, admin.id, count, 1, 'cli')
    console.log('Invitation codes (shown once):')
    for (const invite of created) console.log(invite.code)
  }
} else {
  console.error('Usage: cli.ts migrate | init-admin | invite --count N')
  process.exitCode = 1
}

await db.close()
