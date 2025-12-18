const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

const SPLYNX_API_URL = process.env.SPLYNX_API_URL || 'https://faijon.splynx.app';
const SPLYNX_API_KEY = process.env.SPLYNX_API_KEY;
const SPLYNX_API_SECRET = process.env.SPLYNX_API_SECRET;

if (!SPLYNX_API_KEY || !SPLYNX_API_SECRET) {
  logger.warn('Splynx API credentials not configured. Customer lookup from Splynx will be disabled.');
}

/**
 * Generate Splynx API signature
 * @param {string} nonce - Random nonce
 * @returns {string} - HMAC signature
 */
function generateSignature(nonce) {
  const message = nonce + SPLYNX_API_KEY;
  return crypto
    .createHmac('sha256', SPLYNX_API_SECRET)
    .update(message)
    .digest('hex');
}

/**
 * Get customer details from Splynx API
 * @param {string} customerId - Splynx customer ID
 * @returns {Promise<Object>} - Customer data including login
 */
async function getSplynxCustomer(customerId) {
  if (!SPLYNX_API_KEY || !SPLYNX_API_SECRET) {
    throw new Error('Splynx API credentials not configured');
  }

  try {
    logger.info(`Fetching customer ${customerId} from Splynx API`);

    // Generate nonce and signature for authentication
    const nonce = Date.now().toString();
    const signature = generateSignature(nonce);

    const response = await axios.get(
      `${SPLYNX_API_URL}/api/2.0/admin/customers/${customerId}`,
      {
        params: {
          auth_type: 'auth_key',
          key: SPLYNX_API_KEY,
          signature: signature,
          nonce: nonce
        },
        timeout: 10000
      }
    );

    logger.info(`Successfully fetched customer ${customerId} from Splynx`, {
      login: response.data.login,
      name: response.data.name
    });

    return response.data;
  } catch (error) {
    if (error.response) {
      logger.error(`Splynx API error for customer ${customerId}:`, {
        status: error.response.status,
        data: error.response.data
      });
    } else {
      logger.error(`Error fetching customer ${customerId} from Splynx:`, error.message);
    }
    throw error;
  }
}

/**
 * Get customer login/account number from Splynx
 * @param {string} customerId - Splynx customer ID
 * @returns {Promise<string>} - Customer login/portal ID
 */
async function getSplynxCustomerLogin(customerId) {
  const customer = await getSplynxCustomer(customerId);
  return customer.login;
}

module.exports = {
  getSplynxCustomer,
  getSplynxCustomerLogin
};
