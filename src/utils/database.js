const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('./logger');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../../database.sqlite');

// Initialize database
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    logger.error('Error opening database:', err);
  } else {
    logger.info('Connected to SQLite database');
    initializeSchema();
  }
});

// Initialize database schema
function initializeSchema() {
  const schema = `
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT UNIQUE,
      client_id TEXT NOT NULL,
      amount REAL NOT NULL,
      currency_code TEXT DEFAULT 'KES',
      payment_type TEXT,
      payment_method TEXT,
      created_at TEXT NOT NULL,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'pending',
      uisp_response TEXT,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      last_retry_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_client_id ON payments(client_id);
    CREATE INDEX IF NOT EXISTS idx_transaction_id ON payments(transaction_id);
    CREATE INDEX IF NOT EXISTS idx_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_created_at ON payments(created_at);

    CREATE TABLE IF NOT EXISTS webhook_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      payload TEXT,
      headers TEXT,
      ip_address TEXT,
      validated BOOLEAN DEFAULT 0,
      processed BOOLEAN DEFAULT 0,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY,
      uisp_id INTEGER UNIQUE NOT NULL,
      first_name TEXT,
      last_name TEXT,
      company_name TEXT,
      email TEXT,
      phone TEXT,
      street1 TEXT,
      street2 TEXT,
      city TEXT,
      country TEXT,
      state TEXT,
      zip_code TEXT,
      balance REAL DEFAULT 0,
      account_balance REAL DEFAULT 0,
      account_outstanding REAL DEFAULT 0,
      currency_code TEXT DEFAULT 'KES',
      is_active BOOLEAN DEFAULT 1,
      is_suspended BOOLEAN DEFAULT 0,
      registration_date TEXT,
      previous_isp TEXT,
      tax_id TEXT,
      company_tax_id TEXT,
      note TEXT,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_payment_at DATETIME,
      uisp_data TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_uisp_id ON clients(uisp_id);
    CREATE INDEX IF NOT EXISTS idx_email ON clients(email);
    CREATE INDEX IF NOT EXISTS idx_is_active ON clients(is_active);
    CREATE INDEX IF NOT EXISTS idx_is_suspended ON clients(is_suspended);
    CREATE INDEX IF NOT EXISTS idx_synced_at ON clients(synced_at);

    CREATE TABLE IF NOT EXISTS sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_type TEXT NOT NULL,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      status TEXT DEFAULT 'in_progress',
      total_records INTEGER DEFAULT 0,
      synced_records INTEGER DEFAULT 0,
      failed_records INTEGER DEFAULT 0,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS customer_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      splynx_customer_id TEXT UNIQUE NOT NULL,
      uisp_client_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_splynx_customer_id ON customer_mappings(splynx_customer_id);
    CREATE INDEX IF NOT EXISTS idx_uisp_client_id ON customer_mappings(uisp_client_id);
  `;

  db.exec(schema, (err) => {
    if (err) {
      logger.error('Error creating database schema:', err);
    } else {
      logger.info('Database schema initialized');
      // Insert default mapping for customer 838 → 1211
      insertDefaultMappings();
    }
  });
}

// Insert default customer mappings
function insertDefaultMappings() {
  const defaultMappings = [
    { splynx_customer_id: '838', uisp_client_id: 1211, notes: 'Initial mapping' }
  ];

  defaultMappings.forEach(mapping => {
    db.run(
      `INSERT OR IGNORE INTO customer_mappings (splynx_customer_id, uisp_client_id, notes)
       VALUES (?, ?, ?)`,
      [mapping.splynx_customer_id, mapping.uisp_client_id, mapping.notes],
      (err) => {
        if (err) {
          logger.error('Error inserting default mapping:', err);
        } else {
          logger.info(`Default mapping created: Splynx ${mapping.splynx_customer_id} → UISP ${mapping.uisp_client_id}`);
        }
      }
    );
  });
}

