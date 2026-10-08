/*
 * ShopNow - 3-tier e-commerce demo for the ARM template lab
 *
 *  Web tier  : this Node.js app, running on 2 VMs behind an Azure Load Balancer
 *  Data tier : Azure SQL Database (serverless, free offer)
 *  Secrets   : SQL password is read from Azure Key Vault using the VM's
 *              managed identity (no password stored on the VM)
 *
 * Environment variables (written by cloud-init into /etc/shopnow.env):
 *   PORT          - port to listen on (default 3000)
 *   SQL_SERVER    - e.g. sql-shopnow-abc123.database.windows.net
 *   SQL_DATABASE  - e.g. shopdb
 *   SQL_USER      - SQL admin login
 *   KEYVAULT_NAME - Key Vault that holds the SQL password
 *   SECRET_NAME   - name of the secret (default sql-admin-password)
 *   SQL_PASSWORD  - (local testing only) password, skips Key Vault
 *
 * If SQL_SERVER is not set, the app runs in DEMO mode with an in-memory store,
 * so you can test it on your laptop with `npm install && npm start`.
 */

const express = require('express');
const os = require('os');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const VM_NAME = os.hostname();
const DEMO_MODE = !process.env.SQL_SERVER;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Seed catalogue (prices in INR)
// ---------------------------------------------------------------------------
const SEED_PRODUCTS = [
  { sku: 'TSHIRT-DEVOPS', name: 'DevOps Infinity T-Shirt', category: 'Apparel', price: 599, stock: 50, emoji: '👕' },
  { sku: 'HOODIE-CLOUD', name: 'Cloud Native Hoodie', category: 'Apparel', price: 1499, stock: 25, emoji: '🧥' },
  { sku: 'MUG-YAML', name: '"It works on my machine" Mug', category: 'Accessories', price: 349, stock: 80, emoji: '☕' },
  { sku: 'STICKER-PACK', name: 'Kubernetes Sticker Pack', category: 'Accessories', price: 199, stock: 200, emoji: '🏷️' },
  { sku: 'KEYBOARD-MECH', name: 'Mechanical Keyboard', category: 'Electronics', price: 3999, stock: 15, emoji: '⌨️' },
  { sku: 'MOUSE-WL', name: 'Wireless Mouse', category: 'Electronics', price: 899, stock: 40, emoji: '🖱️' },
  { sku: 'BOOK-ARM', name: 'Infrastructure as Code Handbook', category: 'Books', price: 799, stock: 30, emoji: '📘' },
  { sku: 'BAG-LAPTOP', name: 'Laptop Backpack', category: 'Accessories', price: 1899, stock: 20, emoji: '🎒' }
];

// ---------------------------------------------------------------------------
// Data layer: DEMO (in-memory) or SQL (Azure SQL Database)
// ---------------------------------------------------------------------------
let db; // set by initDemo() or initSql()
const status = { mode: DEMO_MODE ? 'demo' : 'sql', db: 'connecting', lastError: null };

function initDemo() {
  let nextOrderId = 1;
  const products = SEED_PRODUCTS.map((p, i) => ({ id: i + 1, ...p }));
  const orders = [];
  db = {
    async listProducts() { return products; },
    async createOrder(customer, email, items) {
      const lines = items.map(({ productId, quantity }) => {
        const p = products.find(x => x.id === productId);
        if (!p) throw httpError(400, `Product ${productId} not found`);
        if (p.stock < quantity) throw httpError(409, `Only ${p.stock} left of ${p.name}`);
        return { p, quantity };
      });
      lines.forEach(({ p, quantity }) => { p.stock -= quantity; });
      const total = lines.reduce((s, l) => s + l.p.price * l.quantity, 0);
      const order = { id: nextOrderId++, customer, email, total, itemCount: lines.reduce((s, l) => s + l.quantity, 0), servedBy: VM_NAME, createdAt: new Date().toISOString() };
      orders.unshift(order);
      return order;
    },
    async recentOrders() { return orders.slice(0, 10); }
  };
  status.db = 'connected (in-memory demo)';
}

