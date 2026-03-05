import { getDb } from "./db";

export function credit(pubkey: string, amount: number, reason: string, refId?: string) {
  const db = getDb();
  db.transaction(() => {
    db.query("UPDATE agents SET balance = balance + ? WHERE pubkey = ?").run(amount, pubkey);
    db.query(
      "INSERT INTO ledger (pubkey, amount, reason, ref_id) VALUES (?, ?, ?, ?)"
    ).run(pubkey, amount, reason, refId ?? null);
  })();
}

export function debit(pubkey: string, amount: number, reason: string, refId?: string) {
  const db = getDb();
  db.transaction(() => {
    const agent = db
      .query("SELECT balance FROM agents WHERE pubkey = ?")
      .get(pubkey) as { balance: number } | null;

    if (!agent) throw new Error("Agent not found");
    if (agent.balance < amount) throw new Error("Insufficient balance");

    // Check daily spending cap
    resetDailyIfNeeded(pubkey);
    const policy = db
      .query("SELECT daily_spend_cap FROM principal_policies WHERE pubkey = ?")
      .get(pubkey) as { daily_spend_cap: number } | null;

    if (policy) {
      const agentRow = db
        .query("SELECT daily_spent FROM agents WHERE pubkey = ?")
        .get(pubkey) as { daily_spent: number };
      if (agentRow.daily_spent + amount > policy.daily_spend_cap) {
        throw new Error("Daily spending cap exceeded");
      }
    }

    db.query("UPDATE agents SET balance = balance - ?, daily_spent = daily_spent + ? WHERE pubkey = ?")
      .run(amount, amount, pubkey);
    db.query(
      "INSERT INTO ledger (pubkey, amount, reason, ref_id) VALUES (?, ?, ?, ?)"
    ).run(pubkey, -amount, reason, refId ?? null);
  })();
}

export function hold(pubkey: string, amount: number, reason: string, refId?: string) {
  // Hold is the same as debit — funds removed from available balance
  debit(pubkey, amount, reason, refId);
}

export function release(pubkey: string, amount: number, reason: string, refId?: string) {
  // Release returns held funds
  credit(pubkey, amount, reason, refId);
}

export function getBalance(pubkey: string): number {
  const db = getDb();
  const row = db
    .query("SELECT balance FROM agents WHERE pubkey = ?")
    .get(pubkey) as { balance: number } | null;
  return row?.balance ?? 0;
}

function resetDailyIfNeeded(pubkey: string) {
  const db = getDb();
  const agent = db
    .query("SELECT daily_reset_at FROM agents WHERE pubkey = ?")
    .get(pubkey) as { daily_reset_at: string } | null;
  if (!agent) return;

  const resetAt = new Date(agent.daily_reset_at + "Z");
  const now = new Date();
  if (now.getTime() - resetAt.getTime() > 24 * 60 * 60 * 1000) {
    db.query(
      "UPDATE agents SET daily_spent = 0, daily_reset_at = datetime('now') WHERE pubkey = ?"
    ).run(pubkey);
  }
}
