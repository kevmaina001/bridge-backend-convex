# Splynx-UISP Payment Bridge - Backend

Payment bridge service that receives webhooks from Splynx and forwards payment notifications to UISP.

## Features

- **Webhook Processing**: Receives payment webhooks from Splynx
- **UISP Integration**: Posts payment notifications to UISP API
- **Logging System**: Comprehensive logging with Winston
- **Error Retry Logic**: Automatic retry with exponential backoff
- **Database Storage**: SQLite database for audit trail
- **Webhook Validation**: HMAC signature validation for security
- **RESTful API**: Endpoints for payment tracking and statistics

## Installation

```bash
cd backend
npm install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required environment variables:
- `UISP_APP_KEY`: Your UISP application key
- `UISP_API_URL`: UISP API endpoint URL
- `PORT`: Server port (default: 3000)

## Running the Server

Development mode with auto-reload:
```bash
npm run dev
```

Production mode:
```bash
npm start
```

## API Endpoints

### Webhook Endpoints

- `POST /webhook/payment` - Receive payment webhook from Splynx
- `GET /webhook/test` - Test webhook endpoint

### API Endpoints

- `GET /api/health` - Health check
- `GET /api/stats` - Payment statistics
- `GET /api/payments` - List all payments (with pagination)
- `GET /api/payments/:transactionId` - Get specific payment
- `GET /api/clients/:clientId/payments` - Get client payments
- `GET /api/clients/:clientId` - Get client info from UISP

## Webhook Configuration in Splynx

1. Go to Splynx Admin → Config → Integrations → Webhooks
2. Add new webhook:
   - **URL**: `https://your-domain.com/webhook/payment`
   - **Event**: Payment created / Invoice paid
   - **Method**: POST
   - **Content Type**: application/json

## Database Schema

The application uses SQLite with two main tables:

### payments
- Stores all payment records
- Tracks status (pending, success, failed)
- Records UISP responses and errors
- Maintains retry count and timestamps

### webhook_logs
- Logs all incoming webhooks
- Records validation status
- Stores payload and headers for debugging

## Error Handling

- Automatic retry with exponential backoff (up to 3 attempts)
- All errors logged to `logs/error.log`
- Failed payments stored in database for manual review

## Security

- Helmet.js for security headers
- CORS configuration
- Webhook signature validation
- Optional IP address whitelisting

## Logs

- `logs/combined.log` - All logs
- `logs/error.log` - Error logs only
- Console output in development mode
