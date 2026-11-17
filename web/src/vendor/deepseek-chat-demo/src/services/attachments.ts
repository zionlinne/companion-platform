import { create } from 'zustand'
import type { TranslationMessage } from '../i18n/index.js'
import { getChatHost } from './chat/host.js'

export const ACCEPT = '*/*'
export const MAX_COUNT = 50
export const MAX_SIZE_MB = 5

export type UploadTask =
  | { status: 'uploading' }
  | { status: 'done' }
  | { status: 'error'; error: TranslationMessage; retryable: boolean }

export const useUploadMode = create<{ mode: 'local' | 'disabled' }>(() => ({ mode: 'disabled' }))

export function setUploadsMode(mode: 'local' | 'disabled') {
  useUploadMode.setState({ mode })
}

export function uploadsEnabled() {
  return useUploadMode.getState().mode === 'local'
}

export const useUploads = create<{ tasks: Record<string, UploadTask> }>(() => ({ tasks: {} }))

export function getExtension(name: string) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : ''
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function setUploadTask(id: string, task: UploadTask) {
  useUploads.setState((state) => ({ tasks: { ...state.tasks, [id]: task } }))
}

export function clearUploadTask(id: string) {
  useUploads.setState((state) => {
    const tasks = { ...state.tasks }
    delete tasks[id]
    return { tasks }
  })
}

export async function uploadServerFile(file: File): Promise<string> {
  const host = getChatHost()
  if (!host || !uploadsEnabled()) throw new Error('uploads_disabled')
  const body = new FormData()
  body.append('file', file)
  const response = await fetch(`/api/attachments?space=${host.space}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-Companion-Request': '1' },
    body,
  })
  const data = (await response.json()) as { attachment?: { id: string }; error?: { message?: string } }
  if (!response.ok || !data.attachment) throw new Error(data.error?.message ?? '上传失败')
  return data.attachment.id
}
