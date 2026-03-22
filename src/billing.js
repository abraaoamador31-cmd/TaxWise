// src/billing.js
import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

const router = express.Router();

const FREE_LIMIT = parseInt(process.env.FREE_MSG_LIMIT) || 5;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

// Banco de dados em memória (substituir por PostgreSQL em produção)
const users = new Map();

function getOrCreateUser(userId) {
  if (!users.has(userId)) {
    users.set(userId, {
      id: userId,
      plan: 'free',
      messages_used: 0,
      reset_date: nextResetDate(),
      mp_payer_email: null,
      created_at: new Date().toISOString()
    });
  }

  const user = users.get(userId);

  // Reset mensal automático
  if (new Date() > new Date(user.reset_date)) {
    user.messages_used = 0;
    user.reset_date = nextResetDate();
    users.set(userId, user);
  }

  return user;
}

function nextResetDate() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function canSendMessage(user) {
  if (user.plan === 'pro') return true;
  return user.messages_used < FREE_LIMIT;
}

// GET /api/usage
router.get('/usage', (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(400).json({ error: 'x-user-id obrigatório' });

  const user = getOrCreateUser(userId);
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

// POST /api/checkout
router.post('/checkout', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const { plan = 'pro_monthly' } = req.body;

  if (!userId) return res.status(400).json({ error: 'x-user-id obrigatório' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MP_ACCESS_TOKEN não configurado' });

  const PLANS = {
    pro_monthly: { title: 'TaxWise Pro — Mensal', description: 'Perguntas ilimitadas', price: 19.90, currency: 'BRL' },
    pro_yearly:  { title: 'TaxWise Pro — Anual',  description: 'Perguntas ilimitadas + 2 meses grátis', price: 149.00, currency: 'BRL' }
  };

  const selectedPlan = PLANS[plan];
  if (!selectedPlan) return res.status(400).json({ error: 'Plano inválido' });

  try {
    const preference = {
      items: [{ id: plan, title: selectedPlan.title, description: selectedPlan.description, quantity: 1, currency_id: selectedPlan.currency, unit_price: selectedPlan.price }],
      external_reference: userId,
      back_urls: {
        success: `${BASE_URL}/payment/success?user=${userId}`,
        failure: `${BASE_URL}/payment/failure?user=${userId}`,
        pending: `${BASE_URL}/payment/pending?user=${userId}`
      },
      auto_return: 'approved',
      notification_url: `${BASE_URL}/api/webhook/mercadopago`,
      metadata: { user_id: userId, plan },
      payment_methods: {
        excluded_payment_types: [],
        excluded_payment_methods: [],
        installments: plan === 'pro_monthly' ? 1 : 12,
        default_payment_method_id: null
      },
      purpose: 'wallet_purchase'
    };

    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
      body: JSON.stringify(preference)
    });

    if (!mpRes.ok) {
      const err = await mpRes.json();
      return res.status(500).json({ error: 'Erro ao criar preferência', details: err });
    }

    const data = await mpRes.json();
    res.json({ checkout_url: data.init_point, sandbox_url: data.sandbox_init_point, preference_id: data.id });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/webhook/mercadopago
router.post('/webhook/mercadopago', async (req, res) => {
  res.sendStatus(200);
  const { type, data } = req.body;
  if (type !== 'payment') return;

  try {
    const paymentRes = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
    });
    if (!paymentRes.ok) return;
    const payment = await paymentRes.json();

    if (payment.status === 'approved') {
      const userId = payment.external_reference;
      if (userId) {
        const user = getOrCreateUser(userId);
        user.plan = 'pro';
        user.messages_used = 0;
        user.mp_payer_email = payment.payer?.email;
        users.set(userId, user);
        console.log(`✅ Usuário ${userId} ativado como PRO`);
      }
    }

    if (payment.status === 'cancelled' || payment.status === 'refunded') {
      const userId = payment.external_reference;
      if (userId && users.has(userId)) {
        users.get(userId).plan = 'free';
        console.log(`⬇️ Usuário ${userId} revertido para FREE`);
      }
    }
  } catch (err) {
    console.error('Erro webhook:', err.message);
  }
});

// GET /api/admin/users (debug)
router.get('/admin/users', (req, res) => {
  res.json({ total: users.size, users: Array.from(users.values()) });
});

export { router as billingRouter, getOrCreateUser, canSendMessage, users };