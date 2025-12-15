const logger = require('./logger');

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - The async function to retry
 * @param {Object} options - Retry options
 * @returns {Promise} - Result of the function
 */
async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = parseInt(process.env.MAX_RETRIES) || 3,
    initialDelay = parseInt(process.env.RETRY_DELAY_MS) || 1000,
    maxDelay = 30000,
    backoffMultiplier = 2,
    onRetry = null
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();

      if (attempt > 0) {
        logger.info(`Operation succeeded on attempt ${attempt + 1}`);
      }

      return result;
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries) {
        const delay = Math.min(
          initialDelay * Math.pow(backoffMultiplier, attempt),
          maxDelay
        );

        logger.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`, {
          error: error.message,
          attempt: attempt + 1,
          maxRetries: maxRetries + 1
        });

        if (onRetry) {
          await onRetry(attempt + 1, error);
        }

        await sleep(delay);
      } else {
        logger.error(`All ${maxRetries + 1} attempts failed`, {
          error: error.message
        });
      }
    }
  }

  throw lastError;
}

/**
 * Sleep for a specified duration
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { retryWithBackoff, sleep };
