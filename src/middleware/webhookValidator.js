const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Validate webhook signature from Splynx
 * This is a middleware function that validates the webhook request
 */
function validateWebhookSignature(req, res, next) {
  // If no secret is configured, skip validation (for development)
  const webhookSecret = process.env.SPLYNX_WEBHOOK_SECRET;

  if (!webhookSecret) {
    logger.warn('Webhook validation skipped: SPLYNX_WEBHOOK_SECRET not configured');
    req.webhookValidated = false;
    return next();
  }

  try {
    // Get signature from headers (adjust based on Splynx's implementation)
    // Common header names: x-splynx-signature, x-webhook-signature, x-signature
    const signature = req.headers['x-splynx-signature'] ||
                     req.headers['x-webhook-signature'] ||
                     req.headers['x-signature'];

    if (!signature) {
      logger.warn('Webhook validation failed: No signature header found');
      req.webhookValidated = false;
      return next();
    }

    // Calculate expected signature
    const payload = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(payload)
      .digest('hex');

    // Compare signatures
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );

    if (isValid) {
      logger.info('Webhook signature validated successfully');
      req.webhookValidated = true;
      next();
    } else {
      logger.error('Webhook validation failed: Invalid signature');
      req.webhookValidated = false;

      // Still allow the request but mark as unvalidated
      // Change this to reject if you want strict validation
      next();

      // Uncomment to reject invalid signatures:
      // return res.status(401).json({
      //   error: 'Invalid webhook signature'
      // });
    }
  } catch (error) {
    logger.error('Error validating webhook signature:', error);
    req.webhookValidated = false;
    next();
  }
}

/**
 * Validate request IP address (optional additional security)
 * Add allowed IP addresses in environment variables
 */
function validateIpAddress(req, res, next) {
  const allowedIps = process.env.ALLOWED_IPS ?
    process.env.ALLOWED_IPS.split(',').map(ip => ip.trim()) :
    [];

  if (allowedIps.length === 0) {
    // No IP restriction if not configured
    return next();
  }

  const clientIp = req.ip || req.connection.remoteAddress;

  if (allowedIps.includes(clientIp)) {
    logger.info(`Request from allowed IP: ${clientIp}`);
    next();
  } else {
    logger.warn(`Request from unauthorized IP: ${clientIp}`);
    res.status(403).json({
      error: 'IP address not authorized'
    });
  }
}

module.exports = {
  validateWebhookSignature,
  validateIpAddress
};
