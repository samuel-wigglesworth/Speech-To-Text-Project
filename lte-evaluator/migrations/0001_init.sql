-- ─────────────────────────────────────────────────────────────────────────────
-- LTE Platform – D1 Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- Table 1: users
-- Primary key: email (from Google OAuth)
-- Stores one row per unique learner/educator.
CREATE TABLE IF NOT EXISTS users (
  email       TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  picture     TEXT NOT NULL DEFAULT '',
  google_sub  TEXT NOT NULL DEFAULT '',   -- Google "sub" claim (stable UID)
  role        TEXT NOT NULL DEFAULT 'learner', -- 'learner' | 'educator'
  created_at  INTEGER NOT NULL             -- Unix epoch seconds
);

-- Table 2: monthly_counts
-- Primary key: (email, year, month)
-- Counts how many assessments a user completes in each calendar month.
CREATE TABLE IF NOT EXISTS monthly_counts (
  email       TEXT    NOT NULL,
  year        INTEGER NOT NULL,  -- e.g. 2026
  month       INTEGER NOT NULL,  -- 1–12
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email, year, month),
  FOREIGN KEY (email) REFERENCES users(email) ON DELETE CASCADE
);

-- Table 3: sessions
-- Primary key: (email, started_at)
-- Each row is one assessment session — stores what was said and the result.
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT    PRIMARY KEY,   -- UUID generated server-side
  email              TEXT    NOT NULL,
  started_at         INTEGER NOT NULL,      -- Unix epoch seconds (also used as PK component)
  content_keys       TEXT    NOT NULL DEFAULT '[]',  -- JSON array of KV keys used
  transcript         TEXT    NOT NULL DEFAULT '',
  language_detected  TEXT    NOT NULL DEFAULT 'en',
  score_percent      INTEGER,
  understanding_level TEXT,
  evaluation_json    TEXT,                  -- full EvaluationResult JSON string
  followup_rounds    INTEGER NOT NULL DEFAULT 0, -- how many follow-up Q rounds completed
  FOREIGN KEY (email) REFERENCES users(email) ON DELETE CASCADE
);

-- Indexes for fast per-user lookups
CREATE INDEX IF NOT EXISTS idx_sessions_email       ON sessions(email);
CREATE INDEX IF NOT EXISTS idx_sessions_email_time  ON sessions(email, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_monthly_email        ON monthly_counts(email);
