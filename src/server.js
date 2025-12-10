import express from 'express';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

dotenv.config();

// Structured logging utility
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const logLevels = { debug: 0, info: 1, warn: 2, error: 3 };

const logger = {
  debug: (message, meta = {}) => {
    if (logLevels[LOG_LEVEL] <= 0) {
      console.log(`[DEBUG] ${message}`, Object.keys(meta).length > 0 ? meta : '');
    }
  },
  info: (message, meta = {}) => {
    if (logLevels[LOG_LEVEL] <= 1) {
      console.log(`[INFO] ${message}`, Object.keys(meta).length > 0 ? meta : '');
    }
  },
  warn: (message, meta = {}) => {
    if (logLevels[LOG_LEVEL] <= 2) {
      console.warn(`[WARN] ${message}`, Object.keys(meta).length > 0 ? meta : '');
    }
  },
  error: (message, meta = {}) => {
    if (logLevels[LOG_LEVEL] <= 3) {
      console.error(`[ERROR] ${message}`, Object.keys(meta).length > 0 ? meta : '');
    }
  }
};

const app = express();
app.use(express.json({ limit: '1mb' }));

// API key auth middleware (applied to all routes except docs/health)
function requireApiKey(req, res, next) {
  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (!provided || provided !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

// Allow docs and health without auth; everything else requires API key
app.use((req, res, next) => {
  const openPaths = ['/', '/healthz'];
  if (openPaths.includes(req.path)) return next();
  return requireApiKey(req, res, next);
});

const ROUTER_URL = process.env.ROUTER_URL || 'http://host.docker.internal:80';
const ROUTER_USER = process.env.ROUTER_USER || 'admin';
const ROUTER_PASS = process.env.ROUTER_PASS || 'admin';
const LISTEN_PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // Optional: URL to POST when new messages arrive
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '0', 10); // 0 = disabled
const API_KEY = process.env.API_KEY || 'changeme';
// Queue poll disabled by default to avoid CF KV request storms; processing is triggered on enqueue.
const QUEUE_POLL_MS = parseInt(process.env.QUEUE_POLL_MS || '0', 10);
const INBOX_CHECK_MS = parseInt(process.env.INBOX_CHECK_MS || '120000', 10); // check inbox every 120s when idle
const INBOX_WEBHOOK_URL = process.env.INBOX_WEBHOOK_URL || ''; // URL to POST when new inbox message detected
const OUTBOX_CLEAR_HOUR = parseInt(process.env.OUTBOX_CLEAR_HOUR || '3', 10); // Hour of day (0-23) to clear outbox, default 3am

// Track last known inbox message count for polling
let lastInboxCount = null;
let browserBusy = false; // Lock for browser operations
let inboxCheckAbort = false; // Signal to abort inbox check
let lastInboxCheck = null; // Last inbox check result
let lastOutboxClearDate = null; // Track last outbox clear date
let busyReason = null; // Track what the browser is doing

// ============================================================================
// JOB QUEUE SYSTEM - Proper sequential processing with locking
// ============================================================================
const jobQueue = {
  processing: false,        // Is the queue processor running?
  currentJob: null,         // Currently processing job ID
  pendingJobs: [],          // In-memory queue of job IDs to process
  processPromise: null,     // Promise for current processing cycle
};

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000; // 5 seconds between retries
const JOB_TIMEOUT_MS = 120000; // 2 minutes max per job

// Watchdog and health monitoring
let watchdogStats = {
  lastSuccessfulSend: null,
  lastSuccessfulOperation: null,
  consecutiveFailures: 0,
  totalOperations: 0,
  browserRecreations: 0,
  stuckOperations: 0,
  startTime: new Date().toISOString()
};

let operationTimeouts = new Map(); // Track ongoing operations with timeouts
const OPERATION_TIMEOUT = 180000; // 3 minutes max for any operation
const MAX_CONSECUTIVE_FAILURES = 5;
const WATCHDOG_CHECK_INTERVAL = 30000; // 30 seconds

// Browser management for resilience
let browserPromise = null;
let browserInstanceId = 0;
let browserUsageCount = 0;
const MAX_BROWSER_USAGE = 20; // Recreate browser after N operations
const BROWSER_TIMEOUT = 120000; // 2 minutes browser timeout
const SMS_SEND_TIMEOUT = 120000; // 2 minutes SMS timeout

// Browser pool for better resource management
const getBrowser = async () => {
  logger.debug('Getting browser instance');
  
  if (!browserPromise) {
    logger.info('Creating new browser instance');
    browserPromise = createFreshBrowser();
  } else {
    logger.debug('Reusing existing browser');
  }
  
  try {
    const browser = await browserPromise;
    logger.debug('Browser ready');
    
    if (!browser.isConnected()) {
      logger.error('Browser disconnected, recreating');
      throw new Error('Browser disconnected');
    }
    
    return browser;
  } catch (err) {
    logger.warn('Browser failed, recreating', { error: err.message });
    browserPromise = null;
    return await (browserPromise = createFreshBrowser());
  }
};

const createFreshBrowser = async () => {
  const instanceId = ++browserInstanceId;
  logger.info('Creating browser instance', { instanceId });
  
  try {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    
    logger.info('Browser instance created successfully', { instanceId });
    
    browser.on('disconnected', () => {
      logger.info('Browser instance disconnected', { instanceId });
      browserPromise = null;
    });
    
    browserUsageCount = 0;
    return browser;
  } catch (err) {
    logger.error('Failed to create browser instance', { instanceId, error: err.message });
    throw err;
  }
};

// Recreate browser if it's been used too many times
const maybeRecreateBrowser = async () => {
  browserUsageCount++;
  if (browserUsageCount >= MAX_BROWSER_USAGE) {
    logger.info('Recreating browser for freshness', { usageCount: browserUsageCount, maxUsage: MAX_BROWSER_USAGE });
    try {
      const browser = await browserPromise;
      await browser.close();
    } catch (err) {
      logger.warn('Error closing old browser', { error: err.message });
    }
    browserPromise = null;
    browserUsageCount = 0;
  }
};

// Force browser recreation
const recreateBrowser = async () => {
  logger.warn('Force recreating browser due to error');
  watchdogStats.browserRecreations++;
  try {
    if (browserPromise) {
      const browser = await browserPromise;
      await browser.close();
    }
  } catch (err) {
    logger.warn('Error closing browser during recreation', { error: err.message });
  }
  browserPromise = null;
  browserUsageCount = 0;
};

// Watchdog monitoring and recovery system
const startWatchdog = () => {
  setInterval(async () => {
    try {
      await checkSystemHealth();
    } catch (err) {
      logger.error('Watchdog check failed', { error: err.message });
    }
  }, WATCHDOG_CHECK_INTERVAL);
};

const checkSystemHealth = async () => {
  const now = new Date();
  const uptime = now - new Date(watchdogStats.startTime);
  
  logger.debug('Watchdog check', {
    uptimeMinutes: Math.floor(uptime/60000),
    totalOperations: watchdogStats.totalOperations,
    consecutiveFailures: watchdogStats.consecutiveFailures,
    browserRecreations: watchdogStats.browserRecreations
  });
  
  for (const [operationId, startTime] of operationTimeouts.entries()) {
    if (now - startTime > OPERATION_TIMEOUT) {
      logger.warn('Watchdog detected stuck operation, forcing recovery', { operationId });
      watchdogStats.stuckOperations++;
      await forceRecovery();
      operationTimeouts.delete(operationId);
    }
  }
  
  if (watchdogStats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    logger.warn('Watchdog detected consecutive failures, forcing browser recreation', { 
      failures: watchdogStats.consecutiveFailures 
    });
    await recreateBrowser();
    watchdogStats.consecutiveFailures = 0;
  }
  
  if (browserBusy && operationTimeouts.size > 0) {
    let oldestStart = null;
    for (const [opId, startTime] of operationTimeouts.entries()) {
      if (!oldestStart || startTime < oldestStart) {
        oldestStart = startTime;
      }
    }
    if (oldestStart && (now - oldestStart) > OPERATION_TIMEOUT) {
      logger.warn('Watchdog detected operation stuck too long, forcing recovery');
      await forceRecovery();
    }
  }
};

const forceRecovery = async () => {
  logger.info('Force recovery: resetting browser state');
  try {
    operationTimeouts.clear();
    await recreateBrowser();
    browserBusy = false;
    queueProcessing = false;
    busyReason = null;
    watchdogStats.consecutiveFailures = 0;
    logger.info('Force recovery completed');
  } catch (err) {
    logger.error('Force recovery failed', { error: err.message });
  }
};

const recordOperationStart = (operationType) => {
  const operationId = `${operationType}-${Date.now()}`;
  operationTimeouts.set(operationId, new Date());
  watchdogStats.totalOperations++;
  return operationId;
};

const recordOperationSuccess = (operationId, operationType) => {
  operationTimeouts.delete(operationId);
  watchdogStats.lastSuccessfulOperation = new Date().toISOString();
  watchdogStats.consecutiveFailures = 0;
  
  if (operationType === 'sms') {
    watchdogStats.lastSuccessfulSend = new Date().toISOString();
  }
};

const recordOperationFailure = (operationId, error) => {
  operationTimeouts.delete(operationId);
  watchdogStats.consecutiveFailures++;
  logger.warn('Operation failed', { 
    error: error.message, 
    consecutiveFailures: watchdogStats.consecutiveFailures 
  });
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Helper to check if browser is busy and refuse if so
function requireBrowserFree() {
  if (browserBusy) {
    const detail = busyReason ? ` (${busyReason})` : '';
    const err = new Error(`Server busy - another operation is in progress${detail}`);
    err.statusCode = 503;
    throw err;
  }
}

function markBusy(reason) {
  browserBusy = true;
  busyReason = reason;
}

function clearBusy() {
  browserBusy = false;
  busyReason = null;
}


// Initialize SQLite database
let db = null;
const DB_PATH = process.env.DB_PATH || './smsauto.db';

const initDb = async () => {
  if (db) return db;
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });
  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sms (
      id TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL,
      sent_at TEXT,
      updated_at TEXT NOT NULL,
      retry_count INTEGER DEFAULT 0,
      last_error TEXT,
      locked_at TEXT,
      locked_by TEXT
    );
    CREATE TABLE IF NOT EXISTS inbox_status (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  
  // Add columns if they don't exist (migration for existing DBs)
  try {
    await db.exec(`ALTER TABLE sms ADD COLUMN retry_count INTEGER DEFAULT 0`);
  } catch (e) { /* column exists */ }
  try {
    await db.exec(`ALTER TABLE sms ADD COLUMN last_error TEXT`);
  } catch (e) { /* column exists */ }
  try {
    await db.exec(`ALTER TABLE sms ADD COLUMN locked_at TEXT`);
  } catch (e) { /* column exists */ }
  try {
    await db.exec(`ALTER TABLE sms ADD COLUMN locked_by TEXT`);
  } catch (e) { /* column exists */ }
  
  // On startup, unlock any jobs that were locked (crashed mid-process)
  const stuckJobs = await db.run(
    `UPDATE sms SET status = 'queued', locked_at = NULL, locked_by = NULL 
     WHERE status = 'sending' AND locked_at IS NOT NULL`
  );
  if (stuckJobs.changes > 0) {
    console.log(`🔓 Recovered ${stuckJobs.changes} stuck jobs from previous run`);
  }
  return db;
};

// SQLite helpers
async function dbPutSms(record) {
  const db = await initDb();
  await db.run(
    `INSERT OR REPLACE INTO sms (id, recipient, message, status, created_at, sent_at, updated_at, retry_count, last_error, locked_at, locked_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id, 
      record.recipient, 
      record.message, 
      record.status, 
      record.createdAt || record.created_at, 
      record.sentAt || null, 
      new Date().toISOString(),
      record.retryCount || 0,
      record.lastError || null,
      record.lockedAt || null,
      record.lockedBy || null
    ]
  );
}

async function dbGetSms(id) {
  const db = await initDb();
  const row = await db.get('SELECT * FROM sms WHERE id = ?', [id]);
  if (!row) return null;
  return {
    id: row.id,
    to: row.recipient,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    retryCount: row.retry_count || 0,
    lastError: row.last_error,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by
  };
}

async function dbListPendingSms() {
  const db = await initDb();
  // Only get unlocked queued messages, ordered by creation time
  const rows = await db.all(
    `SELECT * FROM sms 
     WHERE status = 'queued' AND (locked_at IS NULL OR locked_at < datetime('now', '-2 minutes'))
     ORDER BY created_at ASC`
  );
  return rows.map(row => ({
    id: row.id,
    to: row.recipient,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    retryCount: row.retry_count || 0,
    lastError: row.last_error
  }));
}

async function dbPutInboxStatus(key, value) {
  const db = await initDb();
  await db.run(
    `INSERT OR REPLACE INTO inbox_status (key, value) VALUES (?, ?)`,
    [key, JSON.stringify(value)]
  );
}

async function dbGetInboxStatus(key) {
  const db = await initDb();
  const row = await db.get('SELECT value FROM inbox_status WHERE key = ?', [key]);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

async function enqueueSms({ to, text, id }) {
  if (!to || !text) throw new Error('to and text are required');
  const msgId = id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id: msgId,
    recipient: to,
    message: text,
    status: 'queued',
    createdAt: new Date().toISOString(),
    sentAt: null,
    retryCount: 0,
    lastError: null,
    lockedAt: null,
    lockedBy: null
  };
  await dbPutSms(record);
  
  if (!jobQueue.pendingJobs.includes(msgId)) {
    jobQueue.pendingJobs.push(msgId);
  }
  
  logger.info('SMS enqueued', { messageId: msgId, recipient: to });
  
  triggerQueueProcessing();
  
  return { id: msgId, to, message: text, status: 'queued' };
}

async function updateSmsRecord(id, updates) {
  const dbConn = await initDb();
  const rawRecord = await dbConn.get('SELECT * FROM sms WHERE id = ?', [id]);
  
  if (!rawRecord) {
    throw new Error('SMS record not found');
  }
  
  const recordForDb = {
    id: rawRecord.id,
    recipient: rawRecord.recipient,
    message: rawRecord.message,
    status: updates.status !== undefined ? updates.status : rawRecord.status,
    createdAt: rawRecord.created_at,
    sentAt: updates.sentAt !== undefined ? updates.sentAt : rawRecord.sent_at,
    retryCount: updates.retryCount !== undefined ? updates.retryCount : (rawRecord.retry_count || 0),
    lastError: updates.lastError !== undefined ? updates.lastError : rawRecord.last_error,
    lockedAt: updates.lockedAt !== undefined ? updates.lockedAt : rawRecord.locked_at,
    lockedBy: updates.lockedBy !== undefined ? updates.lockedBy : rawRecord.locked_by
  };
  
  await dbPutSms(recordForDb);
  return recordForDb;
}

// ============================================================================
// QUEUE PROCESSING - Sequential job execution with proper locking
// ============================================================================

/**
 * Trigger queue processing. Safe to call multiple times - will only start
 * one processing loop.
 */
function triggerQueueProcessing() {
  if (jobQueue.processing) {
    logger.debug('Queue processor already running');
    return;
  }
  
  jobQueue.processPromise = processQueueLoop();
}

/**
 * Main queue processing loop. Processes jobs one at a time until queue is empty.
 */
async function processQueueLoop() {
  if (jobQueue.processing) return;
  
  jobQueue.processing = true;
  logger.info('Queue processor started');
  
  try {
    while (true) {
      if (browserBusy && busyReason !== 'sending SMS') {
        logger.debug('Waiting for browser', { reason: busyReason });
        await delay(1000);
        continue;
      }
      
      const job = await acquireNextJob();
      
      if (!job) {
        logger.debug('No more jobs in queue');
        break;
      }
      
      await processJob(job);
      await delay(2000);
    }
  } catch (err) {
    logger.error('Queue processor error', { error: err.message });
  } finally {
    jobQueue.processing = false;
    jobQueue.currentJob = null;
    logger.info('Queue processor stopped');
  }
}

/**
 * Acquire and lock the next available job.
 * Returns null if no jobs available.
 */
async function acquireNextJob() {
  const dbConn = await initDb();
  const lockId = `worker-${Date.now()}`;
  const now = new Date().toISOString();
  
  // Try to atomically lock a job
  // Only lock jobs that are queued and not locked (or lock expired)
  const result = await dbConn.run(
    `UPDATE sms 
     SET status = 'sending', locked_at = ?, locked_by = ?
     WHERE id = (
       SELECT id FROM sms 
       WHERE status = 'queued' 
         AND (locked_at IS NULL OR locked_at < datetime('now', '-2 minutes'))
         AND retry_count < ?
       ORDER BY created_at ASC 
       LIMIT 1
     )`,
    [now, lockId, MAX_RETRIES]
  );
  
  if (result.changes === 0) {
    return null;
  }
  
  // Fetch the job we just locked
  const job = await dbConn.get(
    `SELECT * FROM sms WHERE locked_by = ? AND status = 'sending'`,
    [lockId]
  );
  
  if (!job) {
    return null;
  }
  
  jobQueue.currentJob = job.id;
  
  logger.info('Job acquired', { 
    jobId: job.id, 
    attempt: (job.retry_count || 0) + 1, 
    maxRetries: MAX_RETRIES 
  });
  
  return {
    id: job.id,
    to: job.recipient,
    message: job.message,
    retryCount: job.retry_count || 0,
    lockId
  };
}

/**
 * Process a single job with timeout and error handling.
 */
async function processJob(job) {
  const { id, to, message, retryCount, lockId } = job;
  
  logger.info('Processing job', { jobId: id, recipient: to });
  
  try {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Job timeout')), JOB_TIMEOUT_MS);
    });
    
    const result = await Promise.race([
      sendSmsForJob({ to, text: message }),
      timeoutPromise
    ]);
    
    if (result.ok) {
      await updateSmsRecord(id, {
        status: 'sent',
        sentAt: new Date().toISOString(),
        lockedAt: null,
        lockedBy: null,
        lastError: null
      });
      logger.info('Job completed successfully', { jobId: id });
    } else {
      throw new Error(result.error || 'Send failed');
    }
    
  } catch (err) {
    logger.error('Job failed', { jobId: id, error: err.message });
    
    const newRetryCount = retryCount + 1;
    
    if (newRetryCount >= MAX_RETRIES) {
      await updateSmsRecord(id, {
        status: 'failed',
        retryCount: newRetryCount,
        lastError: err.message,
        lockedAt: null,
        lockedBy: null
      });
      logger.error('Job permanently failed', { jobId: id, attempts: newRetryCount });
    } else {
      await updateSmsRecord(id, {
        status: 'queued',
        retryCount: newRetryCount,
        lastError: err.message,
        lockedAt: null,
        lockedBy: null
      });
      logger.info('Job requeued for retry', { jobId: id, attempt: newRetryCount + 1, maxRetries: MAX_RETRIES });
      
      await delay(RETRY_DELAY_MS);
    }
    
    if (err.message.includes('crashed') || 
        err.message.includes('Target closed') ||
        err.message.includes('disconnected') ||
        err.message.includes('timeout')) {
      logger.info('Browser issue detected, recreating');
      await recreateBrowser();
    }
  } finally {
    jobQueue.currentJob = null;
  }
}

/**
 * Send SMS for a job - simplified version without internal retries
 * (retries are handled at the job level)
 */
async function sendSmsForJob({ to, text }) {
  const sanitizedText = text.replace(/:/g, '-');
  
  logger.info('Sending SMS', { recipient: to });
  
  markBusy('sending SMS');
  const operationId = recordOperationStart('sms');
  
  let page = null;
  
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    page.setDefaultTimeout(30000);
    
    await page.goto(ROUTER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    await page.waitForSelector('#tbarouter_username', { timeout: 10000 });
    await page.fill('#tbarouter_username', 'admin');
    await page.fill('#tbarouter_password', 'admin');
    await page.click('input[type="button"]');
    
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await delay(1000);
    
    await page.click('a:has-text("SMS")');
    await delay(2000);
    
    await page.getByRole('button', { name: 'New' }).click();
    await page.waitForSelector('#txtNumberList', { timeout: 10000 });
    
    await page.fill('#txtNumberList', to);
    await page.fill('#txtSmsContent', sanitizedText);
    
    let dialogMessage = null;
    page.once('dialog', async dialog => {
      dialogMessage = dialog.message();
      await dialog.accept();
    });
    
    await page.getByRole('button', { name: 'Send' }).click();
    await delay(3000);
    
    recordOperationSuccess(operationId, 'sms');
    
    return { ok: true, dialog: dialogMessage };
    
  } catch (err) {
    recordOperationFailure(operationId, err);
    return { ok: false, error: err.message };
    
  } finally {
    if (page) {
      try { await page.close(); } catch (e) {}
    }
    clearBusy();
  }
}

/**
 * Get queue statistics
 */
async function getQueueStats() {
  const dbConn = await initDb();
  
  const stats = await dbConn.get(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
      SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) as sending,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM sms
  `);
  
  return {
    ...stats,
    processing: jobQueue.processing,
    currentJob: jobQueue.currentJob
  };
}

/**
 * Check inbox when idle and store last message info in SQLite.
 * Can be aborted if SMS send request comes in.
 */
async function checkInboxWhenIdle() {
  if (browserBusy || jobQueue.processing) return;

  logger.debug('Checking inbox for new messages');
  inboxCheckAbort = false;

  try {
    markBusy('checking inbox');
    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
      await loginAndNavigateToTab(page, 'Local Inbox');

      if (inboxCheckAbort) {
        logger.debug('Inbox check aborted - SMS send requested');
        return;
      }

      await page.waitForSelector('table', { timeout: 10000 });
      const firstMessage = await page.evaluate(() => {
        const trs = document.querySelectorAll('table tbody tr');
        if (trs.length === 0) return null;
        const tr = trs[0];
        const cells = tr.querySelectorAll('td');
        if (cells.length < 4) return null;
        return {
          from: cells[0]?.innerText?.trim() || '',
          content: cells[1]?.innerText?.trim() || '',
          time: cells[2]?.innerText?.trim() || '',
        };
      });

      if (inboxCheckAbort) {
        logger.debug('Inbox check aborted - SMS send requested');
        return;
      }

      const checkedAt = new Date().toISOString();

      if (firstMessage) {
        const msgHash = Buffer.from(
          `${firstMessage.from}|${firstMessage.content}|${firstMessage.time}`
        ).toString('base64');

        let previousHash = null;
        try {
          previousHash = await dbGetInboxStatus('lastHash');
        } catch (e) {
          // Key doesn't exist yet
        }

        const isNew = previousHash !== msgHash;

        await dbPutInboxStatus('lastHash', msgHash);
        await dbPutInboxStatus('lastCheck', {
          lastMessage: firstMessage,
          checkedAt,
          isNew,
        });

        lastInboxCheck = {
          lastMessage: firstMessage,
          checkedAt,
          isNew,
        };

        logger.info('Inbox check complete', {
          from: firstMessage.from,
          time: firstMessage.time,
          isNew
        });

        if (isNew && INBOX_WEBHOOK_URL) {
          try {
            await fetch(INBOX_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                event: 'new_inbox_message',
                message: firstMessage,
                checkedAt,
              }),
            });
            logger.info('Inbox webhook fired successfully');
          } catch (webhookErr) {
            logger.error('Inbox webhook failed', { error: webhookErr.message });
          }
        }
      } else {
        lastInboxCheck = { lastMessage: null, checkedAt, isNew: false };
        logger.debug('Inbox check complete - No messages');
      }
    } finally {
      await page.close();
    }
  } catch (err) {
    logger.error('Inbox check error', { error: err.message });
  } finally {
    clearBusy();
  }
}

