/**
 * 设备本地执行状态与派生态仓储：测试会话、FSRS 卡片、每日计划。
 *
 * 三者都是"设备本地"数据（ports.ts 合同）：不同步、不重放、各终端各自维护——
 * 会话是执行游标（极端崩溃时回退到上次确认点是可接受的语义），FSRS 卡片与
 * 每日计划是本地派生态（换设备后由事件重放/重新预测恢复）。
 */

import type Database from "better-sqlite3";

import type {
  DailyPlanRecord,
  DailyPlanStore,
  DueSnapshot,
  FsrsCardRecord,
  FsrsCardStore,
  RiskMetrics,
  TestSessionRecord,
  TestSessionStore,
} from "@ebbinghaus/application";

// ---------------------------------------------------------------------------
// 测试会话
// ---------------------------------------------------------------------------

interface SessionRow {
  readonly session_id: string;
  readonly learning_mode: string;
  readonly space_id: string | null;
  readonly list_id: string | null;
  readonly learning_day: string;
  readonly group_ordinal: number | null;
  readonly task_id: string | null;
  readonly task_snapshot_json: string | null;
  readonly words_json: string;
  readonly current_position: number;
  readonly status: string;
  readonly answered_word_ids_json: string;
  readonly started_at: string;
  readonly last_active_at: string;
}

function rowToSession(row: SessionRow): TestSessionRecord {
  return {
    sessionId: row.session_id,
    learningMode: row.learning_mode as TestSessionRecord["learningMode"],
    spaceId: row.space_id,
    listId: row.list_id,
    learningDay: row.learning_day,
    groupOrdinal: row.group_ordinal,
    taskId: row.task_id,
    taskSnapshot: row.task_snapshot_json === null ? null : JSON.parse(row.task_snapshot_json) as TestSessionRecord["taskSnapshot"],
    words: JSON.parse(row.words_json) as TestSessionRecord["words"],
    currentPosition: row.current_position,
    status: row.status as TestSessionRecord["status"],
    answeredWordIds: JSON.parse(row.answered_word_ids_json) as readonly string[],
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
  };
}

export class SqliteTestSessionStore implements TestSessionStore {
  private readonly db: Database.Database;

  private readonly addStmt;
  private readonly updateStmt;
  private readonly reconcileStmt;
  private readonly reorderWordsStmt;
  private readonly getStmt;
  private readonly openRegularStmt;
  private readonly openListStmt;

  constructor(db: Database.Database) {
    this.db = db;
    this.addStmt = this.db.prepare(`
      INSERT INTO test_sessions
        (session_id, learning_mode, space_id, list_id, learning_day, group_ordinal, task_id,
         words_json, current_position, status, answered_word_ids_json, started_at, last_active_at,
         task_snapshot_json)
      VALUES
        (@sessionId, @learningMode, @spaceId, @listId, @learningDay, @groupOrdinal, @taskId,
         @wordsJson, @currentPosition, @status, @answeredWordIdsJson, @startedAt, @lastActiveAt,
         @taskSnapshotJson)
    `);
    this.updateStmt = this.db.prepare(`
      UPDATE test_sessions SET
        current_position = @currentPosition, status = @status,
        answered_word_ids_json = @answeredWordIdsJson, last_active_at = @lastActiveAt
      WHERE session_id = @sessionId
    `);
    this.reorderWordsStmt = this.db.prepare(`
      UPDATE test_sessions SET words_json = @wordsJson, last_active_at = @lastActiveAt
      WHERE session_id = @sessionId
    `);
    this.reconcileStmt = this.db.prepare(`
      UPDATE test_sessions SET
        words_json = @wordsJson, current_position = @currentPosition, status = @status,
        answered_word_ids_json = @answeredWordIdsJson, last_active_at = @lastActiveAt
      WHERE session_id = @sessionId
    `);
    this.getStmt = this.db.prepare(
      `SELECT session_id, learning_mode, space_id, list_id, learning_day, group_ordinal, task_id,
              words_json, current_position, status, answered_word_ids_json, started_at, last_active_at,
              task_snapshot_json
       FROM test_sessions WHERE session_id = ?`,
    );
    this.openRegularStmt = this.db.prepare(`
      SELECT session_id, learning_mode, space_id, list_id, learning_day, group_ordinal, task_id,
             words_json, current_position, status, answered_word_ids_json, started_at, last_active_at,
             task_snapshot_json
      FROM test_sessions
      WHERE learning_mode = '常规模式' AND space_id = ? AND learning_day = ?
        AND status IN ('进行中', '已暂停')
      ORDER BY started_at ASC LIMIT 1
    `);
    this.openListStmt = this.db.prepare(`
      SELECT session_id, learning_mode, space_id, list_id, learning_day, group_ordinal, task_id,
             words_json, current_position, status, answered_word_ids_json, started_at, last_active_at,
             task_snapshot_json
      FROM test_sessions
      WHERE learning_mode = '词书模式' AND list_id = ?
        AND status IN ('进行中', '已暂停', '等待纸质复习')
      ORDER BY started_at ASC LIMIT 1
    `);
  }

