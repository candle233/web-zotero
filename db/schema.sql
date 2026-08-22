-- ============================================================================
-- Web Zotero — PostgreSQL 16+ relational schema (DDL)
-- ============================================================================
-- Design goals:
--   * Multi-user personal + team workspace libraries (workspace-scoped rows).
--   * Items with standard citation metadata + JSONB `extra` for the long tail.
--   * Creators linked M:N via item_creators (order_index + role).
--   * Self-referential collection tree; item_collections is M:N and is the ONLY
--     link between items and collections — removing an item from a collection
--     never deletes the item, and deleting a collection keeps the items.
--   * Attachments store object-storage metadata (file_key = S3/MinIO object key).
--   * Annotations carry viewport-normalized rects (rects_json) so they survive
--     zoom/rotation/device changes: each rect is {x,y,width,height} in [0,1].
--   * Full-text search via generated tsvector columns + GIN indexes.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS unaccent;   -- accent-insensitive FTS
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram fuzzy title search
-- CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector, enable for R8 semantic search

-- ----------------------------------------------------------------------------
-- Enumerated types (CHECK-backed enums keep bulk inserts cheap and portable)
-- ----------------------------------------------------------------------------
CREATE TYPE item_type AS ENUM (
  'journalArticle', 'book', 'bookSection', 'conferencePaper', 'preprint',
  'report', 'thesis', 'webpage', 'document', 'dataset', 'presentation',
  'manuscript', 'other'
);

CREATE TYPE creator_role AS ENUM ('author', 'editor', 'translator', 'contributor');

CREATE TYPE attachment_role AS ENUM ('primary', 'supplementary', 'snapshot');

CREATE TYPE annotation_type AS ENUM ('highlight', 'rect', 'note', 'ink', 'strike');

CREATE TYPE workspace_member_role AS ENUM ('owner', 'editor', 'viewer');

-- ----------------------------------------------------------------------------
-- Users & Workspaces
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        VARCHAR(255) NOT NULL,                 -- uniqueness via lower(email) index below
  display_name TEXT        NOT NULL DEFAULT '',
  password_hash TEXT       NOT NULL,                -- argon2id hash
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ                              -- soft delete
);

CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE workspaces (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT        NOT NULL,
  is_personal BOOLEAN     NOT NULL DEFAULT FALSE,   -- personal library vs shared team library
  owner_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id BIGINT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES users (id)      ON DELETE CASCADE,
  role         workspace_member_role NOT NULL DEFAULT 'editor',
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

-- ----------------------------------------------------------------------------
-- Items (bibliographic entries)
-- ----------------------------------------------------------------------------
CREATE TABLE items (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id   BIGINT      NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  item_type      item_type   NOT NULL DEFAULT 'journalArticle',
  title          TEXT        NOT NULL DEFAULT '',
  abstract       TEXT        NOT NULL DEFAULT '',
  publication    TEXT,                -- container-title: journal / book / proceedings
  volume         TEXT,
  issue          TEXT,
  pages          TEXT,
  date           TEXT,                -- free-form date; use date_precision for sorting
  date_precision SMALLINT DEFAULT 8,  -- 9=year+month+day … 6=year only (Zotero convention)
  sort_date      DATE,
  doi            VARCHAR(256),                        -- case-insensitive uniqueness via lower(doi) index below
  url            TEXT,
  issn           TEXT,
  isbn           TEXT,
  language       TEXT,                -- BCP-47, e.g. en-US / zh-CN
  extra          JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- non-standard fields
  fulltext       tsvector    GENERATED ALWAYS AS (
                   to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(abstract,''))
                 ) STORED,
  created_by     BIGINT      REFERENCES users (id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ                       -- trash-can semantics like Zotero
);

-- doi column as plain varchar + case-insensitive uniqueness (dependency-free)
CREATE UNIQUE INDEX items_workspace_doi_key
  ON items (workspace_id, lower(doi))
  WHERE deleted_at IS NULL AND doi IS NOT NULL;

CREATE INDEX items_workspace_idx      ON items (workspace_id)                  WHERE deleted_at IS NULL;
CREATE INDEX items_type_idx           ON items (workspace_id, item_type)       WHERE deleted_at IS NULL;
CREATE INDEX items_title_trgm_idx     ON items USING gin (title gin_trgm_ops); -- fuzzy title search
CREATE INDEX items_fulltext_gin_idx   ON items USING gin (fulltext);           -- metadata FTS
CREATE INDEX items_extra_gin_idx      ON items USING gin (extra);              -- JSONB containment queries
CREATE INDEX items_date_idx           ON items (workspace_id, sort_date DESC NULLS LAST) WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- Creators (people) — M:N with items, ordered and roled
-- ----------------------------------------------------------------------------
CREATE TABLE creators (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id BIGINT      NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  first_name  TEXT        NOT NULL DEFAULT '',
  last_name   TEXT        NOT NULL DEFAULT '',
  full_name   TEXT        NOT NULL,               -- single-field names (orgs)
  search_key  TEXT        NOT NULL,               -- lower(concat_ws(' ', first, last, full))
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, search_key)
);

