export type Role = 'admin' | 'user'
export type Space = 'workspace' | 'companion'
export type MemoryCategory = 'persona' | 'fact' | 'event' | 'relationship'
export type MemoryStatus = 'active' | 'suggested' | 'rejected'

export type UserRow = {
  id: string
  email: string
  password_hash: string
  display_name: string
  role: Role
  created_at: string
  updated_at: string
  last_seen_at: string | null
  deleted_at: string | null
}

export type SessionRow = {
  id: string
  user_id: string
  token_hash: string
  created_at: string
  expires_at: string
  revoked_at: string | null
}

export type InvitationRow = {
  id: string
  code_hash: string
  created_by: string
  max_uses: number
  use_count: number
  expires_at: string | null
  revoked_at: string | null
  created_at: string
  note: string | null
}

export type CharacterRow = {
  id: string
  user_id: string
  name: string
  avatar_text: string
  identity: string
  background: string
  traits: string
  style: string
  habits: string
  relationship: string
  rules: string
  default_model: string
  initiative_enabled: number
  created_at: string
  updated_at: string
}

export type MemoryRow = {
  id: string
  user_id: string
  character_id: string
  category: MemoryCategory
  content: string
  source: string
  explicit: number
  note: string
  status: MemoryStatus
  created_at: string
  updated_at: string
}

export type ConversationRow = {
  id: string
  user_id: string
  space: Space
  character_id: string | null
  title: string
  model: string
  active_message_id: string | null
  created_at: string
  updated_at: string
}

export type MessageRow = {
  id: string
  user_id: string
  conversation_id: string
  parent_id: string | null
  role: 'user' | 'assistant'
  content: string
  reasoning: string | null
  status: 'complete' | 'streaming' | 'error' | 'aborted'
  created_at: string
  updated_at: string
}

export type AttachmentRow = {
  id: string
  user_id: string
  space: Space
  conversation_id: string | null
  message_id: string | null
  filename: string
  media_type: string
  byte_size: number
  storage_name: string
  created_at: string
}

export type TimelineEventRow = {
  id: string
  user_id: string
  project_id: string | null
  title: string
  summary: string
  event_type: string
  occurred_at: string
  due_at: string | null
  created_at: string
  updated_at: string
}

export type GrantRow = {
  id: string
  user_id: string
  event_id: string
  character_id: string
  allow_title: number
  allow_summary: number
  allow_occurred_at: number
  allow_due_at: number
  revoked_at: string | null
  created_at: string
}

export type QuotaRow = {
  user_id: string
  daily_request_limit: number
  daily_token_limit: number
  updated_at: string
}

export type InitiativeSettingsRow = {
  user_id: string
  enabled: number
  quiet_start_minute: number | null
  quiet_end_minute: number | null
  daily_limit: number
  max_model_calls_per_tick: number
  trigger_authorized_timeline: number
  updated_at: string
}
