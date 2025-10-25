# Wash Your Feet - Backend Ranking API

This is the backend service for the "Wash Your Feet" rhythm game, built with TypeScript, Express, and Firestore. It's designed to be deployed as a serverless container on Google Cloud Run.

## Features

-   **Score Submission:** Accepts new game scores and records them securely.
-   **Real-time Leaderboards:** Maintains and serves pre-calculated leaderboards for fast client-side reads.
-   **Secure by Design:** Implements strict security rules, rate limiting, and API key validation.
-   **Scalable:** Leverages a write-optimized ledger (`scores`) and read-optimized cache (`rankings`) pattern in Firestore.

## Local Development

### Prerequisites

-   Node.js v20 or later
-   Google Cloud SDK initialized with Application Default Credentials (ADC).
    -   Run `gcloud auth application-default login`

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables

Create a `.env` file in the `wash-your-feet-backend` directory:

```env
# The port the local server will run on
PORT=8080

# The shared secret between the client and server
APP_API_KEY="a-very-secret-key-that-should-be-in-an-env-file"

# Allowed origins for CORS (comma-separated)
ALLOW_ORIGINS="http://localhost:5173,http://127.0.0.1:5173"
```
*Note: For Vite's default dev server, the port is usually `5173`.*

### 3. Run the Development Server

This command uses `ts-node` to run the TypeScript source directly with hot-reloading.

```bash
npm run dev
```

The server will be available at `http://localhost:8080`.

## API Endpoints

-   **`GET /api/health`**
    -   Health check endpoint.
    -   Response: `{ "ok": true }`

-   **`GET /api/scores?chartId=<song_name>&limit=<number>`**
    -   Fetches the leaderboard for a specific chart.
    -   `limit` is optional (defaults to 100).
    -   Response: `{ "ok": true, "top": [...] }`

-   **`POST /api/scores`**
    -   Submits a new score.
    -   Requires `X-App-Key` header.
    -   Body:
        ```json
        {
          "nickname": "RhythmKing",
          "chartId": "groove-machine-hard",
          "score": 987654,
          "accuracy": 99.8,
          "maxCombo": 543,
          "clientAt": 1678886400000
        }
        ```
    -   Response: `201 Created` with `{ "ok": true, "id": "...", "rank": 1 }`

## Deployment to Google Cloud Run

### 1. Build and Push the Container Image

Replace `$GCP_PROJECT` with your Google Cloud project ID.

```bash
gcloud builds submit --tag gcr.io/$GCP_PROJECT/wash-feet-api
```

### 2. Deploy to Cloud Run

This command deploys the container and sets the required environment variables.

```bash
gcloud run deploy wash-feet-api \
  --image gcr.io/$GCP_PROJECT/wash-feet-api \
  --platform managed \
  --region asia-northeast3 \
  --allow-unauthenticated \
  --set-env-vars="APP_API_KEY=YOUR_SECURE_API_KEY,ALLOW_ORIGINS=https://your-frontend-app-url.com"
```
- **`--allow-unauthenticated`**: Allows public access to the API. Access control is handled by the API key middleware.
- **`--set-env-vars`**: Set your actual production API key and the URL of your deployed frontend application.

### 3. Deploy Firestore Rules and Indexes

From the root of your Firebase project directory:

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

This will apply the security rules from `firestore.rules` and create the necessary indexes from `firestore.indexes.json`.
