export type Recording = {
  stop: () => Promise<Blob | null>
  cancel: () => void
  analyser: AnalyserNode | null
}

export function startRecording(_onLimit: () => void): Promise<Recording> {
  return Promise.reject(new Error('voice_unavailable'))
}
