const { ConvexHttpClient } = require('convex/browser');
const logger = require('../utils/logger');

const CONVEX_URL = process.env.CONVEX_URL;

let convexClient = null;

if (!CONVEX_URL) {
  logger.warn('CONVEX_URL not set in environment variables. Convex integration disabled.');
} else {
  try {
    convexClient = new ConvexHttpClient(CONVEX_URL);
    logger.info('Convex client initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize Convex client:', error.message);
  }
}

/**
 * Send payment data to Convex
 * @param {Object} paymentData - Payment data to store
 * @returns {Promise<Object>} Response from Convex
 */
async function sendPaymentToConvex(paymentData) {
  if (!convexClient) {
    logger.warn('Convex client not initialized. Skipping Convex sync.');
    return { success: false, error: 'Convex not configured' };
  }

  try {
    // Transform payment data for Convex schema
    const transformedPayment = {
      transaction_id: paymentData.transaction_id,
      client_id: paymentData.client_id?.toString() || '',
      amount: parseFloat(paymentData.amount),
      currency_code: paymentData.currency_code || 'KES',
      created_at: paymentData.created_at,
      received_at: paymentData.received_at || Date.now(),
      status: paymentData.status || 'pending',
      retry_count: paymentData.retry_count || 0,
    };

    // Add optional fields only if they exist
    if (paymentData.splynx_customer_id) transformedPayment.splynx_customer_id = paymentData.splynx_customer_id;
    if (paymentData.payment_type) transformedPayment.payment_type = paymentData.payment_type;
    if (paymentData.payment_method) transformedPayment.payment_method = paymentData.payment_method;
    if (paymentData.uisp_response) transformedPayment.uisp_response = paymentData.uisp_response;
    if (paymentData.error_message) transformedPayment.error_message = paymentData.error_message;
    if (paymentData.last_retry_at) transformedPayment.last_retry_at = paymentData.last_retry_at;

    const result = await convexClient.mutation("payments:insertPayment", transformedPayment);

    logger.info(`Payment ${paymentData.transaction_id} synced to Convex successfully`);
    return { success: true, result };
  } catch (error) {
    logger.error('Error sending payment to Convex:', error.message);
    logger.error('Error stack:', error.stack);
    return {
      success: false,
      error: error.message
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
  if (!convexClient) {
    return { success: false, error: 'Convex not configured' };
  }

  try {
    // First, get the payment ID by transaction ID
    const payment = await convexClient.query("payments:getPaymentByTransactionId", {
      transaction_id: transactionId
    });

    if (!payment) {
      logger.warn(`Payment ${transactionId} not found in Convex for status update`);
      return { success: false, error: 'Payment not found' };
    }

    // Update the payment status
    const updateData = {
      paymentId: payment._id,
      status
    };

    if (uispResponse) updateData.uisp_response = uispResponse;
    if (errorMessage) updateData.error_message = errorMessage;

    const result = await convexClient.mutation("payments:updatePaymentStatus", updateData);

    logger.info(`Payment ${transactionId} status updated in Convex: ${status}`);
    return { success: true, result };
  } catch (error) {
    logger.error('Error updating payment status in Convex:', error.message);
    logger.error('Error stack:', error.stack);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Bulk sync clients to Convex
 * @param {Array} clients - Array of client objects
 * @returns {Promise<Object>} Response from Convex
 */
async function syncClientsToConvex(clients) {
  if (!convexClient) {
    logger.warn('Convex client not initialized. Skipping Convex sync.');
    return { success: false, error: 'Convex not configured' };
  }

  try {
    // Transform clients for Convex schema
    // Note: Convex requires undefined for optional fields, not null
    const transformedClients = clients.map(client => {
      const transformed = {
        uisp_client_id: client.uisp_id?.toString() || client.uisp_client_id,
        status: client.is_active === false ? 'inactive' : (client.is_suspended ? 'suspended' : 'active'),
        account_balance: client.account_balance || 0,
        invoice_balance: client.account_outstanding || 0,
      };

      // Only add non-null optional fields
      if (client.custom_id) transformed.custom_id = client.custom_id;
      if (client.first_name) transformed.first_name = client.first_name;
      if (client.last_name) transformed.last_name = client.last_name;
      if (client.email) transformed.email = client.email;
      if (client.phone) transformed.phone = client.phone;

      return transformed;
    });

    // Call the mutation using string path format
    // ConvexHttpClient.mutation expects a string path "module:functionName"
    const result = await convexClient.mutation("clients:bulkUpsertClients", {
      clients: transformedClients
    });

    logger.info(`${clients.length} clients synced to Convex successfully`);
    return { success: true, result };
  } catch (error) {
    logger.error('Error syncing clients to Convex:', error.message);
    logger.error('Error stack:', error.stack);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Bulk sync Splynx customers to Convex
 * @param {Array} customers - Array of Splynx customer objects
 * @returns {Promise<Object>} Response from Convex
 */
async function syncSplynxCustomersToConvex(customers) {
  if (!convexClient) {
    logger.warn('Convex client not initialized. Skipping Convex sync.');
    return { success: false, error: 'Convex not configured' };
  }

  try {
    // Transform customers for Convex schema
    // Note: Convex requires undefined for optional fields, not null
    const transformedCustomers = customers.map(customer => {
      const transformed = {
        splynx_id: customer.splynx_id,
      };

      // Only add non-null optional fields
      if (customer.login) transformed.login = customer.login;
      if (customer.name) transformed.name = customer.name;
      if (customer.email) transformed.email = customer.email;
      if (customer.phone) transformed.phone = customer.phone;
      if (customer.status) transformed.status = customer.status;
      if (customer.billing_type) transformed.billing_type = customer.billing_type;
      if (customer.category) transformed.category = customer.category;
      if (customer.street_1) transformed.street_1 = customer.street_1;
      if (customer.city) transformed.city = customer.city;
      if (customer.zip_code) transformed.zip_code = customer.zip_code;

      return transformed;
    });

    // Call the mutation using string path format
    const result = await convexClient.mutation("splynx_customers:bulkUpsertSplynxCustomers", {
      customers: transformedCustomers
    });

    logger.info(`${customers.length} Splynx customers synced to Convex successfully`);
    return { success: true, result };
  } catch (error) {
    logger.error('Error syncing Splynx customers to Convex:', error.message);
    logger.error('Error stack:', error.stack);
    return {
      success: false,
      error: error.message
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

/**
 * Get Splynx customer login from Convex by customer ID
 * @param {string} splynxCustomerId - Splynx customer ID
 * @returns {Promise<string|null>} Customer login or null if not found
 */
async function getSplynxCustomerLoginFromConvex(splynxCustomerId) {
  if (!convexClient) {
    logger.warn('Convex client not initialized. Cannot get customer login.');
    return null;
  }

  try {
    logger.info(`Looking up Splynx customer ${splynxCustomerId} in Convex...`);

    const customer = await convexClient.query("splynx_customers:getSplynxCustomerById", {
      splynxId: splynxCustomerId.toString()
    });

    if (customer && customer.login) {
      logger.info(`Found customer login in Convex: ${customer.login}`);
      return customer.login;
    } else {
      logger.warn(`Splynx customer ${splynxCustomerId} not found in Convex`);
      return null;
    }
  } catch (error) {
    logger.error('Error getting customer from Convex:', error.message);
    return null;
  }
}

module.exports = {
  sendPaymentToConvex,
  updatePaymentStatusInConvex,
  syncClientsToConvex,
  syncSplynxCustomersToConvex,
  logWebhookToConvex,
  getSplynxCustomerLoginFromConvex,
};
