import { Hono } from "hono";
import { getDb } from "../db";
import { PostTaskSchema, SubmitTaskSchema } from "../schema";
import { hold, credit } from "../ledger";
import { newCuid } from "../utils/cuid";
import { config } from "../config";

const app = new Hono<{ Variables: { pubkey: string } }>();

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

  // Hold bounty from poster's balance
  try {
    hold(pubkey, data.bounty_lamports, "task_bounty_hold", taskId);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }

  const db = getDb();
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

  return c.json({ task_id: taskId, status: "open", bounty: data.bounty_lamports }, 201);
});

// GET /tasks/available — list open tasks
app.get("/available", (c) => {
  const db = getDb();

  // Expire overdue claimed tasks first
  expireOverdueTasks();

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

  db.query(`
    UPDATE tasks SET status = 'claimed', claimer_pubkey = ?,
      claimed_at = datetime('now'), deadline_at = ?
    WHERE task_id = ?
  `).run(pubkey, deadlineAt, taskId);

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
  const fee = Math.floor((bounty * config.nodeTaskFeeBps) / 10000);
  const claimerPayout = bounty - fee;

  db.transaction(() => {
    db.query(`
      UPDATE tasks SET status = 'completed', result = ?, proof = ?, settled_at = datetime('now')
      WHERE task_id = ?
    `).run(parsed.data.result, parsed.data.proof ?? null, taskId);

    // Pay claimer (bounty was already held from poster)
    credit(pubkey, claimerPayout, "task_payout", taskId);
    if (fee > 0 && config.nodeOperatorPubkey) {
      credit(config.nodeOperatorPubkey, fee, "task_fee", taskId);
    }
  })();

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

function expireOverdueTasks() {
  const db = getDb();
  const overdue = db
    .query(`
      SELECT task_id
      FROM tasks
      WHERE status = 'claimed'
        AND deadline_at IS NOT NULL
        AND julianday(deadline_at) < julianday('now')
    `)
    .all() as { task_id: string }[];

  for (const { task_id } of overdue) {
    expireTask(task_id);
  }
}

function expireTask(taskId: string) {
  const db = getDb();
  const task = db
    .query("SELECT poster_pubkey, bounty_lamports, status FROM tasks WHERE task_id = ?")
    .get(taskId) as { poster_pubkey: string; bounty_lamports: number; status: string } | null;

  if (!task || task.status === "expired" || task.status === "completed") return;

  db.transaction(() => {
    db.query("UPDATE tasks SET status = 'expired' WHERE task_id = ?").run(taskId);
    // Return bounty to poster
    credit(task.poster_pubkey, task.bounty_lamports, "task_bounty_refund", taskId);
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