/**
 * Clear outbox once per day at configured hour when idle.
 */
async function maybeClearOutboxDaily() {
  if (browserBusy || jobQueue.processing) return;

  const now = new Date();
  const todayDate = now.toISOString().split('T')[0];
  const currentHour = now.getUTCHours();

  if (lastOutboxClearDate === todayDate) return;
  if (currentHour !== OUTBOX_CLEAR_HOUR) return;

  try {
    const pendingMessages = await dbListPendingSms();
    if (pendingMessages.length > 0) {
      return;
    }
  } catch (err) {
    logger.error('Error checking queue before outbox clear', { error: err.message });
    return;
  }

  if (browserBusy) return;

  logger.info('Daily outbox clear starting');

  try {
    const result = await clearMessages('outbox');
    lastOutboxClearDate = todayDate;
    logger.info('Daily outbox clear complete', { clearedMessages: result.cleared });
  } catch (err) {
    logger.error('Daily outbox clear failed', { error: err.message });
  }
}

/**
 * Shared helper: login and navigate to SMS tab, then click a specific sub-tab.
 * @param {import('playwright').Page} page
 * @param {'Local Inbox'|'SIM Inbox'|'Outbox'|'SMS Settings'} tabName
 */
async function loginAndNavigateToTab(page, tabName) {
  page.setDefaultTimeout(30000);

  logger.debug('Navigating to router', { url: ROUTER_URL });
  await page.goto(ROUTER_URL, { waitUntil: 'networkidle', timeout: 30000 });

  const hasLoginForm = await page.$('#tbarouter_username');
  if (hasLoginForm) {
    logger.debug('Logging into router');
    await page.fill('#tbarouter_username', ROUTER_USER);
    await page.fill('#tbarouter_password', ROUTER_PASS);
    await page.click('input[type="button"]');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await delay(2000);
  }

  logger.debug('Navigating to SMS section');
  await page.click('a:has-text("SMS")');
  await delay(2000);

  logger.debug('Clicking tab', { tabName });
  await page.click(`a:has-text("${tabName}")`);
  await delay(1500);
}