  addSession(session: TestSessionRecord): void {
    this.addStmt.run({
      sessionId: session.sessionId,
      learningMode: session.learningMode,
      spaceId: session.spaceId,
      listId: session.listId,
      learningDay: session.learningDay,
      groupOrdinal: session.groupOrdinal,
      taskId: session.taskId,
      taskSnapshotJson: session.taskSnapshot === undefined || session.taskSnapshot === null ? null : JSON.stringify(session.taskSnapshot),
      wordsJson: JSON.stringify(session.words),
      currentPosition: session.currentPosition,
      status: session.status,
      answeredWordIdsJson: JSON.stringify(session.answeredWordIds),
      startedAt: session.startedAt,
      lastActiveAt: session.lastActiveAt,
    });
  }

  /**
   * 更新走"整体行覆盖"的字段子集（进度/状态/已答列表/活跃时间）；会话快照字段
   * （words、startedAt 等）不允许被 update 改写——会话开始时的定格是"开放会话
   * 保护"语义的载体，改写快照等于篡改历史。
   */
  updateSession(session: TestSessionRecord): void {
    const result = this.updateStmt.run({
      sessionId: session.sessionId,
      currentPosition: session.currentPosition,
      status: session.status,
      answeredWordIdsJson: JSON.stringify(session.answeredWordIds),
      lastActiveAt: session.lastActiveAt,
    });
    if (result.changes === 0) {
      throw new Error(`测试会话不存在：${session.sessionId}`);
    }
  }

  /**
   * 软移除与远端答案会改变本机执行队列。队列和游标必须同批落盘，否则下次读取
   * 会把失效词恢复或让游标套到旧顺序。校验仅允许原计划子集，不能凭空新增题目；
   * 开场任务快照、计划时刻和学习事件保留，校对本身不代表用户测试了被剔除的词。
   */
  reconcileSession(session: TestSessionRecord): void {
    this.db.transaction(() => {
      const stored = this.getSession(session.sessionId);
      if (stored === null) throw new Error(`测试会话不存在：${session.sessionId}`);
      const remaining = new Map<string, number>();
      for (const plan of stored.words) {
        const key = JSON.stringify(plan);
        remaining.set(key, (remaining.get(key) ?? 0) + 1);
      }
      for (const plan of session.words) {
        const key = JSON.stringify(plan);
        const count = remaining.get(key) ?? 0;
        if (count === 0) throw new Error("测试会话校对不得新增或改写 Word 计划");
        remaining.set(key, count - 1);
      }
      this.reconcileStmt.run({
        sessionId: session.sessionId, wordsJson: JSON.stringify(session.words),
        currentPosition: session.currentPosition, status: session.status,
        answeredWordIdsJson: JSON.stringify(session.answeredWordIds), lastActiveAt: session.lastActiveAt,
      });
    })();
  }

