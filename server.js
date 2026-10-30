// payment-svc: owns the `payments` table. Records a payment from one wallet to
// another, asks wallet-svc to move the money, then tells notify-svc.
const express = require('express');
const { Pool } = require('pg');

const SERVICE = 'payment-svc';
const PORT = Number(process.env.PORT || 8081);
const WALLET_URL = process.env.WALLET_URL || 'http://wallet-svc:8082';
const NOTIFY_URL = process.env.NOTIFY_URL || 'http://notify-svc:8083';

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, service: SERVICE, msg, ...extra }));
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'paylab',
  user: process.env.DB_USER || 'paylab',
  password: process.env.DB_PASSWORD || 'paylab',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS payments (
          id              SERIAL PRIMARY KEY,
          reference       TEXT NOT NULL UNIQUE,
          payer_wallet_id INT NOT NULL,
          payee_wallet_id INT NOT NULL,
          amount_kobo     BIGINT NOT NULL CHECK (amount_kobo > 0),
          note            TEXT,
          status          TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
          reason          TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      log('info', 'database ready');
      return;
    } catch (err) {
      log('warn', 'database not ready, retrying in 2s', { attempt, error: err.message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('could not connect to database');
}

// Small helper for calling wallet-svc. Returns { status, data }.
async function walletApi(method, path, body) {
  const res = await fetch(WALLET_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// wallet id -> handle, from wallet-svc's directory (payment-svc doesn't own wallets).
async function handleMap() {
  try {
    const { status, data } = await walletApi('GET', '/wallets');
    if (status === 200) return new Map(data.map((w) => [w.id, w.handle]));
  } catch (err) {
    log('warn', 'could not load wallet directory', { error: err.message });
  }
  return new Map();
}

function toPayment(row, handles, forWalletId) {
  const p = {
    ...row,
    amount_kobo: Number(row.amount_kobo),
    payer_handle: handles.get(row.payer_wallet_id) || null,
    payee_handle: handles.get(row.payee_wallet_id) || null,
  };
  if (forWalletId) p.direction = row.payer_wallet_id === forWalletId ? 'sent' : 'received';
  return p;
}

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE }));

// Pay someone: { fromWalletId, toHandle | toWalletId, amountKobo, reference, note? }
app.post('/payments', async (req, res) => {
  const { fromWalletId, toHandle, toWalletId, amountKobo, reference } = req.body || {};
  const note = req.body?.note ? String(req.body.note).slice(0, 140) : null;
  if (!Number.isInteger(fromWalletId) || !Number.isInteger(amountKobo) || amountKobo <= 0 || !reference) {
    return res.status(400).json({ error: 'fromWalletId (integer), amountKobo (integer > 0) and reference are required' });
  }
  if (!toHandle && !Number.isInteger(toWalletId)) {
    return res.status(400).json({ error: 'toHandle or toWalletId is required' });
  }

  try {
    // 1. Who is paying, and who is receiving?
    const payer = await walletApi('GET', `/wallets/${fromWalletId}`);
    if (payer.status !== 200) return res.status(404).json({ error: 'payer wallet not found' });
    const payee = toHandle
      ? await walletApi('GET', `/wallets/by-handle/${encodeURIComponent(String(toHandle))}`)
      : await walletApi('GET', `/wallets/${toWalletId}`);
    if (payee.status !== 200) return res.status(404).json({ error: 'recipient not found' });
    if (payee.data.id === payer.data.id) return res.status(400).json({ error: 'you cannot pay yourself' });

    // 2. Insert as "pending". ON CONFLICT DO NOTHING makes this idempotent:
    //    a retry with the same reference never charges twice.
    const inserted = await pool.query(
      `INSERT INTO payments (reference, payer_wallet_id, payee_wallet_id, amount_kobo, note, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (reference) DO NOTHING
       RETURNING *`,
      [reference, payer.data.id, payee.data.id, amountKobo, note]
    );
    let payment = inserted.rows[0];
    if (!payment) {
      const { rows } = await pool.query('SELECT * FROM payments WHERE reference = $1', [reference]);
      payment = rows[0];
      if (payment.status !== 'pending') {
        log('info', 'duplicate reference, returning existing payment', { reference });
        return res.status(200).json(toPayment(payment, await handleMap()));
      }
      // Still pending (e.g. wallet-svc was unreachable last time): try again below.
      // That's safe because wallet-svc's /transfers is idempotent on the reference too.
    }

    // 3. Ask wallet-svc to move the money.
    let status = 'failed';
    let reason = null;
    let duplicate = false; // wallet-svc already did this transfer (a concurrent retry got there first)
    try {
      const t = await walletApi('POST', '/transfers', {
        fromWalletId: payment.payer_wallet_id,
        toWalletId: payment.payee_wallet_id,
        amountKobo: Number(payment.amount_kobo),
        reference,
      });
      if (t.status === 200 || t.status === 201) {
        status = 'success';
        duplicate = t.status === 200;
      } else {
        reason = t.data.error || `wallet-svc returned ${t.status}`;
      }
    } catch (err) {
      // We don't know if the money moved. Leave it "pending"; a retry with the same reference finishes it.
      log('error', 'wallet-svc unreachable, payment left pending', { reference, error: err.message });
      return res.status(502).json({ ...toPayment(payment, await handleMap()), reason: 'wallet service unreachable, retry with the same reference' });
    }

    // 4. Save the final status.
    const { rows } = await pool.query(
      'UPDATE payments SET status = $2, reason = $3 WHERE id = $1 RETURNING *',
      [payment.id, status, reason]
    );
    const handles = new Map([[payer.data.id, payer.data.handle], [payee.data.id, payee.data.handle]]);
    const result = toPayment(rows[0], handles);
    log(status === 'success' ? 'info' : 'warn', `payment ${status}`, { paymentId: result.id, reference, reason });

    // A concurrent retry already finished this payment: no second receipt.
    if (duplicate) return res.status(200).json(result);

    // 5. Fire-and-forget: receipts. We don't wait, and a failure here never fails the payment.
    fetch(`${NOTIFY_URL}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentId: result.id,
        reference,
        status,
        reason,
        amountKobo: result.amount_kobo,
        note,
        payer: { walletId: payer.data.id, handle: payer.data.handle },
        payee: { walletId: payee.data.id, handle: payee.data.handle },
      }),
    }).catch((err) => log('warn', 'notify-svc call failed', { error: err.message }));

    res.status(status === 'success' ? 201 : 402).json(result);
  } catch (err) {
    log('error', 'payment failed', { reference, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /payments?walletId=X -> payments where X paid or was paid, newest first.
app.get('/payments', async (req, res) => {
  const walletId = req.query.walletId ? Number(req.query.walletId) : null;
  if (req.query.walletId && !Number.isInteger(walletId)) return res.status(400).json({ error: 'walletId must be an integer' });
  try {
    const { rows } = walletId
      ? await pool.query(
          `SELECT * FROM payments WHERE payer_wallet_id = $1 OR payee_wallet_id = $1
           ORDER BY id DESC LIMIT 50`,
          [walletId]
        )
      : await pool.query('SELECT * FROM payments ORDER BY id DESC LIMIT 50');
    const handles = await handleMap();
    res.json(rows.map((r) => toPayment(r, handles, walletId)));
  } catch (err) {
    log('error', 'list payments failed', { error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/payments/:id', async (req, res) => {
  if (!/^[1-9][0-9]{0,9}$/.test(req.params.id)) return res.status(404).json({ error: 'payment not found' });
  try {
    const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'payment not found' });
    res.json(toPayment(rows[0], await handleMap()));
  } catch (err) {
    log('error', 'get payment failed', { error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

initDb()
  .then(() => app.listen(PORT, () => log('info', `listening on port ${PORT}`)))
  .catch((err) => {
    log('error', 'startup failed', { error: err.message });
    process.exit(1);
  });