/**
 * Read messages from inbox or outbox.
 * @param {'inbox'|'outbox'} box
 * @returns {Promise<{messages: Array, scrapedAt: string}>}
 */
async function readMessages(box) {
  requireBrowserFree();
  markBusy(`reading ${box}`);
  
  let browser = null;
  let page = null;
  
  try {
    browser = await getBrowser();
    page = await browser.newPage();
    
    const tabName = box === 'inbox' ? 'Local Inbox' : 'Outbox';
    await loginAndNavigateToTab(page, tabName);

    const messages = [];
    let currentPage = 1;
    let hasMore = true;

    while (hasMore) {
      // Wait for table
      await page.waitForSelector('table', { timeout: 10000 });

      // Scrape rows from tbody
      const rows = await page.evaluate(() => {
        const trs = document.querySelectorAll('table tbody tr');
        return Array.from(trs).map((tr) => {
          const cells = tr.querySelectorAll('td');
          if (cells.length < 4) return null;
          return {
            contact: cells[0]?.innerText?.trim() || '',
            subject: cells[1]?.innerText?.trim() || '',
            time: cells[2]?.innerText?.trim() || '',
            status: cells[3]?.querySelector('img')?.alt || cells[3]?.innerText?.trim() || '',
          };
        }).filter(Boolean);
      });

      (rows || []).forEach((msg) => messages.push({ ...msg, box, page: currentPage }));

      // Check for pagination
      const pageLinks = await page.evaluate(() => document.querySelectorAll('a[href="##"]').length);
      if (pageLinks > 1 && currentPage < 10) {
        // Try to click next page
        const nextPageLink = await page.$(`a[href="##"]:nth-child(${currentPage + 2})`);
        if (nextPageLink) {
          await nextPageLink.click();
          await delay(1000);
          currentPage++;
        } else {
          hasMore = false;
        }
      } else {
        hasMore = false;
      }
    }

    return { messages, scrapedAt: new Date().toISOString() };
  } catch (err) {
    console.error(`Error reading ${box}:`, err.message);
    
    // If this was a browser crash, recreate browser
    if (err.message.includes('crashed') || 
        err.message.includes('Target closed') ||
        err.message.includes('disconnected')) {
      console.log('Browser crashed during read, recreating...');
      await recreateBrowser();
    }
    
    throw err;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (_) {}
    }
    clearBusy();
    await maybeRecreateBrowser();
  }
}

