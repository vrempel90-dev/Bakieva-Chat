CREATE TABLE IF NOT EXISTS trial_pdf_assets (
  language TEXT PRIMARY KEY CHECK (language IN ('ru','kk')),
  content BYTEA,
  mime_type TEXT NOT NULL DEFAULT 'application/pdf',
  filename TEXT NOT NULL,
  telegram_file_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
