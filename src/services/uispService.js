const axios = require('axios');
const logger = require('../utils/logger');
const { retryWithBackoff } = require('../utils/retry');
const { dbHelpers } = require('../utils/database');
const { syncClientsToConvex } = require('./convexService');

/**
 * Post payment to UISP API
 * @param {Object} paymentData - Payment data from Splynx
 * @returns {Promise<Object>} - UISP API response
 */
async function postPaymentToUISP(paymentData) {
  const uispApiUrl = process.env.UISP_CRM_API_URL || 'https://faijonfibre.uisp.com/crm/api/v1.0';
  const uispAppKey = process.env.UISP_APP_KEY;

  if (!uispAppKey) {
    throw new Error('UISP_APP_KEY not configured');
  }

  // Format datetime for UISP (expects format: Y-m-d\TH:i:sO, e.g., 2025-12-14T23:48:29+03:00)
  const formatUispDateTime = (dateString) => {
    if (!dateString) {
      dateString = new Date().toISOString();
    }

    // Parse the date
    const date = new Date(dateString);

    // Format as YYYY-MM-DDTHH:mm:ss+03:00 (East Africa Time)
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours() + 3).padStart(2, '0'); // UTC+3 for Kenya
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');

    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+03:00`;
  };

  // Prepare payment data for UISP
  const uispPaymentData = {
    clientId: parseInt(paymentData.client_id),
    methodId: process.env.UISP_DEFAULT_PAYMENT_METHOD_ID || "ccff6158-de2e-45a2-af01-b973cab5cb5f", // M-Pesa method ID
    amount: parseFloat(paymentData.amount),
    currencyCode: paymentData.currency_code || 'KES',
    note: paymentData.comment || paymentData.note || `Transaction: ${paymentData.transaction_id}`,
    providerName: "Splynx",
    providerPaymentId: paymentData.transaction_id || paymentData.field_1,
    providerPaymentTime: formatUispDateTime(paymentData.real_create_datetime || paymentData.created_at),
    applyToInvoicesAutomatically: true
  };

  const headers = {
    'Content-Type': 'application/json',
    'X-Auth-App-Key': uispAppKey
  };

  logger.info('Posting payment to UISP', {
    clientId: uispPaymentData.clientId,
    amount: uispPaymentData.amount,
    transactionId: paymentData.transaction_id
  });

  // Use retry logic for the API call
  const result = await retryWithBackoff(
    async () => {
      const response = await axios.post(
        `${uispApiUrl}/payments`,
        uispPaymentData,
        { headers, timeout: 30000 }
      );

      logger.info('Payment successfully posted to UISP', {
        transactionId: paymentData.transaction_id,
        uispPaymentId: response.data?.id,
        status: response.status
      });

      return response;
    },
    {
      onRetry: async (attempt, error) => {
        // Update retry count in database
        await dbHelpers.updateRetryCount(paymentData.transaction_id, attempt);
        logger.warn(`Retry attempt ${attempt} for transaction ${paymentData.transaction_id}`, {
          error: error.message
        });
      }
    }
  );

  return result.data;
}

/**
 * Get client information from UISP
 * @param {number} clientId - UISP client ID
 * @returns {Promise<Object>} - Client data
 */
async function getUISPClient(clientId) {
  const uispApiUrl = process.env.UISP_API_URL || 'https://faijonfibre.uisp.com/api/v1.0';
  const uispAppKey = process.env.UISP_APP_KEY;

  if (!uispAppKey) {
    throw new Error('UISP_APP_KEY not configured');
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-Auth-App-Key': uispAppKey
  };

  try {
    const response = await axios.get(
      `${uispApiUrl}/clients/${clientId}`,
      { headers, timeout: 30000 }
    );

    return response.data;
  } catch (error) {
    logger.error(`Error fetching UISP client ${clientId}:`, error.message);
    throw error;
  }
}

/**
 * Get payments from UISP for a specific client
 * @param {number} clientId - UISP client ID
 * @returns {Promise<Array>} - Payment records
 */
async function getUISPClientPayments(clientId) {
  const uispApiUrl = process.env.UISP_CRM_API_URL || 'https://faijonfibre.uisp.com/crm/api/v1.0';
  const uispAppKey = process.env.UISP_APP_KEY;

  if (!uispAppKey) {
    throw new Error('UISP_APP_KEY not configured');
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-Auth-App-Key': uispAppKey
  };

  try {
    const response = await axios.get(
      `${uispApiUrl}/clients/${clientId}/payments`,
      { headers, timeout: 30000 }
    );

    return response.data;
  } catch (error) {
    logger.error(`Error fetching UISP client payments for ${clientId}:`, error.message);
    throw error;
  }
}

/**
 * Fetch all clients from UISP
 * @param {number} limit - Number of clients per page
 * @param {number} offset - Offset for pagination
 * @returns {Promise<Array>} - Array of clients
 */
async function fetchUISPClients(limit = 100, offset = 0, includeLeads = false) {
  const uispApiUrl = process.env.UISP_API_URL || 'https://faijonfibre.uisp.com/api/v1.0';
  const uispAppKey = process.env.UISP_APP_KEY;

  if (!uispAppKey) {
    throw new Error('UISP_APP_KEY not configured');
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-Auth-App-Key': uispAppKey
  };

  try {
    logger.info(`Fetching UISP clients (limit: ${limit}, offset: ${offset})`);

    // Try different approaches to get all clients
    // UISP might use 'type' parameter with values: client, lead
    const params = {
      limit,
      offset
    };

    // Don't add any filters - fetch everything UISP returns

    const response = await axios.get(
      `${uispApiUrl}/clients`,
      {
        headers,
        timeout: 60000,
        params
      }
    );

    logger.info(`Fetched ${response.data.length} clients from UISP (offset: ${offset})`);

    // Log sample of first client to see structure
    if (response.data.length > 0 && offset === 0) {
      logger.info('Sample client data fields:', {
        id: response.data[0].id,
        isArchived: response.data[0].isArchived,
        clientType: response.data[0].clientType,
        isActive: response.data[0].isActive,
        isSuspended: response.data[0].isSuspended
      });
    }

    return response.data;
  } catch (error) {
    logger.error('Error fetching UISP clients:', error.message);
    throw error;
  }
}

/**
 * Transform UISP client data to database format
 * @param {Object} uispClient - Client data from UISP
 * @returns {Object} - Transformed client data
 */
function transformClientData(uispClient) {
  // Extract contact from contacts array
  const contact = uispClient.contacts && uispClient.contacts[0];

  return {
    uisp_id: uispClient.id,
    first_name: uispClient.firstName || contact?.name?.split(' ')[0] || null,
    last_name: uispClient.lastName || contact?.name?.split(' ')[1] || null,
    company_name: uispClient.companyName || null,
    email: contact?.email || uispClient.username || null,
    phone: contact?.phone || null,
    street1: uispClient.street1 || null,
    street2: uispClient.street2 || null,
    city: uispClient.city || null,
    country: uispClient.countryId || null,
    state: uispClient.stateId || null,
    zip_code: uispClient.zipCode || null,
    balance: uispClient.balance || 0,
    account_balance: uispClient.accountBalance || 0,
    account_outstanding: uispClient.accountOutstanding || 0,
    currency_code: uispClient.currencyCode || 'KES',
    is_active: !uispClient.isArchived,
    is_suspended: uispClient.isSuspended || false,
    registration_date: uispClient.registrationDate || null,
    previous_isp: uispClient.previousIsp || null,
    tax_id: uispClient.taxId || null,
    company_tax_id: uispClient.companyTaxId || null,
    note: uispClient.note || null,
    raw_data: uispClient
  };
}

/**
 * Sync all clients from UISP to local database
 * @returns {Promise<Object>} - Sync results
 */
async function syncAllClients() {
  const startTime = Date.now();
  let syncLogId;

  try {
    // Create sync log
    syncLogId = await dbHelpers.createSyncLog('full_client_sync');

    logger.info('Starting full client sync from UISP');

    let allClients = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    // Fetch all clients with pagination
    while (hasMore) {
      const clients = await fetchUISPClients(limit, offset);

      if (clients.length === 0) {
        hasMore = false;
      } else {
        allClients = allClients.concat(clients);
        offset += limit;

        logger.info(`Fetched ${allClients.length} clients so far...`);

        // If we got less than the limit, we've reached the end
        if (clients.length < limit) {
          hasMore = false;
        }
      }
    }

    logger.info(`Total clients fetched: ${allClients.length}`);

    // Update sync log with total
    await dbHelpers.updateSyncLog(syncLogId, 'in_progress', 0, 0);

    // Transform clients for Convex sync
    const transformedClients = allClients.map(uispClient => transformClientData(uispClient));

    // Sync clients to Convex (non-blocking)
    syncClientsToConvex(transformedClients).catch(err => {
      logger.warn('Failed to sync clients to Convex:', err.message);
    });

    // Transform and insert clients
    let syncedCount = 0;
    let failedCount = 0;
    const errors = [];

    for (const uispClient of allClients) {
      try {
        const clientData = transformClientData(uispClient);
        await dbHelpers.upsertClient(clientData);
        syncedCount++;

        if (syncedCount % 10 === 0) {
          logger.info(`Synced ${syncedCount}/${allClients.length} clients`);
        }
      } catch (error) {
        failedCount++;
        errors.push(`Client ${uispClient.id}: ${error.message}`);
        logger.error(`Failed to sync client ${uispClient.id}:`, error.message);
      }
    }

    const duration = Date.now() - startTime;

    // Update sync log with results
    await dbHelpers.updateSyncLog(
      syncLogId,
      'completed',
      syncedCount,
      failedCount,
      errors.length > 0 ? errors.join('; ') : null
    );

    logger.info('Client sync completed', {
      total: allClients.length,
      synced: syncedCount,
      failed: failedCount,
      duration: `${duration}ms`
    });

    return {
      success: true,
      total: allClients.length,
      synced: syncedCount,
      failed: failedCount,
      duration,
      errors: errors.length > 0 ? errors : undefined
    };

  } catch (error) {
    logger.error('Client sync failed:', error);

    if (syncLogId) {
      await dbHelpers.updateSyncLog(
        syncLogId,
        'failed',
        0,
        0,
        error.message
      );
    }

    throw error;
  }
}

/**
 * Sync a single client from UISP to local database
 * @param {number} clientId - UISP client ID
 * @returns {Promise<Object>} - Synced client data
 */
async function syncSingleClient(clientId) {
  try {
    logger.info(`Syncing single client: ${clientId}`);

    const uispClient = await getUISPClient(clientId);
    const clientData = transformClientData(uispClient);

    await dbHelpers.upsertClient(clientData);

    logger.info(`Successfully synced client ${clientId}`);

    return clientData;
  } catch (error) {
    logger.error(`Failed to sync client ${clientId}:`, error.message);
    throw error;
  }
}

module.exports = {
  postPaymentToUISP,
  getUISPClient,
  getUISPClientPayments,
  fetchUISPClients,
  syncAllClients,
  syncSingleClient,
  transformClientData
};
