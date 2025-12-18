const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { dbHelpers } = require('../utils/database');
const { postPaymentToUISP, syncSingleClient, findUISPClientByUserIdent } = require('../services/uispService');
const { validateWebhookSignature } = require('../middleware/webhookValidator');
const { sendPaymentToConvex, updatePaymentStatusInConvex } = require('../services/convexService');
const { getSplynxCustomerLogin } = require('../services/splynxService');

/**
 * POST /webhook/payment
 * Receive payment webhook from Splynx
 */
router.post('/payment', validateWebhookSignature, async (req, res) => {
  const startTime = Date.now();

  try {
    // Log webhook received
    const clientIp = req.ip || req.connection.remoteAddress;
    await dbHelpers.logWebhook(req.body, req.headers, clientIp, req.webhookValidated);

    logger.info('Payment webhook received', {
      validated: req.webhookValidated,
      ip: clientIp
    });

    // Extract payment data from Splynx webhook
    // Adjust this based on actual Splynx webhook payload structure
    let paymentData;
    let splynxCustomerId;

    if (req.body.data && req.body.data.attributes) {
      // JSON API format from Splynx
      // customer_id is at data level, payment info is in attributes
      paymentData = req.body.data.attributes;
      splynxCustomerId = req.body.data.customer_id; // Extract from data level, not attributes

      logger.info('Splynx JSON API format detected', {
        customer_id: splynxCustomerId,
        attributes: Object.keys(paymentData)
      });
    } else if (req.body.payment) {
      // Direct payment object
      paymentData = req.body.payment;
      splynxCustomerId = paymentData.customer_id || paymentData.client_id;
    } else {
      // Assume body is the payment data
      paymentData = req.body;
      splynxCustomerId = paymentData.customer_id || paymentData.client_id;
    }

    // Check if this is a test/ping request (empty payload or no data)
    if (!paymentData || Object.keys(paymentData).length === 0) {
      logger.info('Webhook test/ping request received');
      return res.status(200).json({
        success: true,
        message: 'Webhook endpoint is active and ready to receive payments'
      });
    }

    // Ensure we have customer_id
    if (!splynxCustomerId) {
      splynxCustomerId = paymentData.customer_id || paymentData.client_id;
    }

    if (!splynxCustomerId) {
      // Check if this is a test/validation request (no customer_id and minimal data)
      if (!paymentData.amount || Object.keys(paymentData).length < 2) {
        logger.info('Webhook validation/test request received (no customer_id)');
        return res.status(200).json({
          success: true,
          message: 'Webhook endpoint is active and ready to receive payments',
          note: 'This was a test request. Real payments must include customer_id or client_id'
        });
      }

      logger.error('No customer_id or client_id found in webhook payload');
      return res.status(400).json({
        error: 'Missing customer identification',
        message: 'Webhook must include customer_id or client_id'
      });
    }

    // Look up UISP client ID
    let uispClientId = null;
    let lookupMethod = 'unknown';
    let customerLogin = splynxCustomerId; // Default to the ID we received

    // Method 1: Fetch customer login from Splynx API (most reliable)
    try {
      logger.info(`Fetching customer login from Splynx API for customer ${splynxCustomerId}...`);
      customerLogin = await getSplynxCustomerLogin(splynxCustomerId);
      logger.info(`Got customer login from Splynx: ${customerLogin}`);

      // Search UISP by userIdent using the customer login
      const uispClient = await findUISPClientByUserIdent(customerLogin);
      if (uispClient) {
        uispClientId = uispClient.id;
        lookupMethod = 'splynx_api';
        logger.info(`Found UISP client ${uispClientId} by userIdent ${customerLogin} (via Splynx API)`);
      }
    } catch (error) {
      logger.warn(`Failed to fetch customer from Splynx API: ${error.message}. Trying fallback methods...`);
    }

    // Method 2: If customer ID starts with W, try direct userIdent search (fallback)
    if (!uispClientId && splynxCustomerId.toUpperCase().startsWith('W')) {
      logger.info(`Wireless customer detected: ${splynxCustomerId}. Trying direct userIdent search...`);
      try {
        const uispClient = await findUISPClientByUserIdent(splynxCustomerId);
        if (uispClient) {
          uispClientId = uispClient.id;
          lookupMethod = 'direct_userIdent';
          logger.info(`Found UISP client ${uispClientId} by direct userIdent ${splynxCustomerId}`);
        }
      } catch (error) {
        logger.warn(`Failed to search UISP by userIdent: ${error.message}`);
      }
    }

    // Method 3: Fall back to mapping table (last resort)
    if (!uispClientId) {
      logger.info(`Searching mapping table for customer ${splynxCustomerId}...`);
      uispClientId = await dbHelpers.getUispClientId(splynxCustomerId);
      if (uispClientId) {
        lookupMethod = 'mapping_table';
        logger.info(`Found UISP client ${uispClientId} via mapping table`);
      }
    }

    // If still not found, return error
    if (!uispClientId) {
      logger.error(`No UISP client found for Splynx customer ${splynxCustomerId}`);
      return res.status(400).json({
        error: 'Customer not found',
        message: `Splynx customer ${splynxCustomerId} (login: ${customerLogin}) not found in UISP. Please ensure the customer exists in UISP with matching userIdent.`,
        splynxCustomerId: splynxCustomerId,
        customerLogin: customerLogin
      });
    }

    logger.info(`Using UISP client ${uispClientId} for payment (lookup method: ${lookupMethod}, customer login: ${customerLogin})`);

    // Use the mapped UISP client ID
    paymentData.client_id = uispClientId;
    paymentData.splynx_customer_id = splynxCustomerId;

    // Validate required fields
    const requiredFields = ['client_id', 'amount'];
    const missingFields = requiredFields.filter(field => !paymentData[field]);

    if (missingFields.length > 0) {
      logger.warn('Webhook test request with incomplete data', {
        missingFields,
        receivedFields: Object.keys(paymentData)
      });

      // Return success for test requests, error for actual malformed payments
      if (Object.keys(paymentData).length < 3) {
        // Likely a test request with minimal data
        return res.status(200).json({
          success: true,
          message: 'Webhook endpoint is active. Required fields for actual payments: client_id, amount'
        });
      }

      return res.status(400).json({
        error: 'Missing required fields',
        missingFields
      });
    }

    // Generate transaction ID if not provided
    if (!paymentData.transaction_id) {
      paymentData.transaction_id = `SPLYNX-${Date.now()}-${paymentData.client_id}`;
    }

    // Check if payment already exists (idempotency)
    const existingPayment = await dbHelpers.getPaymentByTransactionId(paymentData.transaction_id);

    if (existingPayment) {
      logger.warn('Payment already processed', {
        transactionId: paymentData.transaction_id,
        status: existingPayment.status
      });

      return res.status(200).json({
        message: 'Payment already processed',
        transactionId: paymentData.transaction_id,
        status: existingPayment.status
      });
    }

    // Store payment in database with pending status
    const paymentRecord = {
      transaction_id: paymentData.transaction_id,
      client_id: paymentData.client_id,
      amount: paymentData.amount,
      currency_code: paymentData.currency_code || 'KES',
      payment_type: paymentData.payment_type,
      payment_method: paymentData.payment_method || paymentData.payment_type,
      created_at: paymentData.created_at || new Date().toISOString()
    };

    await dbHelpers.insertPayment(paymentRecord);

    logger.info('Payment stored in database', {
      transactionId: paymentData.transaction_id
    });

    // Send payment to Convex (non-blocking)
    sendPaymentToConvex({
      ...paymentRecord,
      splynx_customer_id: paymentData.splynx_customer_id,
      status: 'pending',
      received_at: Date.now(),
      retry_count: 0,
    }).catch(err => {
      logger.warn('Failed to send payment to Convex:', err.message);
    });

    // Post payment to UISP
    try {
      const uispResponse = await postPaymentToUISP(paymentData);

      // Update payment status to success
      await dbHelpers.updatePaymentStatus(
        paymentData.transaction_id,
        'success',
        JSON.stringify(uispResponse),
        null
      );

      // Update payment status in Convex (non-blocking)
      updatePaymentStatusInConvex(
        paymentData.transaction_id,
        'success',
        JSON.stringify(uispResponse),
        null
      ).catch(err => {
        logger.warn('Failed to update payment status in Convex:', err.message);
      });

      // Sync client data from UISP (in background, don't wait)
      syncSingleClient(parseInt(paymentData.client_id))
        .then(() => {
          logger.info(`Client ${paymentData.client_id} synced successfully`);
          // Update last payment timestamp
          return dbHelpers.updateClientLastPayment(parseInt(paymentData.client_id));
        })
        .catch(error => {
          logger.warn(`Failed to sync client ${paymentData.client_id}:`, error.message);
        });

      const duration = Date.now() - startTime;

      logger.info('Payment successfully processed', {
        transactionId: paymentData.transaction_id,
        duration: `${duration}ms`
      });

      res.status(200).json({
        message: 'Payment successfully posted to UISP',
        transactionId: paymentData.transaction_id,
        uispPaymentId: uispResponse?.id,
        duration: `${duration}ms`
      });

    } catch (uispError) {
      // Update payment status to failed
      await dbHelpers.updatePaymentStatus(
        paymentData.transaction_id,
        'failed',
        null,
        uispError.message
      );

      // Update payment status in Convex (non-blocking)
      updatePaymentStatusInConvex(
        paymentData.transaction_id,
        'failed',
        null,
        uispError.message
      ).catch(err => {
        logger.warn('Failed to update payment status in Convex:', err.message);
      });

      logger.error('Failed to post payment to UISP', {
        transactionId: paymentData.transaction_id,
        error: uispError.message,
        stack: uispError.stack
      });

      res.status(500).json({
        error: 'Failed to post payment to UISP',
        transactionId: paymentData.transaction_id,
        message: uispError.message
      });
    }

  } catch (error) {
    logger.error('Error processing webhook', {
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * GET /webhook/payment
 * Test endpoint - browsers use GET, webhooks use POST
 */
router.get('/payment', (req, res) => {
  res.json({
    success: true,
    message: 'Webhook endpoint is active and ready to receive POST requests',
    method: 'GET (for testing)',
    note: 'Actual payments should use POST method',
    timestamp: new Date().toISOString(),
    expectedUrl: 'https://bridge-backend-0yaj.onrender.com/webhook/payment',
    correctMethod: 'POST'
  });
});

/**
 * GET /webhook/test
 * Test endpoint to verify webhook is working
 */
router.get('/test', (req, res) => {
  res.json({
    message: 'Webhook endpoint is active',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
