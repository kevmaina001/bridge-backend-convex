const axios = require('axios');
const logger = require('../utils/logger');

const CONVEX_URL = process.env.CONVEX_URL;

if (!CONVEX_URL) {
  logger.warn('CONVEX_URL not set in environment variables. Convex integration disabled.');
}

/**
 * Send payment data to Convex
 * @param {Object} paymentData - Payment data to store
 * @returns {Promise<Object>} Response from Convex
 */
async function sendPaymentToConvex(paymentData) {
  if (!CONVEX_URL) {
    logger.warn('Convex URL not configured. Skipping Convex sync.');
    return { success: false, error: 'Convex not configured' };
  }

  try {
    const response = await axios.post(
      `${CONVEX_URL}/webhooks/payment`,
      paymentData,
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10000, // 10 second timeout
      }
    );

    logger.info(`Payment ${paymentData.transaction_id} synced to Convex`);
    return response.data;
  } catch (error) {
    logger.error('Error sending payment to Convex:', error.message);
    if (error.response) {
      logger.error('Convex error response:', error.response.data);
    }
    return {
      success: false,
      error: error.message,
      details: error.response?.data
    };
  }
}

/**
 * Update payment status in Convex
 * @param {string} transactionId - Transaction ID
 * @param {string} status - Payment status
 * @param {string} uispResponse - UISP API response
 * @param {string} errorMessage - Error message if failed
 * @returns {Promise<Object>} Response from Convex
 */
async function updatePaymentStatusInConvex(transactionId, status, uispResponse, errorMessage) {
  if (!CONVEX_URL) {
    return { success: false, error: 'Convex not configured' };
  }

  try {
    const response = await axios.post(
      `${CONVEX_URL}/webhooks/payment/status`,
      {
        transaction_id: transactionId,
        status,
        uisp_response: uispResponse,
        error_message: errorMessage,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    logger.info(`Payment ${transactionId} status updated in Convex: ${status}`);
    return response.data;
  } catch (error) {
    logger.error('Error updating payment status in Convex:', error.message);
    return {
      success: false,
      error: error.message,
      details: error.response?.data
    };
  }
}

/**
 * Bulk sync clients to Convex
 * @param {Array} clients - Array of client objects
 * @returns {Promise<Object>} Response from Convex
 */
async function syncClientsToConvex(clients) {
  if (!CONVEX_URL) {
    logger.warn('Convex URL not configured. Skipping Convex sync.');
    return { success: false, error: 'Convex not configured' };
  }

  try {
    const response = await axios.post(
      `${CONVEX_URL}/webhooks/clients/bulk`,
      { clients },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 30000, // 30 second timeout for bulk operations
      }
    );

    logger.info(`${clients.length} clients synced to Convex`);
    return response.data;
  } catch (error) {
    logger.error('Error syncing clients to Convex:', error.message);
    if (error.response) {
      logger.error('Convex error response:', error.response.data);
    }
    return {
      success: false,
      error: error.message,
      details: error.response?.data
    };
  }
}

/**
 * Log webhook event to Convex
 * @param {Object} logData - Webhook log data
 * @returns {Promise<Object>} Response from Convex
 */
async function logWebhookToConvex(logData) {
  if (!CONVEX_URL) {
    return { success: false, error: 'Convex not configured' };
  }

  try {
    const response = await axios.post(
      `${CONVEX_URL}/webhooks/log`,
      logData,
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      }
    );

    return response.data;
  } catch (error) {
    // Don't log errors for logging operations to avoid infinite loops
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  sendPaymentToConvex,
  updatePaymentStatusInConvex,
  syncClientsToConvex,
  logWebhookToConvex,
};
