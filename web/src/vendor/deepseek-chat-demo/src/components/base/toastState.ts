import { translate, type TranslationMessage } from '../../i18n/index.js'

export const showToast = (message: TranslationMessage | string) => {
  const text = typeof message === 'string' ? message : translate(message.key, message.params)
  if (typeof document === 'undefined' || !text) return
  const el = document.createElement('div')
  el.className = 'cp-toast'
  el.textContent = text
  document.body.appendChild(el)
  window.setTimeout(() => el.remove(), 2400)
}