CREATE INDEX creators_search_idx ON creators (workspace_id, search_key);

CREATE TABLE item_creators (
  item_id    BIGINT       NOT NULL REFERENCES items (id)    ON DELETE CASCADE,
  creator_id BIGINT       NOT NULL REFERENCES creators (id) ON DELETE CASCADE,
  role       creator_role NOT NULL DEFAULT 'author',
  order_index SMALLINT    NOT NULL DEFAULT 0,              -- author position (0-based)
  PRIMARY KEY (item_id, creator_id, role)
);

CREATE INDEX item_creators_creator_idx ON item_creators (creator_id);
CREATE INDEX item_creators_order_idx   ON item_creators (item_id, role, order_index);

-- ----------------------------------------------------------------------------
-- Collections — self-referential tree; M:N to items (decoupled from item deletion)
-- ----------------------------------------------------------------------------
CREATE TABLE collections (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id BIGINT      NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  parent_id   BIGINT      REFERENCES collections (id) ON DELETE CASCADE,  -- sub-collections
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, parent_id, name)
);

-- Prevent cycles in the collection tree (parent chain must stay acyclic).
-- Cheap guard: reject direct self-parenting; deep-cycle checks belong to app logic.
ALTER TABLE collections ADD CONSTRAINT collections_no_self_parent
  CHECK (parent_id IS NULL OR parent_id <> id);

CREATE INDEX collections_parent_idx ON collections (parent_id);
CREATE INDEX collections_workspace_idx ON collections (workspace_id);

CREATE TABLE item_collections (
  item_id       BIGINT NOT NULL REFERENCES items (id)       ON DELETE CASCADE,
  collection_id BIGINT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, collection_id)
);

CREATE INDEX item_collections_collection_idx ON item_collections (collection_id);
-- Deleting a collection removes only the links; deleting an item removes only its links.

-- ----------------------------------------------------------------------------
-- Tags — M:N with items
-- ----------------------------------------------------------------------------
CREATE TABLE tags (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id BIGINT      NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE item_tags (
  item_id BIGINT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  tag_id  BIGINT NOT NULL REFERENCES tags (id)  ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);

CREATE INDEX item_tags_tag_idx ON item_tags (tag_id);

-- ----------------------------------------------------------------------------
-- Attachments — object-storage (S3/MinIO/R2) metadata
-- ----------------------------------------------------------------------------
CREATE TABLE attachments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id     BIGINT          NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  role        attachment_role NOT NULL DEFAULT 'primary',
  content_type TEXT           NOT NULL DEFAULT 'application/pdf',
  file_key    TEXT            NOT NULL,          -- object key inside the bucket
  file_size   BIGINT          NOT NULL CHECK (file_size >= 0),
  mime_type   TEXT            NOT NULL DEFAULT 'application/pdf',
  md5_hash    CHAR(32),                          -- dedupe / integrity verification
  page_count  INT,
  title       TEXT,
  created_at  TIMESTAMPTZ     NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  UNIQUE (file_key)
);

