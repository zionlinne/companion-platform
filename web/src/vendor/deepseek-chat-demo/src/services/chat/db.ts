/** Message files stay on the server. This does not read IndexedDB. */
export async function loadFile(_id: string): Promise<Blob | null> {
  return null
}