// Helper functions for database operations
const dbHelpers = {
  // Insert payment record
  insertPayment(paymentData) {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT INTO payments (
          transaction_id, client_id, amount, currency_code,
          payment_type, payment_method, created_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;

      db.run(query, [
        paymentData.transaction_id,
        paymentData.client_id,
        paymentData.amount,
        paymentData.currency_code || 'KES',
        paymentData.payment_type,
        paymentData.payment_method,
        paymentData.created_at,
        'pending'
      ], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
    });
  },

  // Update payment status
  updatePaymentStatus(transactionId, status, uispResponse, errorMessage) {
    return new Promise((resolve, reject) => {
      const query = `
        UPDATE payments
        SET status = ?, uisp_response = ?, error_message = ?
        WHERE transaction_id = ?
      `;

      db.run(query, [status, uispResponse, errorMessage, transactionId], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
  },

  // Update retry count
  updateRetryCount(transactionId, retryCount) {
    return new Promise((resolve, reject) => {
      const query = `
        UPDATE payments
        SET retry_count = ?, last_retry_at = CURRENT_TIMESTAMP
        WHERE transaction_id = ?
      `;

      db.run(query, [retryCount, transactionId], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
  },

  // Get payment by transaction ID
  getPaymentByTransactionId(transactionId) {
    return new Promise((resolve, reject) => {
      const query = 'SELECT * FROM payments WHERE transaction_id = ?';
      db.get(query, [transactionId], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  },

  // Get all payments with pagination
  getAllPayments(limit = 50, offset = 0) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT * FROM payments
        ORDER BY received_at DESC
        LIMIT ? OFFSET ?
      `;
      db.all(query, [limit, offset], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  },

  // Get payments by client ID
  getPaymentsByClientId(clientId) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT * FROM payments
        WHERE client_id = ?
        ORDER BY received_at DESC
      `;
      db.all(query, [clientId], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  },

  // Get payment statistics
  getPaymentStats() {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT
          COUNT(*) as total_payments,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_payments,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_payments,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_payments,
          SUM(amount) as total_amount,
          SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END) as successful_amount
        FROM payments
      `;
      db.get(query, [], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  },

  // Log webhook received
  logWebhook(payload, headers, ipAddress, validated) {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT INTO webhook_logs (payload, headers, ip_address, validated)
        VALUES (?, ?, ?, ?)
      `;

      db.run(query, [
        JSON.stringify(payload),
        JSON.stringify(headers),
        ipAddress,
        validated ? 1 : 0
      ], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
    });
  },

  // ========== CLIENT OPERATIONS ==========

  // Insert or update client
  upsertClient(clientData) {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT INTO clients (
          uisp_id, first_name, last_name, company_name, email, phone,
          street1, street2, city, country, state, zip_code,
          balance, account_balance, account_outstanding, currency_code,
          is_active, is_suspended, registration_date, previous_isp,
          tax_id, company_tax_id, note, uisp_data, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(uisp_id) DO UPDATE SET
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          company_name = excluded.company_name,
          email = excluded.email,
          phone = excluded.phone,
          street1 = excluded.street1,
          street2 = excluded.street2,
          city = excluded.city,
          country = excluded.country,
          state = excluded.state,
          zip_code = excluded.zip_code,
          balance = excluded.balance,
          account_balance = excluded.account_balance,
          account_outstanding = excluded.account_outstanding,
          currency_code = excluded.currency_code,
          is_active = excluded.is_active,
          is_suspended = excluded.is_suspended,
          registration_date = excluded.registration_date,
          previous_isp = excluded.previous_isp,
          tax_id = excluded.tax_id,
          company_tax_id = excluded.company_tax_id,
          note = excluded.note,
          uisp_data = excluded.uisp_data,
          synced_at = CURRENT_TIMESTAMP
      `;

      db.run(query, [
        clientData.uisp_id,
        clientData.first_name || null,
        clientData.last_name || null,
        clientData.company_name || null,
        clientData.email || null,
        clientData.phone || null,
        clientData.street1 || null,
        clientData.street2 || null,
        clientData.city || null,
        clientData.country || null,
        clientData.state || null,
        clientData.zip_code || null,
        clientData.balance || 0,
        clientData.account_balance || 0,
        clientData.account_outstanding || 0,
        clientData.currency_code || 'KES',
        clientData.is_active ? 1 : 0,
        clientData.is_suspended ? 1 : 0,
        clientData.registration_date || null,
        clientData.previous_isp || null,
        clientData.tax_id || null,
        clientData.company_tax_id || null,
        clientData.note || null,
        JSON.stringify(clientData.raw_data || {})
      ], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
    });
  },

  // Get all clients with optional status filtering
  getAllClients(limit = 100, offset = 0, filters = {}) {
    return new Promise((resolve, reject) => {
      let query = 'SELECT * FROM clients';
      const params = [];
      const conditions = [];

      // Add status filters
      if (filters.is_active !== undefined) {
        conditions.push('is_active = ?');
        params.push(filters.is_active ? 1 : 0);
      }

      if (filters.is_suspended !== undefined) {
        conditions.push('is_suspended = ?');
        params.push(filters.is_suspended ? 1 : 0);
      }

      // Add WHERE clause if there are conditions
      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      query += ' ORDER BY synced_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      db.all(query, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  },

  // Get client by UISP ID
  getClientByUispId(uispId) {
    return new Promise((resolve, reject) => {
      const query = 'SELECT * FROM clients WHERE uisp_id = ?';
      db.get(query, [uispId], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  },

  // Search clients
  searchClients(searchTerm) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT * FROM clients
        WHERE first_name LIKE ? OR last_name LIKE ? OR email LIKE ?
           OR company_name LIKE ? OR phone LIKE ?
        ORDER BY synced_at DESC
        LIMIT 50
      `;
      const term = `%${searchTerm}%`;
      db.all(query, [term, term, term, term, term], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  },

  // Get client statistics
  getClientStats() {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT
          COUNT(*) as total_clients,
          SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_clients,
          SUM(CASE WHEN is_suspended = 1 THEN 1 ELSE 0 END) as suspended_clients,
          SUM(account_balance) as total_balance,
          SUM(account_outstanding) as total_outstanding
        FROM clients
      `;
      db.get(query, [], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  },

  // Update client last payment
  updateClientLastPayment(uispId) {
    return new Promise((resolve, reject) => {
      const query = `
        UPDATE clients
        SET last_payment_at = CURRENT_TIMESTAMP
        WHERE uisp_id = ?
      `;
      db.run(query, [uispId], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
  },

  // ========== SYNC LOG OPERATIONS ==========

  // Create sync log
  createSyncLog(syncType, totalRecords = 0) {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT INTO sync_logs (sync_type, total_records)
        VALUES (?, ?)
      `;
      db.run(query, [syncType, totalRecords], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
    });
  },

  // Update sync log
  updateSyncLog(id, status, syncedRecords, failedRecords, errorMessage = null) {
    return new Promise((resolve, reject) => {
      const query = `
        UPDATE sync_logs
        SET status = ?, synced_records = ?, failed_records = ?,
            error_message = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `;
      db.run(query, [status, syncedRecords, failedRecords, errorMessage, id], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
  },

  // Get recent sync logs
  getRecentSyncLogs(limit = 10) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT * FROM sync_logs
        ORDER BY started_at DESC
        LIMIT ?
      `;
      db.all(query, [limit], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  },

  // ========== CUSTOMER MAPPING OPERATIONS ==========

  // Get UISP client ID from Splynx customer ID
  getUispClientId(splynxCustomerId) {
    return new Promise((resolve, reject) => {
      const query = 'SELECT uisp_client_id FROM customer_mappings WHERE splynx_customer_id = ?';
      db.get(query, [splynxCustomerId.toString()], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row ? row.uisp_client_id : null);
        }
      });
    });
  },

  // Add or update customer mapping
  upsertCustomerMapping(splynxCustomerId, uispClientId, notes = null) {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT INTO customer_mappings (splynx_customer_id, uisp_client_id, notes)
        VALUES (?, ?, ?)
        ON CONFLICT(splynx_customer_id) DO UPDATE SET
          uisp_client_id = excluded.uisp_client_id,
          updated_at = CURRENT_TIMESTAMP,
          notes = excluded.notes
      `;
      db.run(query, [splynxCustomerId.toString(), uispClientId, notes], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
    });
  },

  // Get all customer mappings
  getAllMappings() {
    return new Promise((resolve, reject) => {
      const query = 'SELECT * FROM customer_mappings ORDER BY created_at DESC';
      db.all(query, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  },

  // Delete customer mapping
  deleteCustomerMapping(splynxCustomerId) {
    return new Promise((resolve, reject) => {
      const query = 'DELETE FROM customer_mappings WHERE splynx_customer_id = ?';
      db.run(query, [splynxCustomerId.toString()], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
  }
};

module.exports = { db, dbHelpers };