  /**
   * 持久化“点错了”造成的本机队列重排，同时验证计划成员与计划时刻完全不变。
   * 普通 updateSession 仍不改写开场快照；这个窄接口只允许排列已有 Word 计划，
   * 防止暂缓在内存中生效、页面下一次读取 SQLite 时又恢复成旧顺序。
   */
  reorderSessionWords(session: TestSessionRecord): void {
    const stored = this.getSession(session.sessionId);
    if (stored === null) {
      throw new Error(`测试会话不存在：${session.sessionId}`);
    }
    const remaining = new Map<string, number>();
    for (const plan of stored.words) {
      const key = JSON.stringify(plan);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const plan of session.words) {
      const key = JSON.stringify(plan);
      const count = remaining.get(key);
      if (count === undefined) {
        throw new Error("测试会话重排不得增删或改写 Word 计划");
      }
      if (count === 1) remaining.delete(key);
      else remaining.set(key, count - 1);
    }
    if (remaining.size > 0) {
      throw new Error("测试会话重排不得增删或改写 Word 计划");
    }
    const result = this.reorderWordsStmt.run({
      sessionId: session.sessionId,
      wordsJson: JSON.stringify(session.words),
      lastActiveAt: session.lastActiveAt,
    });
    if (result.changes === 0) {
      throw new Error(`测试会话不存在：${session.sessionId}`);
    }
  }

  getSession(sessionId: string): TestSessionRecord | null {
    const row = this.getStmt.get(sessionId) as SessionRow | undefined;
    return row === undefined ? null : rowToSession(row);
  }

  getOpenRegularSession(spaceId: string, learningDay: string): TestSessionRecord | null {
    const row = this.openRegularStmt.get(spaceId, learningDay) as SessionRow | undefined;
    return row === undefined ? null : rowToSession(row);
  }

  getOpenListSession(listId: string): TestSessionRecord | null {
    const row = this.openListStmt.get(listId) as SessionRow | undefined;
    return row === undefined ? null : rowToSession(row);
  }
}

// ---------------------------------------------------------------------------
// FSRS 卡片（设备本地派生态）
// ---------------------------------------------------------------------------

export class SqliteFsrsCardStore implements FsrsCardStore {
  private readonly db: Database.Database;

  private readonly upsertStmt;
  private readonly getStmt;

  constructor(db: Database.Database) {
    this.db = db;
    this.upsertStmt = this.db.prepare(`
      INSERT INTO fsrs_cards
        (word_id, card_json, due_at, scheduler_json, algorithm_version, library_version,
         updated_at, card_state, cumulative_recognized_count, last_final_judgement)
      VALUES
        (@wordId, @cardJson, @dueAt, @schedulerJson, @algorithmVersion, @libraryVersion,
         @updatedAt, @cardState, @cumulativeRecognizedCount, @lastFinalJudgement)
      ON CONFLICT(word_id) DO UPDATE SET
        card_json = excluded.card_json,
        due_at = excluded.due_at,
        scheduler_json = excluded.scheduler_json,
        algorithm_version = excluded.algorithm_version,
        library_version = excluded.library_version,
        updated_at = excluded.updated_at,
        card_state = excluded.card_state,
        cumulative_recognized_count = excluded.cumulative_recognized_count,
        last_final_judgement = excluded.last_final_judgement
    `);
    this.getStmt = this.db.prepare(`
      SELECT word_id, card_json, due_at, scheduler_json, algorithm_version, library_version,
             updated_at, card_state, cumulative_recognized_count, last_final_judgement
      FROM fsrs_cards WHERE word_id = ?
    `);
  }

  upsert(record: FsrsCardRecord): void {
    this.upsertStmt.run(record);
  }

  get(wordId: string): FsrsCardRecord | null {
    return (this.getStmt.get(wordId) as FsrsCardRecord | undefined) ?? null;
  }
}

// ---------------------------------------------------------------------------
// 每日计划（容量预测结果）
// ---------------------------------------------------------------------------

interface DailyPlanRow {
  readonly learning_day: string;
  readonly space_id: string;
  readonly target_capacity: number;
  readonly suggested_first_pass_count: number;
  readonly actual_first_pass_count: number;
  readonly actual_completed_workload: number;
  readonly prediction_window_days: number;
  readonly algorithm_version: string;
  readonly due_snapshot_json: string;
  readonly risk_metrics_json: string;
}