// Get the SQL password from Key Vault using the VM's managed identity.
// Uses plain HTTPS calls to IMDS + Key Vault REST API (no extra SDK needed).
async function getSqlPassword() {
  if (process.env.SQL_PASSWORD) return process.env.SQL_PASSWORD; // local testing

  const kv = process.env.KEYVAULT_NAME;
  const secret = process.env.SECRET_NAME || 'sql-admin-password';

  // 1. Ask the Instance Metadata Service for a token for Key Vault
  const tokenRes = await fetch(
    'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net',
    { headers: { Metadata: 'true' } }
  );
  if (!tokenRes.ok) throw new Error(`IMDS token request failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const { access_token } = await tokenRes.json();

  // 2. Read the secret
  const secretRes = await fetch(
    `https://${kv}.vault.azure.net/secrets/${encodeURIComponent(secret)}?api-version=7.4`,
    { headers: { Authorization: `Bearer ${access_token}` } }
  );
  if (!secretRes.ok) throw new Error(`Key Vault read failed: ${secretRes.status} ${await secretRes.text()}`);
  const { value } = await secretRes.json();
  return value;
}

async function initSql() {
  const sql = require('mssql');

  const password = await getSqlPassword();
  console.log(`[${VM_NAME}] Got SQL password from ${process.env.SQL_PASSWORD ? 'env' : 'Key Vault ' + process.env.KEYVAULT_NAME}`);

  const pool = await new sql.ConnectionPool({
    server: process.env.SQL_SERVER,
    database: process.env.SQL_DATABASE || 'shopdb',
    user: process.env.SQL_USER,
    password,
    options: { encrypt: true, trustServerCertificate: false },
    // Serverless DB may be auto-paused: the first connection wakes it up (~1 min)
    connectionTimeout: 90000,
    requestTimeout: 60000,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
  }).connect();
  console.log(`[${VM_NAME}] Connected to ${process.env.SQL_SERVER}`);

  // Create schema + seed data. Both VMs start at the same time, so we take an
  // application lock to make sure only one of them does it.
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).query(`
      EXEC sp_getapplock @Resource = 'shopnow-schema', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 60000;

      IF OBJECT_ID('dbo.products') IS NULL
        CREATE TABLE dbo.products (
          id INT IDENTITY(1,1) PRIMARY KEY,
          sku NVARCHAR(50) NOT NULL UNIQUE,
          name NVARCHAR(200) NOT NULL,
          category NVARCHAR(50) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          stock INT NOT NULL,
          emoji NVARCHAR(10) NULL
        );

      IF OBJECT_ID('dbo.orders') IS NULL
        CREATE TABLE dbo.orders (
          id INT IDENTITY(1000,1) PRIMARY KEY,
          customer NVARCHAR(100) NOT NULL,
          email NVARCHAR(200) NOT NULL,
          total DECIMAL(12,2) NOT NULL,
          served_by NVARCHAR(100) NOT NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );

      IF OBJECT_ID('dbo.order_items') IS NULL
        CREATE TABLE dbo.order_items (
          id INT IDENTITY(1,1) PRIMARY KEY,
          order_id INT NOT NULL REFERENCES dbo.orders(id),
          product_id INT NOT NULL REFERENCES dbo.products(id),
          quantity INT NOT NULL,
          unit_price DECIMAL(10,2) NOT NULL
        );
    `);

    for (const p of SEED_PRODUCTS) {
      await new sql.Request(tx)
        .input('sku', sql.NVarChar, p.sku)
        .input('name', sql.NVarChar, p.name)
        .input('category', sql.NVarChar, p.category)
        .input('price', sql.Decimal(10, 2), p.price)
        .input('stock', sql.Int, p.stock)
        .input('emoji', sql.NVarChar, p.emoji)
        .query(`IF NOT EXISTS (SELECT 1 FROM dbo.products WHERE sku = @sku)
                  INSERT INTO dbo.products (sku, name, category, price, stock, emoji)
                  VALUES (@sku, @name, @category, @price, @stock, @emoji);`);
    }
    await tx.commit();
    console.log(`[${VM_NAME}] Schema ready`);
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }

  db = {
    async listProducts() {
      const r = await pool.request().query('SELECT id, sku, name, category, CAST(price AS FLOAT) AS price, stock, emoji FROM dbo.products ORDER BY id');
      return r.recordset;
    },
    async createOrder(customer, email, items) {
      const t = new sql.Transaction(pool);
      await t.begin();
      try {
        let total = 0;
        const lines = [];
        for (const { productId, quantity } of items) {
          // UPDLOCK so two VMs can't oversell the same stock
          const r = await new sql.Request(t).input('id', sql.Int, productId)
            .query('SELECT id, name, price, stock FROM dbo.products WITH (UPDLOCK, ROWLOCK) WHERE id = @id');
          const p = r.recordset[0];
          if (!p) throw httpError(400, `Product ${productId} not found`);
          if (p.stock < quantity) throw httpError(409, `Only ${p.stock} left of ${p.name}`);
          total += Number(p.price) * quantity;
          lines.push({ p, quantity });
        }
        const o = await new sql.Request(t)
          .input('customer', sql.NVarChar, customer)
          .input('email', sql.NVarChar, email)
          .input('total', sql.Decimal(12, 2), total)
          .input('servedBy', sql.NVarChar, VM_NAME)
          .query(`INSERT INTO dbo.orders (customer, email, total, served_by)
                  OUTPUT INSERTED.id, INSERTED.created_at
                  VALUES (@customer, @email, @total, @servedBy);`);
        const orderId = o.recordset[0].id;
        for (const { p, quantity } of lines) {
          await new sql.Request(t)
            .input('orderId', sql.Int, orderId).input('productId', sql.Int, p.id)
            .input('qty', sql.Int, quantity).input('price', sql.Decimal(10, 2), p.price)
            .query(`INSERT INTO dbo.order_items (order_id, product_id, quantity, unit_price) VALUES (@orderId, @productId, @qty, @price);
                    UPDATE dbo.products SET stock = stock - @qty WHERE id = @productId;`);
        }
        await t.commit();
        return { id: orderId, customer, email, total, itemCount: lines.reduce((s, l) => s + l.quantity, 0), servedBy: VM_NAME, createdAt: o.recordset[0].created_at };
      } catch (err) {
        await t.rollback().catch(() => {});
        throw err;
      }
    },
    async recentOrders() {
      const r = await pool.request().query(`
        SELECT TOP 10 o.id, o.customer, CAST(o.total AS FLOAT) AS total, o.served_by AS servedBy, o.created_at AS createdAt,
               (SELECT SUM(quantity) FROM dbo.order_items WHERE order_id = o.id) AS itemCount
        FROM dbo.orders o ORDER BY o.id DESC`);
      return r.recordset;
    }
  };
  status.db = 'connected';
  status.lastError = null;
}

