CREATE TABLE IF NOT EXISTS ai_chef_messages (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  thread_id BIGINT NOT NULL DEFAULT 0,
  user_id BIGINT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_chef_messages_context
  ON ai_chef_messages(chat_id, thread_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_chef_knowledge (
  id BIGSERIAL PRIMARY KEY,
  language TEXT NOT NULL DEFAULT 'all' CHECK (language IN ('all','ru','kk')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_chef_knowledge_language
  ON ai_chef_knowledge(language, updated_at DESC);
