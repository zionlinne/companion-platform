/** Browser transcription is not connected. The voice control stays disabled. */
export async function transcribe(_apiKey: string, _audio: Blob, _signal: AbortSignal): Promise<string> {
  throw new Error('voice_unavailable')
}
