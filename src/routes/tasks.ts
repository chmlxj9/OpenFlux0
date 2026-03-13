import { Hono } from "hono";
import { getDb } from "../db";
import { PostTaskSchema, SubmitTaskSchema } from "../schema";
import { holdWithDb, creditWithDb } from "../ledger";
import { newCuid } from "../utils/cuid";
import { config } from "../config";

const app = new Hono<{ Variables: { pubkey: string } }>();

function operatorFeeAmount(db: ReturnType<typeof getDb>, fee: number) {
  if (fee <= 0 || !config.nodeOperatorPubkey) return 0;
  const operator = db
    .query("SELECT 1 FROM agents WHERE pubkey = ?")
    .get(config.nodeOperatorPubkey);
  return operator ? fee : 0;
}

// POST /tasks/post — post a task with bounty
app.post("/post", async (c) => {
  const pubkey = c.get("pubkey");
  const body = await c.req.json();
  const parsed = PostTaskSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const data = parsed.data;
  const taskId = newCuid();
  const db = getDb();

  // Hold bounty from poster's balance and create the task atomically.
  try {
    db.transaction(() => {
      holdWithDb(db, pubkey, data.bounty_lamports, "task_bounty_hold", taskId);
      db.query(`
        INSERT INTO tasks (task_id, poster_pubkey, task_type, instruction,
          source_cuid, bounty_lamports, deadline_seconds)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        taskId,
        pubkey,
        data.task_type,
        data.instruction,
        data.source_cuid ?? null,
        data.bounty_lamports,
        data.deadline_seconds
      );
    })();
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }

  return c.json({ task_id: taskId, status: "open", bounty: data.bounty_lamports }, 201);
});

// GET /tasks/available — list open tasks
app.get("/available", (c) => {
  const db = getDb();

  const taskType = c.req.query("task_type");
  let sql = `
    SELECT task_id, poster_pubkey, task_type, instruction, source_cuid,
           bounty_lamports, deadline_seconds, created_at
    FROM tasks WHERE status = 'open'
  `;
  const bindings: string[] = [];

  if (taskType) {
    sql += " AND task_type = ?";
    bindings.push(taskType);
  }
  sql += " ORDER BY created_at DESC LIMIT 50";

  const rows = db.query(sql).all(...bindings);
  return c.json({ tasks: rows });
});

// POST /tasks/:taskId/claim
app.post("/:taskId/claim", (c) => {
  const taskId = c.req.param("taskId");
  const pubkey = c.get("pubkey");
  const db = getDb();

  const task = db
    .query("SELECT status, poster_pubkey FROM tasks WHERE task_id = ?")
    .get(taskId) as { status: string; poster_pubkey: string } | null;

  if (!task) return c.json({ error: "Task not found" }, 404);
  if (task.status !== "open") return c.json({ error: `Task is ${task.status}, not open` }, 409);
  if (task.poster_pubkey === pubkey) return c.json({ error: "Cannot claim your own task" }, 400);

  const deadlineRow = db
    .query("SELECT deadline_seconds FROM tasks WHERE task_id = ?")
    .get(taskId) as { deadline_seconds: number };

  const deadlineAt = new Date(Date.now() + deadlineRow.deadline_seconds * 1000).toISOString();

  const updated = db.query(`
    UPDATE tasks SET status = 'claimed', claimer_pubkey = ?,
      claimed_at = datetime('now'), deadline_at = ?
    WHERE task_id = ? AND status = 'open'
  `).run(pubkey, deadlineAt, taskId);
  if (!updated.changes) {
    return c.json({ error: "Task is no longer open" }, 409);
  }

  return c.json({ task_id: taskId, status: "claimed", deadline_at: deadlineAt });
});

// POST /tasks/:taskId/submit — submit result
app.post("/:taskId/submit", async (c) => {
  const taskId = c.req.param("taskId");
  const pubkey = c.get("pubkey");
  const body = await c.req.json();
  const parsed = SubmitTaskSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  const task = db
    .query("SELECT status, claimer_pubkey, poster_pubkey, bounty_lamports FROM tasks WHERE task_id = ?")
    .get(taskId) as {
    status: string;
    claimer_pubkey: string;
    poster_pubkey: string;
    bounty_lamports: number;
  } | null;

  if (!task) return c.json({ error: "Task not found" }, 404);
  if (task.status !== "claimed") return c.json({ error: `Task is ${task.status}` }, 409);
  if (task.claimer_pubkey !== pubkey) return c.json({ error: "Not the claimer" }, 403);

  // Check deadline
  const deadlineRow = db
    .query("SELECT deadline_at FROM tasks WHERE task_id = ?")
    .get(taskId) as { deadline_at: string };
  const deadlineAt = parseDeadline(deadlineRow.deadline_at);
  if (!deadlineAt || deadlineAt.getTime() < Date.now()) {
    // Expired — return bounty to poster
    expireTask(taskId);
    return c.json({ error: "Task deadline passed" }, 410);
  }

  // Auto-settle: pay claimer, deduct fee
  const bounty = task.bounty_lamports;
  const requestedFee = Math.floor((bounty * config.nodeTaskFeeBps) / 10000);
  let fee = 0;
  let claimerPayout = bounty;

  try {
    db.transaction(() => {
      fee = operatorFeeAmount(db, requestedFee);
      claimerPayout = bounty - fee;

      const updated = db.query(`
        UPDATE tasks SET status = 'completed', result = ?, proof = ?, settled_at = datetime('now')
        WHERE task_id = ? AND status = 'claimed'
      `).run(parsed.data.result, parsed.data.proof ?? null, taskId);
      if (!updated.changes) {
        throw new Error("Task is no longer claimable");
      }

      // Pay claimer (bounty was already held from poster)
      creditWithDb(db, pubkey, claimerPayout, "task_payout", taskId);
      if (fee > 0 && config.nodeOperatorPubkey) {
        creditWithDb(db, config.nodeOperatorPubkey, fee, "task_fee", taskId);
      }
    })();
  } catch (e: any) {
    return c.json({ error: e.message ?? "Failed to settle task" }, 409);
  }

  return c.json({
    task_id: taskId,
    status: "completed",
    payout: claimerPayout,
    fee,
  });
});

// GET /tasks/:taskId
app.get("/:taskId", (c) => {
  const taskId = c.req.param("taskId");
  const db = getDb();
  const task = db.query("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);
  return c.json(task);
});

// -- Helpers --

export function expireOverdueTasks(limit = config.taskExpiryBatchSize) {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const overdue = db
    .query(`
      SELECT task_id, poster_pubkey, bounty_lamports
      FROM tasks
      WHERE status = 'claimed'
        AND deadline_at IS NOT NULL
        AND deadline_at < ?
      ORDER BY deadline_at ASC
      LIMIT ?
    `)
    .all(nowIso, limit) as { task_id: string; poster_pubkey: string; bounty_lamports: number }[];

  if (overdue.length === 0) return 0;

  let expiredCount = 0;
  db.transaction(() => {
    for (const task of overdue) {
      const updated = db
        .query("UPDATE tasks SET status = 'expired' WHERE task_id = ? AND status = 'claimed'")
        .run(task.task_id);
      if (!updated.changes) continue;

      creditWithDb(db, task.poster_pubkey, task.bounty_lamports, "task_bounty_refund", task.task_id);
      expiredCount += 1;
    }
  })();

  return expiredCount;
}

function expireTask(taskId: string) {
  const db = getDb();
  const task = db
    .query("SELECT poster_pubkey, bounty_lamports, status FROM tasks WHERE task_id = ?")
    .get(taskId) as { poster_pubkey: string; bounty_lamports: number; status: string } | null;

  if (!task || task.status === "expired" || task.status === "completed") return;

  db.transaction(() => {
    const updated = db
      .query("UPDATE tasks SET status = 'expired' WHERE task_id = ? AND status = 'claimed'")
      .run(taskId);
    if (!updated.changes) return;
    // Return bounty to poster
    creditWithDb(db, task.poster_pubkey, task.bounty_lamports, "task_bounty_refund", taskId);
  })();
}

function parseDeadline(value: string): Date | null {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  const utcFallback = new Date(`${value}Z`);
  if (!Number.isNaN(utcFallback.getTime())) return utcFallback;

  return null;
}

export default app;