/**
 * Clear all messages from inbox or outbox.
 * @param {'inbox'|'outbox'} box
 * @returns {Promise<{ok: boolean, cleared: number, dialog?: string}>}
 */
async function clearMessages(box) {
  requireBrowserFree();
  markBusy(`clearing ${box}`);
  
  let browser = null;
  let page = null;
  
  try {
    browser = await getBrowser();
    page = await browser.newPage();
    
    const tabName = box === 'inbox' ? 'Local Inbox' : 'Outbox';
    await loginAndNavigateToTab(page, tabName);

    let totalCleared = 0;
    let dialogMessage = null;

    // Loop through pages until no messages remain
    while (true) {
      await page.waitForSelector('table', { timeout: 10000 });

      // Count rows
      const rowCount = await page.evaluate(() => document.querySelectorAll('table tbody tr').length);
      console.log(`Found ${rowCount} rows in ${box}`);
      if (rowCount === 0) break;

      // Click select-all checkbox - try multiple selectors
      let selectAllClicked = false;
      const selectAll = await page.$('#deleteAllSms');
      if (selectAll) {
        console.log('Found #deleteAllSms checkbox, clicking');
        await selectAll.click();
        selectAllClicked = true;
      } else {
        // Try header checkbox by looking for checkbox in last column header
        const headerCheckboxes = await page.$$('table th input[type="checkbox"]');
        console.log(`Found ${headerCheckboxes.length} header checkboxes`);
        if (headerCheckboxes.length > 0) {
          await headerCheckboxes[0].click();
          selectAllClicked = true;
        }
      }
      if (!selectAllClicked) {
        console.log('Could not find select-all checkbox');
        break;
      }
      await delay(2000);

      // Wait for Delete button to appear and click it
      // The button appears dynamically after selection - try multiple selectors
      let deleteBtn = null;
      for (let attempt = 0; attempt < 15; attempt++) {
        // Try <button> elements
        const buttons = await page.$$('button');
        for (const btn of buttons) {
          const text = await btn.evaluate((el) => el.innerText?.trim() || '');
          if (text.includes('Delete')) {
            deleteBtn = btn;
            break;
          }
        }
        if (deleteBtn) break;

        // Try input[type="button"] elements
        const inputBtns = await page.$$('input[type="button"]');
        for (const btn of inputBtns) {
          const val = await btn.evaluate((el) => el.value?.trim() || '');
          if (val.includes('Delete')) {
            deleteBtn = btn;
            break;
          }
        }
        if (deleteBtn) break;

        await delay(1000);
      }
      
      const btnCount = await page.evaluate(() => document.querySelectorAll('button').length);
      const inputBtnCount = await page.evaluate(() => document.querySelectorAll('input[type="button"]').length);
      console.log(`Buttons: ${btnCount}, Input buttons: ${inputBtnCount}`);
      
      if (!deleteBtn) {
        console.log('Delete button not found after selecting');
        break;
      }
      console.log('Found Delete button, clicking');

      // Handle confirm dialog
      const dialogPromise = new Promise((resolve) => {
        const handler = async (dialog) => {
          dialogMessage = dialog.message();
          await dialog.accept();
          page.off('dialog', handler);
          resolve();
        };
        page.on('dialog', handler);
        setTimeout(() => resolve(), 5000);
      });

      await deleteBtn.click();
      await dialogPromise;
      await delay(2000);

      totalCleared += rowCount;

      // Check if more pages/messages remain
      const newRowCount = await page.evaluate(() => document.querySelectorAll('table tbody tr').length).catch(() => 0);
      if (newRowCount === 0) {
        // Check for pagination
        const pageLinks = await page.evaluate(() => document.querySelectorAll('a[href="##"]').length);
        if (pageLinks <= 1) break;
      }
    }

    return { ok: true, cleared: totalCleared, dialog: dialogMessage };
  } catch (err) {
    console.error(`Error clearing ${box}:`, err.message);
    
    // If this was a browser crash, recreate browser
    if (err.message.includes('crashed') || 
        err.message.includes('Target closed') ||
        err.message.includes('disconnected')) {
      console.log('Browser crashed during clear, recreating...');
      await recreateBrowser();
    }
    
    throw err;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (_) {}
    }
    clearBusy();
    await maybeRecreateBrowser();
  }
}

