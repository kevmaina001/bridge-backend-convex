const axios = require('axios');
const logger = require('../utils/logger');

const AT_API_KEY = process.env.AFRICASTALKING_API_KEY;
const AT_USERNAME = process.env.AFRICASTALKING_USERNAME;
const AT_BASE_URL = 'https://api.africastalking.com/version1/messaging';

// Optional: Sender ID (can be configured)
const AT_SENDER_ID = process.env.AFRICASTALKING_SENDER_ID || null;

/**
 * Format phone number to Africa's Talking format (+254XXXXXXXXX)
 * @param {string} phone - Phone number
 * @returns {string} Formatted phone number
 */
function formatPhoneNumber(phone) {
  if (!phone) return null;

  // Remove all non-digit characters
  let cleaned = phone.replace(/\D/g, '');

  // Handle different formats
  if (cleaned.startsWith('254')) {
    // Already in correct format without +
    return '+' + cleaned;
  } else if (cleaned.startsWith('0')) {
    // Kenyan local format (0712345678)
    return '+254' + cleaned.substring(1);
  } else if (cleaned.length === 9) {
    // Missing country code and leading 0 (712345678)
    return '+254' + cleaned;
  }

  // Return with + if it doesn't have one
  return cleaned.startsWith('+') ? cleaned : '+' + cleaned;
}

/**
 * Send SMS using Africa's Talking API
 * @param {Array<string>} recipients - Array of phone numbers
 * @param {string} message - SMS message content
 * @param {string} senderId - Optional sender ID
 * @returns {Promise<Object>} API response
 */
async function sendSMS(recipients, message, senderId = null) {
  if (!AT_API_KEY || !AT_USERNAME) {
    throw new Error('Africa\'s Talking credentials not configured. Please set AFRICASTALKING_API_KEY and AFRICASTALKING_USERNAME in environment variables.');
  }

  if (!recipients || recipients.length === 0) {
    throw new Error('No recipients provided');
  }

  if (!message || message.trim().length === 0) {
    throw new Error('Message cannot be empty');
  }

  try {
    // Format all phone numbers
    const formattedRecipients = recipients
      .map(formatPhoneNumber)
      .filter(phone => phone !== null);

    if (formattedRecipients.length === 0) {
      throw new Error('No valid phone numbers found');
    }

    logger.info('Sending SMS via Africa\'s Talking', {
      recipientCount: formattedRecipients.length,
      messageLength: message.length
    });

    // Prepare request payload
    const payload = {
      username: AT_USERNAME,
      to: formattedRecipients.join(','),
      message: message
    };

    // Add sender ID if provided
    if (senderId || AT_SENDER_ID) {
      payload.from = senderId || AT_SENDER_ID;
    }

    // Send request to Africa's Talking
    const response = await axios.post(AT_BASE_URL, payload, {
      headers: {
        'apiKey': AT_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      timeout: 30000
    });

    logger.info('SMS sent successfully', {
      recipientCount: formattedRecipients.length,
      response: response.data
    });

    return {
      success: true,
      data: response.data,
      recipientCount: formattedRecipients.length
    };

  } catch (error) {
    logger.error('Failed to send SMS', {
      error: error.message,
      response: error.response?.data,
      stack: error.stack
    });

    throw new Error(
      error.response?.data?.message ||
      error.message ||
      'Failed to send SMS'
    );
  }
}

/**
 * Send SMS to a single recipient
 * @param {string} phone - Phone number
 * @param {string} message - SMS message content
 * @param {string} senderId - Optional sender ID
 * @returns {Promise<Object>} API response
 */
async function sendSingleSMS(phone, message, senderId = null) {
  return sendSMS([phone], message, senderId);
}

/**
 * Send bulk SMS to multiple recipients
 * @param {Array<string>} phones - Array of phone numbers
 * @param {string} message - SMS message content
 * @param {string} senderId - Optional sender ID
 * @returns {Promise<Object>} API response
 */
async function sendBulkSMS(phones, message, senderId = null) {
  // Africa's Talking supports up to 1000 recipients per request
  const MAX_BATCH_SIZE = 1000;

  if (phones.length > MAX_BATCH_SIZE) {
    // Split into batches
    const batches = [];
    for (let i = 0; i < phones.length; i += MAX_BATCH_SIZE) {
      batches.push(phones.slice(i, i + MAX_BATCH_SIZE));
    }

    logger.info(`Sending SMS in ${batches.length} batches`);

    const results = [];
    for (let i = 0; i < batches.length; i++) {
      logger.info(`Sending batch ${i + 1}/${batches.length}`);
      const result = await sendSMS(batches[i], message, senderId);
      results.push(result);
    }

    // Combine results
    const totalRecipients = results.reduce((sum, r) => sum + r.recipientCount, 0);
    return {
      success: true,
      batchCount: batches.length,
      recipientCount: totalRecipients,
      batches: results
    };
  }

  return sendSMS(phones, message, senderId);
}

/**
 * Validate Africa's Talking credentials
 * @returns {Promise<boolean>} True if credentials are valid
 */
async function validateCredentials() {
  if (!AT_API_KEY || !AT_USERNAME) {
    return false;
  }

  try {
    // Try to send a test request (to invalid number to test auth)
    await axios.post(AT_BASE_URL, {
      username: AT_USERNAME,
      to: '+254700000000',
      message: 'Test'
    }, {
      headers: {
        'apiKey': AT_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000
    });

    return true;
  } catch (error) {
    // Check if error is authentication related
    if (error.response?.status === 401 || error.response?.status === 403) {
      return false;
    }
    // Other errors might mean credentials are valid but request failed
    return true;
  }
}

module.exports = {
  sendSMS,
  sendSingleSMS,
  sendBulkSMS,
  formatPhoneNumber,
  validateCredentials
};
