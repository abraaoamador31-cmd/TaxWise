// src/billing.js
import express from 'express';
import pg from 'pg';

const router = express.Router();
const { Pool } = pg;

const FREE_LIMIT = parseInt(process.env.FREE_MSG_LIMIT) || 5;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

// Conexão com PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Criar tabela se não existir
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        plan VARCHAR(50) DEFAULT 'free',
        messages_used INTEGER DEFAULT 0,
        reset_date TIMESTAMP,
        mp_payer_email VARCHAR(255),
        hotmart_email VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Banco de dados conectado!');
  } catch (err) {
    console.error('Erro ao conectar banco:', err);
  }
}
initDB();

function nextResetDate() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function getOrCreateUser(userId) {
  let result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  
  if (result.rows.length === 0) {
    await pool.query(
      'INSERT INTO users (id, plan, messages_used, reset_date) VALUES ($1, $2, $3, $4)',
      [userId, 'free', 0, nextResetDate()]
    );
    result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  }

  const user = result.rows[0];

  // Reset mensal automático
  if (new Date() > new Date(user.reset_date)) {
    await pool.query(
      'UPDATE users SET messages_used = 0, reset_date = $1 WHERE id = $2',
      [nextResetDate(), userId]
    );
    user.messages_used = 0;
    user.reset_date = nextResetDate();
  }

  return user;
}

function canSendMessage(user) {
  if (user.plan === 'pro') return true;
  return user.messages_used < FREE_LIMIT;
}

// GET /api/usage
router.get('/usage', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(400).json({ error: 'x-user-id obrigatório' });

  const user = await getOrCreateUser(userId);
  const remaining = user.plan === 'pro' ? null : Math.max(0, FREE_LIMIT - user.messages_used);

  res.json({
    plan: user.plan,
    messages_used: user.messages_used,
    messages_limit: user.plan === 'pro' ? null : FREE_LIMIT,
    messages_remaining: remaining,
    reset_date: user.reset_date,
    can_send: canSendMessage(user)
  });
});

// POST /api/usage/increment
router.post('/usage/increment', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(400).json({ error: 'x-user-id obrigatório' });

  const user = await getOrCreateUser(userId);

  if (!canSendMessage(user)) {
    return res.status(402).json({
      error: 'limit_reached',
      messages_limit: FREE_LIMIT
    });
  }

  if (user.plan === 'free') {
    await pool.query(
      'UPDATE users SET messages_used = messages_used + 1 WHERE id = $1',
      [userId]
    );
  }

  res.json({ ok: true });
});

// POST /api/webhook/hotmart
router.post('/webhook/hotmart', async (req, res) => {
  res.sendStatus(200);
  try {
    const { data, event } = req.body;
    console.log('📨 Webhook Hotmart:', event);

    if (event === 'PURCHASE_APPROVED' || event === 'PURCHASE_COMPLETE') {
      const email = data?.buyer?.email;
      if (!email) return;

      // Ativa Pro para o usuário com esse email
      await pool.query(
        `UPDATE users SET plan = 'pro', messages_used = 0, hotmart_email = $1 WHERE hotmart_email = $1`,
        [email]
      );
      console.log(`✅ Pro ativado para: ${email}`);
    }

    if (event === 'PURCHASE_REFUNDED' || event === 'PURCHASE_CANCELLED') {
      const email = data?.buyer?.email;
      if (email) {
        await pool.query(
          `UPDATE users SET plan = 'free' WHERE hotmart_email = $1`,
          [email]
        );
        console.log(`⬇️ Revertido para free: ${email}`);
      }
    }
  } catch (err) {
    console.error('Erro webhook Hotmart:', err.message);
  }
});

// GET /api/admin/users
router.get('/admin/users', async (req, res) => {
  const result = await pool.query('SELECT id, plan, messages_used, reset_date, hotmart_email FROM users ORDER BY created_at DESC');
  res.json({ total: result.rows.length, users: result.rows });
});

export { router as billingRouter, getOrCreateUser, canSendMessage, pool };