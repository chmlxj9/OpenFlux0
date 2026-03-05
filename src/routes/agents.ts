import { Hono } from "hono";
import { getDb } from "../db";
import { DepositSchema } from "../schema";
import { credit, getBalance } from "../ledger";

const app = new Hono<{ Variables: { pubkey: string } }>();

// POST /agents/register
app.post("/register", (c) => {
  const pubkey = c.get("pubkey");
  const db = getDb();

  const existing = db.query("SELECT 1 FROM agents WHERE pubkey = ?").get(pubkey);
  if (existing) {
    return c.json({ error: "Agent already registered" }, 409);
  }

  db.query("INSERT INTO agents (pubkey) VALUES (?)").run(pubkey);
  db.query(
    "INSERT INTO principal_policies (pubkey) VALUES (?)"
  ).run(pubkey);

  return c.json({ pubkey, balance: 0, message: "Agent registered" }, 201);
});

// POST /agents/deposit — faucet for OpenFlux0
app.post("/deposit", async (c) => {
  const pubkey = c.get("pubkey");
  const body = await c.req.json();
  const parsed = DepositSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  const agent = db.query("SELECT 1 FROM agents WHERE pubkey = ?").get(pubkey);
  if (!agent) {
    return c.json({ error: "Agent not registered" }, 404);
  }

  credit(pubkey, parsed.data.amount, "faucet_deposit");
  const balance = getBalance(pubkey);

  return c.json({ pubkey, balance, deposited: parsed.data.amount });
});

// GET /agents/me
app.get("/me", (c) => {
  const pubkey = c.get("pubkey");
  const db = getDb();

  const agent = db
    .query("SELECT pubkey, balance, daily_spent, created_at FROM agents WHERE pubkey = ?")
    .get(pubkey) as {
    pubkey: string;
    balance: number;
    daily_spent: number;
    created_at: string;
  } | null;

  if (!agent) {
    return c.json({ error: "Agent not registered" }, 404);
  }

  const policy = db
    .query("SELECT * FROM principal_policies WHERE pubkey = ?")
    .get(pubkey);

  return c.json({ ...agent, policy });
});

export default app;
