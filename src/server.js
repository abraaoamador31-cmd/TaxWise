// src/server.js
import express from 'express';
import cors from 'cors';
import { billingRouter, getOrCreateUser, canSendMessage, pool } from './billing.js';

const app = express();
const PORT = process.env.PORT || 3001;
const FREE_LIMIT = parseInt(process.env.FREE_MSG_LIMIT) || 5;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('./'));
app.use('/api', billingRouter);

console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'OK' : 'undefined');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'OK' : 'undefined');

const SYSTEM_PROMPT = `Você é o TaxWise, assistente especializado em planejamento tributário legal para profissionais autônomos brasileiros.

Você atende: médicos, advogados, psicólogos, dentistas, arquitetos, engenheiros, consultores, desenvolvedores, designers, fotógrafos, redatores e qualquer profissional autônomo.

Você domina:
- Carnê-leão e DARF (cód. 0190)
- Livro-Caixa e deduções legais por profissão
- Tabela progressiva IRPF 2024
- Comparativo PF vs MEI vs ME vs Simples Nacional
- Declaração anual (DIRPF) — simplificado vs completo
- Investimentos: ações, FIIs, cripto, renda fixa
- Previdência privada: PGBL vs VGBL

Regras:
- Sempre cite a base legal (Lei, IN RFB, artigo)
- Seja direto e prático — o usuário não é contador
- Use valores e exemplos concretos
- Ao final, sempre lembre que não substitui consultoria profissional`;

app.post('/api/chat', async (req, res) => {
  const { message, history = [], lang = 'pt' } = req.body;
  const userId = req.headers['x-user-id'];

  if (!message) return res.status(400).json({ error: 'message obrigatório' });

  if (userId) {
    try {
      const user = await getOrCreateUser(userId);
      if (!canSendMessage(user)) {
        return res.status(402).json({
          error: 'limit_reached',
          plan: user.plan,
          messages_used: user.messages_used,
          messages_limit: FREE_LIMIT
        });
      }
      if (user.plan === 'free') {
        await pool.query(
          'UPDATE users SET messages_used = messages_used + 1 WHERE id = $1',
          [userId]
        );
      }
    } catch (err) {
      console.error('Erro billing:', err.message);
      return res.status(500).json({ error: 'Erro ao verificar usuário' });
    }
  }

  const langInstruction = lang === 'en'
    ? 'Respond in English. Include Portuguese tax terms in parentheses.'
    : 'Responda em português do Brasil.';

  // Limita histórico para as últimas 10 mensagens
  const MAX_HISTORY = 10;
  const recentHistory = history.slice(-MAX_HISTORY);

  const messages = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${langInstruction}` },
    ...recentHistory.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    })),
    { role: 'user', content: message }
  ];

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // barato e eficiente
        messages,
        max_tokens: 1000
      })
    });

    const data = await response.json();
    console.log('OpenAI response:', JSON.stringify(data));

    if (!data.choices || !data.choices[0]) {
      throw new Error(data?.error?.message || 'Resposta inválida da API OpenAI');
    }

    const text = data.choices[0].message.content;
    res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

  } catch (err) {
    console.error('Erro OpenAI:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', product: 'TaxWise', version: '1.0.0' });
});

app.listen(PORT, () => {
  console.log(`✅ TaxWise rodando em http://localhost:${PORT}`);
}); 