/** 客户端 SQLite 迁移清单，供 Node 与 Tauri 桌面运行时共用。 */
export const CLIENT_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS learning_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    learning_day TEXT NOT NULL,
    source TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_seq INTEGER NOT NULL,
    metadata_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE(device_id, device_seq)
  );

  CREATE INDEX IF NOT EXISTS idx_learning_events_occurred_at ON learning_events(occurred_at);

  CREATE TRIGGER IF NOT EXISTS trg_learning_events_forbid_update
  BEFORE UPDATE ON learning_events
  BEGIN
    SELECT RAISE(ABORT, '学习事件不可变：禁止 UPDATE（append-only 铁律）');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_learning_events_forbid_delete
  BEFORE DELETE ON learning_events
  BEGIN
    SELECT RAISE(ABORT, '学习事件不可变：禁止 DELETE（append-only 铁律）');
  END;

  CREATE TABLE IF NOT EXISTS word_contents (
    word_id TEXT PRIMARY KEY,
    list_id TEXT,
    space_id TEXT,
    original_spelling TEXT NOT NULL,
    normalized_key TEXT NOT NULL,
    manual_meaning TEXT NOT NULL,
    meanings_json TEXT NOT NULL,
    removed INTEGER NOT NULL CHECK (removed IN (0, 1)),
    recorded_at TEXT NOT NULL,
    removed_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uq_word_contents_active_space_key
    ON word_contents(space_id, normalized_key)
    WHERE space_id IS NOT NULL AND removed = 0;

  CREATE INDEX IF NOT EXISTS idx_word_contents_list ON word_contents(list_id);
  CREATE INDEX IF NOT EXISTS idx_word_contents_space ON word_contents(space_id);

  CREATE TABLE IF NOT EXISTS study_units (
    unit_id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    unit_number INTEGER NOT NULL,
    UNIQUE(space_id, unit_number)
  );

  CREATE TABLE IF NOT EXISTS list_catalog (
    list_id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    unit_number INTEGER NOT NULL,
    list_number INTEGER NOT NULL,
    UNIQUE(unit_id, list_number)
  );

  CREATE INDEX IF NOT EXISTS idx_list_catalog_space ON list_catalog(space_id);

  CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY,
    kind TEXT,
    display_order INTEGER NOT NULL,
    name TEXT,
    archived_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    learning_mode TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS test_sessions (
    session_id TEXT PRIMARY KEY,
    learning_mode TEXT NOT NULL,
    space_id TEXT,
    list_id TEXT,
    learning_day TEXT NOT NULL,
    group_ordinal INTEGER,
    task_id TEXT,
    words_json TEXT NOT NULL,
    current_position INTEGER NOT NULL,
    status TEXT NOT NULL,
    answered_word_ids_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_test_sessions_space_day
    ON test_sessions(space_id, learning_day, status);
  CREATE INDEX IF NOT EXISTS idx_test_sessions_list
    ON test_sessions(list_id, status);

  CREATE TABLE IF NOT EXISTS fsrs_cards (
    word_id TEXT PRIMARY KEY,
    card_json TEXT NOT NULL,
    due_at TEXT NOT NULL,
    scheduler_json TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    library_version TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    card_state TEXT NOT NULL,
    cumulative_recognized_count INTEGER NOT NULL,
    last_final_judgement TEXT
  );

  CREATE TABLE IF NOT EXISTS synced_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    device_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS device_local_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS llm_configuration (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    base_url TEXT NOT NULL,
    model_name TEXT NOT NULL,
    api_key_cipher TEXT NOT NULL,
    thinking_enabled INTEGER NOT NULL CHECK (thinking_enabled IN (0, 1)),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_plans (
    learning_day TEXT NOT NULL,
    space_id TEXT NOT NULL,
    target_capacity INTEGER NOT NULL,
    suggested_first_pass_count INTEGER NOT NULL,
    actual_first_pass_count INTEGER NOT NULL,
    actual_completed_workload REAL NOT NULL,
    prediction_window_days INTEGER NOT NULL,
    algorithm_version TEXT NOT NULL,
    due_snapshot_json TEXT NOT NULL,
    risk_metrics_json TEXT NOT NULL,
    PRIMARY KEY (learning_day, space_id)
  );

  CREATE TABLE IF NOT EXISTS outbox (
    entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('event', 'settings')),
    payload_json TEXT NOT NULL,
    event_id TEXT,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(next_attempt_at, entry_id);

  CREATE TABLE IF NOT EXISTS device_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS device_counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );

  INSERT OR IGNORE INTO device_counters (name, value) VALUES ('device_seq', 0);

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );

  INSERT OR IGNORE INTO sync_state (key, value) VALUES ('pull_cursor', 0);
  `,
  `
  ALTER TABLE test_sessions ADD COLUMN task_snapshot_json TEXT;

  -- 两台离线设备可能各自录入同一规范键的不同 Word；本地完整副本必须先收齐
  -- 两条记录，再交给应用层冲突界面处理，唯一索引会使拉取永久失败。
  DROP INDEX IF EXISTS uq_word_contents_active_space_key;

  CREATE TABLE IF NOT EXISTS content_versions (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    device_id TEXT NOT NULL,
    PRIMARY KEY (entity_type, entity_id)
  );

  CREATE TABLE IF NOT EXISTS content_outbox (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    PRIMARY KEY (entity_type, entity_id)
  );
  CREATE INDEX IF NOT EXISTS idx_content_outbox_due ON content_outbox(next_attempt_at);
  INSERT OR IGNORE INTO sync_state (key, value) VALUES ('content_pull_cursor', 0);
  `,
  `
  CREATE TABLE IF NOT EXISTS first_pass_drafts (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    unit_number INTEGER NOT NULL,
    list_number INTEGER NOT NULL,
    raw_text TEXT NOT NULL,
    use_language_model INTEGER NOT NULL CHECK (use_language_model IN (0, 1)),
    status TEXT NOT NULL,
    last_error TEXT,
    candidates_json TEXT,
    audit_json TEXT,
    unresolved_description TEXT,
    updated_at TEXT NOT NULL,
    device_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_first_pass_drafts_space_status
    ON first_pass_drafts(space_id, status);
  `,
  `
  -- V1 每个 Word 只保存一条成功在线释义；失败留在学习事件，不写成缓存。
  -- 词典内容按来源独立于 word_contents.manual_meaning，在线结果绝不能覆盖手录。
  CREATE TABLE IF NOT EXISTS dictionary_entries (
    id TEXT PRIMARY KEY,
    word_id TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    normalized_word TEXT NOT NULL,
    structured_definition_json TEXT NOT NULL,
    raw_response_summary TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    cache_status TEXT NOT NULL CHECK (cache_status IN ('有效', '失效'))
  );
  CREATE INDEX IF NOT EXISTS idx_dictionary_entries_fetched_at
    ON dictionary_entries(fetched_at, id);
  `,
];
