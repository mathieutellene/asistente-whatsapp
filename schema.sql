-- Memoria del asistente (PostgreSQL). Idempotente: se puede ejecutar varias veces.

CREATE TABLE IF NOT EXISTS chats (
  chat_id     text PRIMARY KEY,           -- 34600000000@s.whatsapp.net  |  1234-5678@g.us
  name        text,
  is_group    boolean NOT NULL DEFAULT false,
  archived    boolean NOT NULL DEFAULT false,
  muted_until timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  jid        text PRIMARY KEY,
  name       text,                        -- nombre en tu agenda del móvil
  notify     text,                        -- nombre que se pone la persona en WhatsApp
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  chat_id     text NOT NULL,
  msg_id      text NOT NULL,
  from_me     boolean NOT NULL,
  sender_jid  text,
  sender_name text,
  ts          timestamptz NOT NULL,
  type        text,
  text        text,
  quoted_id   text,
  mentions    text[],
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(text, ''))) STORED,
  PRIMARY KEY (chat_id, msg_id)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts_idx ON messages (chat_id, ts DESC);
CREATE INDEX IF NOT EXISTS messages_sender_idx  ON messages (sender_jid);
CREATE INDEX IF NOT EXISTS messages_tsv_idx     ON messages USING gin (tsv);

-- WhatsApp identifica a algunos contactos con un ID anónimo (@lid); aquí guardamos su número real.
CREATE TABLE IF NOT EXISTS lid_map (
  lid text PRIMARY KEY,
  pn  text NOT NULL
);

-- Borradores de respuesta generados por la IA local. Nunca se envían solos.
CREATE TABLE IF NOT EXISTS drafts (
  id             serial PRIMARY KEY,
  chat_id        text NOT NULL,
  trigger_msg_id text,                        -- mensaje al que responde
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'pendiente', -- pendiente | usado | descartado | respondido | reemplazado
  text           text NOT NULL,
  model          text,
  gen_ms         int,                         -- lo que tardó la IA
  my_reply       text                         -- lo que acabaste enviando tú (para aprender)
);
CREATE INDEX IF NOT EXISTS drafts_chat_idx   ON drafts (chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS drafts_status_idx ON drafts (status, created_at DESC);
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS alternativas jsonb;  -- [{texto, modelo, ms}] opciones para elegir
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS contexto     jsonb;  -- que fuentes se usaron (calendario, gmail...)

-- Perfil de cada chat: analisis de la IA sobre el historico + tus propias notas (que mandan)
CREATE TABLE IF NOT EXISTS chat_profiles (
  chat_id    text PRIMARY KEY,
  perfil     jsonb,                     -- {relacion, tono, como_escribes, temas, datos, evitar}
  notas      text,                      -- tus instrucciones: "es mi jefa, trátala de usted"
  msgs_count int NOT NULL DEFAULT 0,    -- mensajes que habia al analizarlo (para saber cuando repetir)
  updated_at timestamptz                -- cuando se analizo por ultima vez
);

-- Chats cuyo último mensaje NO es tuyo (sin archivar ni silenciar).
CREATE OR REPLACE VIEW pendientes AS
WITH ultimo AS (
  SELECT DISTINCT ON (chat_id) chat_id, from_me, ts, sender_name, text
  FROM messages
  ORDER BY chat_id, ts DESC
), mi_ultimo AS (
  SELECT chat_id, max(ts) AS ts FROM messages WHERE from_me GROUP BY chat_id
)
SELECT
  u.chat_id,
  COALESCE(ch.name, ct.name, ct.notify, split_part(u.chat_id, '@', 1)) AS nombre,
  COALESCE(ch.is_group, u.chat_id LIKE '%@g.us')                       AS es_grupo,
  (SELECT count(*)::int FROM messages m
    WHERE m.chat_id = u.chat_id AND NOT m.from_me
      AND m.ts > COALESCE(mi.ts, '-infinity'::timestamptz))             AS sin_responder,
  u.ts          AS ultimo_mensaje,
  u.sender_name AS de,
  u.text        AS texto
FROM ultimo u
LEFT JOIN chats     ch ON ch.chat_id = u.chat_id
LEFT JOIN contacts  ct ON ct.jid     = u.chat_id
LEFT JOIN mi_ultimo mi ON mi.chat_id = u.chat_id
WHERE NOT u.from_me
  AND NOT COALESCE(ch.archived, false)
  AND (ch.muted_until IS NULL OR ch.muted_until < now());