/**
 * Capture a screenshot of the current browser state. If no page exists, opens the router URL.
 * @returns {Promise<{image: string, format: 'png'}>}
 */
async function captureScreenshot() {
  requireBrowserFree();
  markBusy('screenshot');
  try {
    const browser = await getBrowser();
    // Playwright: get pages from default context
    const contexts = browser.contexts();
    let page = null;
    let createdTempPage = false;
    
    if (contexts.length > 0) {
      const pages = contexts[0].pages();
      page = pages.find((p) => !p.isClosed());
    }

    if (!page) {
      page = await browser.newPage();
      createdTempPage = true;
    }

    const isBlank = page.url() === 'about:blank';
    if (isBlank) {
      try {
        await page.goto(ROUTER_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (err) {
        console.warn('Failed to navigate before screenshot:', err.message);
      }
    }

    const buffer = await page.screenshot({ fullPage: true });
    const image = buffer.toString('base64');

    if (createdTempPage) {
      await page.close();
    }

    return { image, format: 'png' };
  } finally {
    clearBusy();
  }
}

async function sendSms({ to, text }) {
  // Sanitize text - replace ':' which may be filtered by some carriers
  const sanitizedText = text.replace(/:/g, '-');
  
  console.log(`🚀 Starting SMS send to ${to} with text: "${sanitizedText.substring(0, 50)}${sanitizedText.length > 50 ? '...' : ''}"`);
  
  markBusy('sending SMS');
  const operationId = recordOperationStart('sms');
  console.log(`📊 Operation ${operationId} started`);
  
  return Promise.race([
    (async () => {
      let browser = null;
      let page = null;
      let attempt = 0;
      const maxAttempts = 3;
      
      while (attempt < maxAttempts) {
        attempt++;
        console.log(`🔄 Attempt ${attempt}/${maxAttempts} to send SMS`);
        
        try {
          console.log(`📡 Getting browser...`);
          browser = await getBrowser();
          console.log(`✅ Browser ready`);
          
          console.log(`📄 Creating new page...`);
          page = await browser.newPage();
          page.setDefaultTimeout(30000);
          console.log(`✅ Page created`);
          
          // Navigate to router
          console.log(`🌐 Navigating to router...`);
          await page.goto(ROUTER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
          console.log(`✅ Router page loaded`);

          // Login
          console.log(`🔐 Logging in...`);
          await page.waitForSelector('#tbarouter_username', { timeout: 10000 });
          await page.fill('#tbarouter_username', 'admin');
          await page.fill('#tbarouter_password', 'admin');
          await page.click('input[type="button"]');
          console.log(`✅ Login submitted`);
          
          // Wait for dashboard
          await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
          await delay(1000);
          console.log(`✅ Dashboard loaded`);
          
          // Click SMS link
          console.log(`📱 Clicking SMS...`);
          await page.click('a:has-text("SMS")');
          await delay(2000);
          console.log(`✅ SMS section opened`);
          
          // Click New button
          console.log(`📝 Clicking New...`);
          await page.getByRole('button', { name: 'New' }).click();
          await page.waitForSelector('#txtNumberList', { timeout: 10000 });
          console.log(`✅ Compose form ready`);

          // Fill recipient
          console.log(`📤 Filling recipient: ${to}`);
          await page.fill('#txtNumberList', to);

          // Fill message (use sanitized text)
          console.log(`💬 Filling message...`);
          await page.fill('#txtSmsContent', sanitizedText);

          // Handle dialog and click Send
          console.log(`📨 Sending...`);
          
          let dialogMessage = null;
          page.once('dialog', async dialog => {
            dialogMessage = dialog.message();
            console.log(`🗣️ Dialog: "${dialogMessage}"`);
            await dialog.accept();
          });
          
          await page.getByRole('button', { name: 'Send' }).click();
          await delay(3000); // Wait for dialog
          
          console.log(`✅ SMS sent successfully!`);
          recordOperationSuccess(operationId, 'sms');
          
          // Cleanup
          await page.close();
          clearBusy();
          
          return { ok: true, dialog: dialogMessage };
          
        } catch (err) {
          console.error(`❌ Attempt ${attempt} failed:`, err.message);
          recordOperationFailure(operationId, err);
          
          if (page) {
            try { await page.close(); } catch (e) {}
          }
          
          if (attempt === maxAttempts) {
            console.error(`🚨 All attempts failed for ${to}`);
            clearBusy();
            return { ok: false, error: err.message, attempts: attempt };
          }
          
          console.log(`⏳ Retrying in ${2000 * attempt}ms...`);
          await delay(2000 * attempt);
        }
      }
      
      throw new Error('All SMS attempts failed');
    })(),
    (async () => {
      await delay(SMS_SEND_TIMEOUT);
      recordOperationFailure(operationId, new Error('Timeout'));
      throw new Error(`SMS timed out after ${SMS_SEND_TIMEOUT}ms`);
    })()
  ]);
}

// Shared send handler for /send-sms and /send
async function handleSend(req, res) {
  const { to, text } = req.body;
  if (!to || !text) {
    return res.status(400).json({ error: 'to and text are required' });
  }
  let queued = null;

  // Helper to send immediately (bypassing CF queue) when rate limited or CF unavailable
  const sendDirect = async (reason = 'direct') => {
    try {
      requireBrowserFree();
      const result = await sendSms({ to, text });
      const status = result.ok ? 'sent' : 'failed';
      return res.status(200).json({
        id: queued?.id || null,
        status,
        mode: reason,
        dialog: result.dialog || null,
      });
    } catch (fallbackErr) {
      return res.status(500).json({ error: fallbackErr.message, mode: reason });
    }
  };

  try {
    // Signal abort to any running inbox check
    inboxCheckAbort = true;
    // enqueueSms now triggers processing automatically
    queued = await enqueueSms({ to, text });
    const statusUrl = `/send/${queued.id}`;
    return res.status(202).json({ id: queued.id, status: 'queued', statusUrl, mode: 'queued' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// POST /send-sms - enqueue SMS and return status URL (non-blocking)
app.post('/send-sms', handleSend);

// Alias: POST /send
app.post('/send', handleSend);

// GET /send/:id - check status of a queued/sent SMS
app.get('/send/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const record = await dbGetSms(id);
    if (!record) {
      return res.status(404).json({ error: 'SMS not found' });
    }
    res.json({
      id,
      to: record.to,
      message: record.message,
      status: record.status,
      createdAt: record.createdAt,
      sentAt: record.sentAt,
      retryCount: record.retryCount,
      lastError: record.lastError,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /queue/stats - get queue statistics
app.get('/queue/stats', async (req, res) => {
  try {
    const stats = await getQueueStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Enhanced health endpoint with watchdog stats
app.get('/health', (req, res) => {
  // Check API key
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const now = new Date();
  const uptime = Math.floor((now - new Date(watchdogStats.startTime)) / 1000);
  
  res.json({
    ok: true,
    uptime: `${uptime}s`,
    system: {
      browserBusy,
      queueProcessing: jobQueue.processing,
      currentJob: jobQueue.currentJob,
      busyReason,
      activeOperations: operationTimeouts.size
    },
    watchdog: {
      ...watchdogStats,
      uptimeSeconds: uptime,
      lastSuccessfulOperationAgo: watchdogStats.lastSuccessfulOperation ? 
        Math.floor((now - new Date(watchdogStats.lastSuccessfulOperation)) / 1000) : null,
      lastSuccessfulSendAgo: watchdogStats.lastSuccessfulSend ? 
        Math.floor((now - new Date(watchdogStats.lastSuccessfulSend)) / 1000) : null
    }
  });
});

// Manual recovery endpoint for debugging
app.post('/recovery', async (req, res) => {
  // Check API key
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    await forceRecovery();
    res.json({ ok: true, message: 'Force recovery completed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual retry failed messages endpoint
app.post('/retry-failed', async (req, res) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const dbConn = await initDb();
    const result = await dbConn.run(
      `UPDATE sms SET status = 'queued', retry_count = 0, updated_at = ? WHERE status = 'failed'`,
      [new Date().toISOString()]
    );
    
    if (result.changes > 0) {
      console.log(`🔄 Manual retry: Requeued ${result.changes} failed messages`);
      triggerQueueProcessing();
      res.json({ ok: true, message: `Requeued ${result.changes} failed messages` });
    } else {
      res.json({ ok: true, message: 'No failed messages to retry' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get last inbox check status (from idle polling)
app.get('/inbox/status', async (_req, res) => {
  try {
    // Try to get from SQLite first (persisted)
    const stored = await dbGetInboxStatus('lastCheck');
    if (stored && typeof stored === 'object') {
      res.json(stored);
    } else if (lastInboxCheck) {
      res.json(lastInboxCheck);
    } else {
      res.json({ lastMessage: null, checkedAt: null, isNew: false });
    }
  } catch (err) {
    // Fall back to in-memory
    if (lastInboxCheck) {
      res.json(lastInboxCheck);
    } else {
      res.json({ lastMessage: null, checkedAt: null, isNew: false });
    }
  }
});

// Read inbox messages
app.get('/messages/inbox', async (_req, res) => {
  try {
    const result = await readMessages('inbox');
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Read outbox messages
app.get('/messages/outbox', async (_req, res) => {
  try {
    const result = await readMessages('outbox');
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Clear inbox or outbox
app.post('/messages/clear', async (req, res) => {
  const { box } = req.body || {};
  if (!box || !['inbox', 'outbox'].includes(box)) {
    return res.status(400).json({ error: 'box must be "inbox" or "outbox"' });
  }
  try {
    const result = await clearMessages(box);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Screenshot current browser state
app.get('/screenshot', async (_req, res) => {
  try {
    const result = await captureScreenshot();
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Swagger-like minimal UI (no extra deps) at /
const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'SMSAuto API',
    version: '1.0.0',
    description: 'Send SMS via router UI automation.',
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'API key (default: changeme, or override via API_KEY env)',
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
  paths: {
    '/send': {
      post: {
        summary: 'Send an SMS message (non-blocking)',
        description: 'Queues an SMS for sending and returns a status URL to check progress.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  to: { type: 'string', example: '+447900000000' },
                  text: { type: 'string', example: 'omg hi' },
                },
                required: ['to', 'text'],
              },
            },
          },
        },
        responses: {
          202: {
            description: 'SMS queued for sending',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Unique message ID' },
                    status: { type: 'string', example: 'queued' },
                    statusUrl: { type: 'string', example: '/send/msg-1733680000' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/send/{id}': {
      get: {
        summary: 'Check SMS status',
        description: 'Returns the current status of a queued or sent SMS.',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Message ID returned from POST /send',
          },
        ],
        responses: {
          200: {
            description: 'SMS status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    status: { type: 'string', enum: ['queued', 'sending', 'sent', 'failed'] },
                    updatedAt: { type: 'integer', description: 'Unix timestamp ms' },
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
          404: {
            description: 'SMS not found',
          },
        },
      },
    },
    '/messages/inbox': {
      get: {
        summary: 'Read inbox messages',
        responses: {
          200: {
            description: 'List of inbox messages',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    messages: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          contact: { type: 'string' },
                          subject: { type: 'string' },
                          time: { type: 'string' },
                          status: { type: 'string' },
                          box: { type: 'string' },
                          page: { type: 'integer' },
                        },
                      },
                    },
                    scrapedAt: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/messages/outbox': {
      get: {
        summary: 'Read outbox messages',
        responses: {
          200: {
            description: 'List of outbox messages',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    messages: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          contact: { type: 'string' },
                          subject: { type: 'string' },
                          time: { type: 'string' },
                          status: { type: 'string' },
                          box: { type: 'string' },
                          page: { type: 'integer' },
                        },
                      },
                    },
                    scrapedAt: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/messages/clear': {
      post: {
        summary: 'Clear inbox or outbox',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  box: { type: 'string', enum: ['inbox', 'outbox'], example: 'inbox' },
                },
                required: ['box'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Result of clear operation',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    cleared: { type: 'integer' },
                    dialog: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/screenshot': {
      get: {
        summary: 'Get a base64 screenshot of the current browser state',
        responses: {
          200: {
            description: 'Screenshot captured successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    image: { type: 'string', description: 'Base64-encoded PNG' },
                    format: { type: 'string', enum: ['png'] },
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const swaggerHtml = `
<!DOCTYPE html>
<html>
  <head>
    <title>SMSAuto API</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.onload = () => {
        const spec = ${JSON.stringify(swaggerSpec, null, 2)};
        SwaggerUIBundle({ spec, dom_id: '#swagger-ui' });
      };
    </script>
  </body>
</html>
`;

app.get('/', (_req, res) => {
  res.type('html').send(swaggerHtml);
});

// Require API key for all API routes except root docs and health
app.use((req, res, next) => {
  const openPaths = ['/', '/healthz'];
  if (openPaths.includes(req.path)) return next();
  return requireApiKey(req, res, next);
});

/**
 * Poll inbox for new messages and POST to webhook if configured.
 */
async function pollInbox() {
  if (!WEBHOOK_URL) return;
  try {
    const { messages } = await readMessages('inbox');
    const currentCount = messages.length;

    if (lastInboxCount !== null && currentCount > lastInboxCount) {
      // New messages detected
      const newMessages = messages.slice(0, currentCount - lastInboxCount);
      console.log(`New inbox messages detected: ${newMessages.length}`);
      try {
        await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'new_sms', messages: newMessages, timestamp: new Date().toISOString() }),
        });
        console.log('Webhook POST sent successfully');
      } catch (err) {
        console.error('Webhook POST failed:', err.message);
      }
    }
    lastInboxCount = currentCount;
  } catch (err) {
    console.error('Inbox poll failed:', err.message);
  }
}

/**
 * Retry all failed messages - requeue them for another attempt
 */
async function retryFailedMessages() {
  try {
    const dbConn = await initDb();
    const result = await dbConn.run(
      `UPDATE sms SET status = 'queued', retry_count = 0, updated_at = ? WHERE status = 'failed'`,
      [new Date().toISOString()]
    );
    
    if (result.changes > 0) {
      console.log(`🔄 Midnight retry: Requeued ${result.changes} failed messages`);
      // Trigger queue processing
      triggerQueueProcessing();
    } else {
      console.log(`🔄 Midnight retry: No failed messages to retry`);
    }
  } catch (err) {
    console.error('Failed to retry messages:', err.message);
  }
}

/**
 * Check if it's midnight and retry failed messages
 */
let lastRetryDate = null;
function maybeRetryFailedAtMidnight() {
  const now = new Date();
  const hour = now.getUTCHours();
  const todayStr = now.toISOString().slice(0, 10);
  
  // Run at midnight UTC (hour 0)
  if (hour === 0 && lastRetryDate !== todayStr) {
    lastRetryDate = todayStr;
    console.log('🕛 Midnight - retrying failed messages');
    retryFailedMessages();
  }
}

app.listen(LISTEN_PORT, async () => {
  console.log(`smsauto listening on ${LISTEN_PORT}`);
  
  // Initialize database
  await initDb();

  // Start watchdog monitoring
  console.log('Starting watchdog monitoring system');
  startWatchdog();

  // Start polling if configured
  if (POLL_INTERVAL_MS > 0 && WEBHOOK_URL) {
    console.log(`Polling inbox every ${POLL_INTERVAL_MS}ms, webhook: ${WEBHOOK_URL}`);
    setInterval(pollInbox, POLL_INTERVAL_MS);
    // Initial poll
    pollInbox();
  }

  // Check for any pending jobs on startup and process them
  console.log('Queue processing triggered on enqueue (no polling)');
  const pendingOnStartup = await dbListPendingSms();
  if (pendingOnStartup.length > 0) {
    console.log(`Found ${pendingOnStartup.length} pending jobs on startup, triggering processing...`);
    triggerQueueProcessing();
  }

  // Start idle inbox checker
  if (INBOX_CHECK_MS > 0) {
    console.log(`Checking inbox when idle every ${INBOX_CHECK_MS}ms`);
    setInterval(checkInboxWhenIdle, INBOX_CHECK_MS);
    // Initial check after a short delay to let things settle
    setTimeout(checkInboxWhenIdle, 5000);
  }

  // Check for daily outbox clear every minute
  console.log(`Daily outbox clear scheduled at ${OUTBOX_CLEAR_HOUR}:00 UTC`);
  setInterval(maybeClearOutboxDaily, 60000); // Check every minute
  
  // Check for midnight retry of failed messages every minute
  console.log('Midnight retry of failed messages enabled');
  setInterval(maybeRetryFailedAtMidnight, 60000); // Check every minute
});
