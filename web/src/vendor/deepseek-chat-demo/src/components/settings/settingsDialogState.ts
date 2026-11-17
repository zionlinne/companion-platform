import { showToast } from '../base/toastState.js'

/** There is no browser API-key dialog. Sending uses the server gateway. */
export function ensureApiKey(): boolean {
  return true
}

export function openSettings(_section?: string) {
  showToast('供应商 Key 只放在服务端，这个页面不能填写。')
}
