/** Shim. Upstream toast state depends on the BYOK settings store. */
export const showToast = (message: { key?: string } | string) => {
  const text = typeof message === 'string' ? message : message.key ?? ''
  if (typeof document === 'undefined') return
  const el = document.createElement('div')
  el.className = 'cp-toast'
  el.textContent = text
  document.body.appendChild(el)
  window.setTimeout(() => el.remove(), 2400)
}
