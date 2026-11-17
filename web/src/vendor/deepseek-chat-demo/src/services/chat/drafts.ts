import { create } from 'zustand'
import { clearUploadTask, setUploadTask, uploadServerFile, uploadsEnabled, type UploadTask } from '../attachments.js'
import { createId } from '../../utils/id.js'

export type DraftAttachment = {
  id: string
  file: File
  isImage: boolean
  previewUrl: string | null
  serverId: string | null
}

type Draft = { text: string; attachments: DraftAttachment[] }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

export const useDrafts = create<{ drafts: Map<string | null, Draft> }>(() => ({
  drafts: new Map(),
}))

export const getDraft = (sessionId: string | null): Draft => useDrafts.getState().drafts.get(sessionId) ?? EMPTY_DRAFT

function updateDraft(sessionId: string | null, update: (draft: Draft) => Draft) {
  useDrafts.setState((state) => {
    const draft = update(state.drafts.get(sessionId) ?? EMPTY_DRAFT)
    const drafts = new Map(state.drafts)
    if (draft.text || draft.attachments.length > 0) drafts.set(sessionId, draft)
    else drafts.delete(sessionId)
    return { drafts }
  })
}

export function setDraftText(sessionId: string | null, text: string) {
  updateDraft(sessionId, (draft) => ({ ...draft, text }))
}

async function uploadDraft(sessionId: string | null, item: DraftAttachment) {
  setUploadTask(item.id, { status: 'uploading' })
  try {
    const serverId = await uploadServerFile(item.file)
    updateDraft(sessionId, (draft) => ({
      ...draft,
      attachments: draft.attachments.map((attachment) => (attachment.id === item.id ? { ...attachment, serverId } : attachment)),
    }))
    setUploadTask(item.id, { status: 'done' })
  } catch (error) {
    setUploadTask(item.id, {
      status: 'error',
      error: { key: 'uploadFileStatusFailed' },
      retryable: true,
    })
    if (error instanceof Error && error.message) {
      setUploadTask(item.id, { status: 'error', error: { key: 'uploadFileStatusFailed' }, retryable: true })
    }
  }
}

export function addDraftFiles(sessionId: string | null, files: File[], _apiKey: string): string | null {
  if (!uploadsEnabled()) return '免费托管还不能保存附件，这个按钮没有打开。'
  const tooBig = files.find((file) => file.size > 5_000_000)
  if (tooBig) return '文件太大，没有上传。'
  for (const file of files) {
    const item: DraftAttachment = {
      id: createId(),
      file,
      isImage: file.type.startsWith('image/'),
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      serverId: null,
    }
    updateDraft(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, item] }))
    void uploadDraft(sessionId, item)
  }
  return null
}

export function retryDraftAttachment(sessionId: string | null, id: string, _apiKey: string) {
  const item = getDraft(sessionId).attachments.find((attachment) => attachment.id === id)
  if (item) void uploadDraft(sessionId, item)
}

export function removeDraftAttachment(sessionId: string | null, attachmentId: string) {
  const item = getDraft(sessionId).attachments.find((attachment) => attachment.id === attachmentId)
  if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
  clearUploadTask(attachmentId)
  updateDraft(sessionId, (draft) => ({ ...draft, attachments: draft.attachments.filter((attachment) => attachment.id !== attachmentId) }))
}

export function prepareDraftMessage(draft: Draft, tasks: Record<string, UploadTask>) {
  const text = draft.text.trim()
  if (!text) return null
  if (draft.attachments.some((item) => tasks[item.id]?.status !== 'done' || !item.serverId)) return null
  return { text, attachmentIds: draft.attachments.map((item) => item.serverId).filter((id): id is string => Boolean(id)) }
}

export function clearSentDraft(sessionId: string | null) {
  for (const item of getDraft(sessionId).attachments) {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    clearUploadTask(item.id)
  }
  useDrafts.setState((state) => {
    const drafts = new Map(state.drafts)
    drafts.delete(sessionId)
    return { drafts }
  })
}