CREATE INDEX attachments_item_idx    ON attachments (item_id)          WHERE deleted_at IS NULL;
CREATE INDEX attachments_md5_idx     ON attachments (md5_hash)         WHERE md5_hash IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Notes — standalone notes (child notes attach via parent_item_id)
-- ----------------------------------------------------------------------------
CREATE TABLE notes (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  BIGINT      NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  parent_item_id BIGINT     REFERENCES items (id) ON DELETE CASCADE,
  html          TEXT        NOT NULL DEFAULT '',
  search_tsv    tsvector    GENERATED ALWAYS AS (to_tsvector('simple', html)) STORED,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notes_item_idx     ON notes (parent_item_id);
CREATE INDEX notes_fts_gin_idx ON notes USING gin (search_tsv);

-- ----------------------------------------------------------------------------
-- Annotations — viewport-normalized, attached to an attachment (and cached item)
-- ----------------------------------------------------------------------------
CREATE TABLE annotations (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attachment_id BIGINT         NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
  item_id       BIGINT         NOT NULL REFERENCES items (id)        ON DELETE CASCADE,
  author_id     BIGINT         REFERENCES users (id) ON DELETE SET NULL,
  page_index    INT            NOT NULL CHECK (page_index >= 0),     -- 0-based page
  page_label    TEXT,                                              -- printed label, e.g. "iv"
  type          annotation_type NOT NULL,
  -- Normalized to the PDF page viewBox: every rect is {x,y,width,height} in [0,1].
  rects_json    JSONB          NOT NULL CHECK (jsonb_typeof(rects_json) = 'array'),
  color         CHAR(7)        NOT NULL DEFAULT '#ffd400',           -- #RRGGBB
  comment_text  TEXT           NOT NULL DEFAULT '',
  quote_text    TEXT           NOT NULL DEFAULT '',
  sort_index    TEXT,                                              -- "000001:000002.000015.000008"
  search_tsv    tsvector       GENERATED ALWAYS AS (
                  to_tsvector('simple', coalesce(comment_text,'') || ' ' || coalesce(quote_text,''))
                ) STORED,
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX annotations_attachment_idx ON annotations (attachment_id, page_index) WHERE deleted_at IS NULL;
CREATE INDEX annotations_item_idx       ON annotations (item_id)                   WHERE deleted_at IS NULL;
CREATE INDEX annotations_fts_gin_idx    ON annotations USING gin (search_tsv);     -- annotation FTS

-- ----------------------------------------------------------------------------
-- Reading progress / recently read (per user per attachment)
-- ----------------------------------------------------------------------------
CREATE TABLE reading_progress (
  user_id       BIGINT NOT NULL REFERENCES users (id)      ON DELETE CASCADE,
  attachment_id BIGINT NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
  percent       NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (percent >= 0 AND percent <= 100),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, attachment_id)
);

-- ----------------------------------------------------------------------------
-- update_at trigger helper
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER items_touch      BEFORE UPDATE ON items      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER workspaces_touch BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER collections_touch BEFORE UPDATE ON collections FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER annotations_touch BEFORE UPDATE ON annotations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER notes_touch      BEFORE UPDATE ON notes      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ----------------------------------------------------------------------------
-- Example: full-library search joining metadata FTS + annotation FTS
-- ----------------------------------------------------------------------------
-- SELECT i.id, i.title,
--        ts_rank(i.fulltext, websearch_to_tsquery('simple', $1)) AS meta_rank
-- FROM items i
-- WHERE i.workspace_id = $2 AND i.deleted_at IS NULL
--   AND i.fulltext @@ websearch_to_tsquery('simple', $1)
-- ORDER BY meta_rank DESC LIMIT 50;
--
-- SELECT a.* FROM annotations a
-- WHERE a.search_tsv @@ websearch_to_tsquery('simple', $1)
-- ORDER BY ts_rank(a.search_tsv, websearch_to_tsquery('simple', $1)) DESC LIMIT 50;
