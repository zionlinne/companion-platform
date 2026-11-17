CREATE TABLE memory_embeddings (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  vector_base64 TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_memory_embeddings_version ON memory_embeddings(version);
