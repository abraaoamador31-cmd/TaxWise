// src/server.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import { billingRouter, getOrCreateUser, canSendMessage } from './billing.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const FREE_LIMIT = parseInt(process.env.FREE_MSG_LIMIT) || 5;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('./'));
app.use('/api', billingRouter);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

  const langInstruction = lang === 'en'
    ? 'Respond in English. Include Portuguese tax terms in parentheses.'
    : 'Responda em português do Brasil.';

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: `${SYSTEM_PROMPT}\n\n${langInstruction}` },
        ...history.slice(-10),
        { role: 'user', content: message }
      ],
      stream: true,
      max_tokens: 1024,
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

  } catch (err) {
    console.error('Erro Groq:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', product: 'TaxWise', version: '1.0.0' });
});

app.listen(PORT, () => {
  console.log(`✅ TaxWise rodando em http://localhost:${PORT}`);
});