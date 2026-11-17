const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  '10.0.2.2',
  'example.com',
  'example.org',
  'example.net',
])

export function assessTrialOrigin(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) {
    return { ok: false, status: 'BLOCKED', reason: '没有 COMPANION_PUBLIC_ORIGIN。可分发内测包没有构建。' }
  }
  let url
  try {
    url = new URL(value)
  } catch {
    return { ok: false, status: 'BLOCKED', reason: '构建配置不是合法 URL。' }
  }
  if (url.protocol !== 'https:') return { ok: false, status: 'BLOCKED', reason: '内测包只锁定 HTTPS 源。' }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    return { ok: false, status: 'BLOCKED', reason: '只接受源，不接受路径、查询、片段或账号。' }
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const blockedSuffix = host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.example') || host.endsWith('.invalid') || host.endsWith('.test')
  const placeholder = host.includes('placeholder') || host.includes('your-host') || host.includes('example')
  if (BLOCKED_HOSTS.has(host) || blockedSuffix || placeholder || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { ok: false, status: 'BLOCKED', reason: '不能用本机、示例、占位或未部署的地址冒充内测成品。' }
  }
  return { ok: true, status: 'READY', origin: url.origin }
}

function main() {
  const decision = assessTrialOrigin(process.env.COMPANION_PUBLIC_ORIGIN)
  if (!decision.ok) {
    console.error(`BLOCKED\n${decision.reason}\n没有生成可分发安装包，也没有使用假地址。`)
    process.exit(2)
  }
  console.log(`READY ${decision.origin}`)
  console.log('下一步才是带同一个 COMPANION_PUBLIC_ORIGIN 执行 Android 构建。这个命令本身不签名、不上传。')
}

if (process.argv[1] && process.argv[1].endsWith('trial-origin.mjs')) main()
