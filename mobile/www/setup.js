import { parseAppOrigin } from './origin-policy.mjs'

const form = document.querySelector('form')
const input = document.querySelector('#origin')
const error = document.querySelector('#error')
const debugNote = document.querySelector('#debug-note')
const version = document.querySelector('#version')
const shell = window.DShell

if (version && shell?.getVersion) version.textContent = shell.getVersion()
if (shell?.isDebug?.()) debugNote.hidden = false
if (shell?.getOrigin) input.value = shell.getOrigin() || ''

form.addEventListener('submit', (event) => {
  event.preventDefault()
  error.textContent = ''
  const decision = parseAppOrigin(input.value, Boolean(shell?.isDebug?.()))
  if (!decision.ok) {
    error.textContent = decision.reason
    return
  }
  if (!shell?.setOrigin) {
    error.textContent = '这个页面要在 Android 壳里打开'
    return
  }
  const nativeError = shell.setOrigin(decision.origin)
  if (nativeError) error.textContent = nativeError
})

document.querySelector('#clear-cookies').addEventListener('click', () => {
  shell?.clearCookies?.()
  error.textContent = '已清除 WebView 里的 Cookie。会话没有写入本地存储。'
})