// Keep retrying in the background: right after deployment the Key Vault role
// assignment can take a few minutes to propagate, and the serverless DB may be
// waking up. The web server stays up meanwhile so the LB health probe passes.
async function connectWithRetry() {
  if (DEMO_MODE) return initDemo();
  for (let attempt = 1; ; attempt++) {
    try {
      await initSql();
      return;
    } catch (err) {
      status.db = 'connecting';
      status.lastError = err.message;
      const wait = Math.min(60, 5 * attempt);
      console.error(`[${VM_NAME}] DB init attempt ${attempt} failed: ${err.message}. Retrying in ${wait}s`);
      await new Promise(r => setTimeout(r, wait * 1000));
    }
  }
}

function httpError(code, message) { const e = new Error(message); e.status = code; return e; }

function requireDb(req, res, next) {
  if (!db) return res.status(503).json({ error: 'Database is still connecting, try again in a minute', detail: status.lastError });
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Load Balancer health probe. Returns 200 as long as the web process is up.
app.get('/health', (req, res) => res.json({ status: 'ok', vm: VM_NAME }));

// Shows which VM served the request -> refresh to watch the LB at work
app.get('/api/info', (req, res) => res.json({ vm: VM_NAME, mode: status.mode, db: status.db, lastError: status.lastError, time: new Date().toISOString() }));

app.get('/api/products', requireDb, async (req, res, next) => {
  try { res.json(await db.listProducts()); } catch (e) { next(e); }
});

app.post('/api/orders', requireDb, async (req, res, next) => {
  try {
    const { customer, email, items } = req.body || {};
    if (!customer || !email || !Array.isArray(items) || items.length === 0) {
      throw httpError(400, 'customer, email and at least one item are required');
    }
    const clean = items.map(i => ({ productId: parseInt(i.productId, 10), quantity: parseInt(i.quantity, 10) }));
    if (clean.some(i => !i.productId || !i.quantity || i.quantity < 1 || i.quantity > 20)) {
      throw httpError(400, 'Each item needs a productId and a quantity between 1 and 20');
    }
    const order = await db.createOrder(String(customer).slice(0, 100), String(email).slice(0, 200), clean);
    res.status(201).json(order);
  } catch (e) { next(e); }
});

app.get('/api/orders/recent', requireDb, async (req, res, next) => {
  try { res.json(await db.recentOrders()); } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[${VM_NAME}] ShopNow listening on port ${PORT} (${DEMO_MODE ? 'DEMO in-memory mode' : 'Azure SQL mode'})`);
  connectWithRetry();
});