function rowToPlan(row: DailyPlanRow): DailyPlanRecord {
  return {
    learningDay: row.learning_day,
    spaceId: row.space_id,
    targetCapacity: row.target_capacity,
    suggestedFirstPassCount: row.suggested_first_pass_count,
    actualFirstPassCount: row.actual_first_pass_count,
    actualCompletedWorkload: row.actual_completed_workload,
    predictionWindowDays: row.prediction_window_days,
    algorithmVersion: row.algorithm_version,
    dueSnapshot: JSON.parse(row.due_snapshot_json) as DueSnapshot,
    riskMetrics: JSON.parse(row.risk_metrics_json) as RiskMetrics,
  };
}

export class SqliteDailyPlanStore implements DailyPlanStore {
  private readonly db: Database.Database;

  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listRecentStmt;

  constructor(db: Database.Database) {
    this.db = db;
    this.upsertStmt = this.db.prepare(`
      INSERT INTO daily_plans
        (learning_day, space_id, target_capacity, suggested_first_pass_count,
         actual_first_pass_count, actual_completed_workload, prediction_window_days,
         algorithm_version, due_snapshot_json, risk_metrics_json)
      VALUES
        (@learningDay, @spaceId, @targetCapacity, @suggestedFirstPassCount,
         @actualFirstPassCount, @actualCompletedWorkload, @predictionWindowDays,
         @algorithmVersion, @dueSnapshotJson, @riskMetricsJson)
      ON CONFLICT(learning_day, space_id) DO UPDATE SET
        target_capacity = excluded.target_capacity,
        suggested_first_pass_count = excluded.suggested_first_pass_count,
        actual_first_pass_count = excluded.actual_first_pass_count,
        actual_completed_workload = excluded.actual_completed_workload,
        prediction_window_days = excluded.prediction_window_days,
        algorithm_version = excluded.algorithm_version,
        due_snapshot_json = excluded.due_snapshot_json,
        risk_metrics_json = excluded.risk_metrics_json
    `);
    this.getStmt = this.db.prepare(`
      SELECT learning_day, space_id, target_capacity, suggested_first_pass_count,
             actual_first_pass_count, actual_completed_workload, prediction_window_days,
             algorithm_version, due_snapshot_json, risk_metrics_json
      FROM daily_plans WHERE learning_day = ? AND space_id = ?
    `);
    this.listRecentStmt = this.db.prepare(`
      SELECT learning_day, space_id, target_capacity, suggested_first_pass_count,
             actual_first_pass_count, actual_completed_workload, prediction_window_days,
             algorithm_version, due_snapshot_json, risk_metrics_json
      FROM daily_plans
      WHERE space_id = @spaceId AND learning_day < @beforeDay
      ORDER BY learning_day DESC LIMIT @limit
    `);
  }

  upsert(plan: DailyPlanRecord): void {
    this.upsertStmt.run({
      learningDay: plan.learningDay,
      spaceId: plan.spaceId,
      targetCapacity: plan.targetCapacity,
      suggestedFirstPassCount: plan.suggestedFirstPassCount,
      actualFirstPassCount: plan.actualFirstPassCount,
      actualCompletedWorkload: plan.actualCompletedWorkload,
      predictionWindowDays: plan.predictionWindowDays,
      algorithmVersion: plan.algorithmVersion,
      dueSnapshotJson: JSON.stringify(plan.dueSnapshot),
      riskMetricsJson: JSON.stringify(plan.riskMetrics),
    });
  }

  get(input: { readonly learningDay: string; readonly spaceId: string }): DailyPlanRecord | null {
    const row = this.getStmt.get(input.learningDay, input.spaceId) as DailyPlanRow | undefined;
    return row === undefined ? null : rowToPlan(row);
  }

  listRecent(input: {
    readonly spaceId: string;
    readonly beforeDay: string;
    readonly limit: number;
  }): DailyPlanRecord[] {
    const rows = this.listRecentStmt.all({
      spaceId: input.spaceId,
      beforeDay: input.beforeDay,
      limit: input.limit,
    }) as DailyPlanRow[];
    return rows.map(rowToPlan);
  }
}
