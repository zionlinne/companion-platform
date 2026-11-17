const DEBUG_HTTP_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '10.0.2.2'])

export function parseAppOrigin(raw, debug) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, reason: '请填写服务地址' }
  let url
  try {
    url = new URL(text)
  } catch {
    return { ok: false, reason: '地址不是合法 URL' }
  }
  if (url.username || url.password) return { ok: false, reason: '地址不能包含用户名或密码' }
  if (url.search || url.hash) return { ok: false, reason: '地址不能带查询或片段' }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: '只接受 HTTPS' }
  if (url.pathname !== '/' && url.pathname !== '') return { ok: false, reason: '请只填写源，不要带路径' }
  if (!url.hostname) return { ok: false, reason: '缺少主机名' }
  if (url.protocol === 'https:') return { ok: true, origin: url.origin, transport: 'https' }
  if (!debug) return { ok: false, reason: '正式包只接受 HTTPS' }
  if (!DEBUG_HTTP_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, reason: '调试 HTTP 只允许本机回环或模拟器 10.0.2.2' }
  }
  return { ok: true, origin: url.origin, transport: 'debug-http' }
}
