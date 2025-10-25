// FIX: Import Request, Response, and NextFunction types directly from express to resolve type errors.
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { rateLimit } from 'express-rate-limit';
import CryptoJS from 'crypto-js';

// --- TYPE DEFINITIONS ---
interface RankEntry {
  nickname: string;
  score: number;
  accuracy: number;
  maxCombo: number;
  createdAt: Timestamp;
}

// --- CONFIGURATION ---
const PORT = process.env.PORT || 8080;
const APP_API_KEY = process.env.APP_API_KEY || 'a-very-secret-key-that-should-be-in-an-env-file';
const ALLOWED_ORIGINS = (process.env.ALLOW_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',');
const MAX_RANKING_SIZE = 100;
const BANNED_WORDS = ['admin', 'root', 'system']; // Add more profanities

// --- FIREBASE INITIALIZATION ---
try {
  initializeApp({ credential: applicationDefault() });
} catch (error) {
  console.error('Firebase Admin SDK initialization failed:', error);
}
const db = getFirestore();

// --- EXPRESS APP SETUP & MIDDLEWARE ---
const app = express();
app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());
app.use(morgan('tiny'));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
});

const apiKeyMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const providedKey = req.get('X-App-Key');
  if (providedKey && providedKey === APP_API_KEY) {
    return next();
  }
  res.status(401).json({ ok: false, error: 'Unauthorized: Missing or invalid API key.' });
};

// --- API ROUTES ---
app.use('/api/', apiLimiter, apiKeyMiddleware);

app.get('/api/health', (req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

/**
 * GET /api/scores
 * Fetches the cached leaderboard for a given chartId.
 */
app.get('/api/scores', async (req: Request, res: Response) => {
  const { chartId } = req.query;
  const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string, 10), MAX_RANKING_SIZE) : MAX_RANKING_SIZE;

  if (!chartId || typeof chartId !== 'string') {
    return res.status(400).json({ ok: false, error: '`chartId` query parameter is required.' });
  }

  try {
    const rankingDocRef = db.collection('rankings').doc(chartId);
    const doc = await rankingDocRef.get();

    if (!doc.exists) {
      return res.status(200).json({ ok: true, top: [] });
    }

    const data = doc.data();
    const topScores = (data?.top || []).slice(0, limit);
    res.status(200).json({ ok: true, top: topScores });
  } catch (e) { 
    console.error(`Error fetching ranking for ${chartId}:`, e);
    res.status(500).json({ ok: false, error: 'Internal server error while fetching ranking.' });
  }
});

/**
 * POST /api/scores
 * Submits a new score, records it, and updates the cached leaderboard in a transaction.
 */
app.post('/api/scores', async (req: Request, res: Response) => {
  // --- Validation First ---
  const { nickname, chartId, score, accuracy, maxCombo, clientAt } = req.body;

  if (!nickname || typeof nickname !== 'string' || nickname.length < 2 || nickname.length > 12) {
    return res.status(400).json({ ok: false, error: 'Nickname must be 2-12 characters.' });
  }
  if (!/^[a-zA-Z0-9_가-힣]+$/.test(nickname) || BANNED_WORDS.some(word => nickname.toLowerCase().includes(word))) {
    return res.status(400).json({ ok: false, error: 'Nickname contains invalid characters or banned words.' });
  }
  if (!chartId || typeof chartId !== 'string') {
    return res.status(400).json({ ok: false, error: 'Invalid `chartId`.' });
  }
  if (score == null || typeof score !== 'number' || score <= 0 || score > 1000000) {
    return res.status(400).json({ ok: false, error: 'Score is out of range.' });
  }
  if (accuracy == null || typeof accuracy !== 'number' || accuracy < 0 || accuracy > 100) {
    return res.status(400).json({ ok: false, error: 'Accuracy is out of range.' });
  }
  if (maxCombo == null || typeof maxCombo !== 'number' || maxCombo < 0) {
    return res.status(400).json({ ok: false, error: 'Invalid `maxCombo`.' });
  }

  // --- Process after validation ---
  try {
    const ip = req.ip;
    const ua = req.get('User-Agent') || '';
    const ipHash = CryptoJS.SHA256(ip + ua).toString();

    const scoreData = {
      nickname, chartId, score, accuracy, maxCombo,
      clientAt: clientAt || Date.now(),
      createdAt: FieldValue.serverTimestamp(),
      ipHash, ua,
    };

    // --- Record Score in Ledger ---
    const scoreDocRef = await db.collection('scores').add(scoreData);

    // --- Update Ranking Cache in a Transaction ---
    const rankingDocRef = db.collection('rankings').doc(chartId);
    let newRank = -1;

    await db.runTransaction(async (transaction) => {
      const rankingDoc = await transaction.get(rankingDocRef);
      const topScores: RankEntry[] = rankingDoc.exists ? (rankingDoc.data()?.top || []) : [];

      const newEntry: RankEntry = {
          nickname, score, accuracy, maxCombo,
          createdAt: Timestamp.now() // Use a consistent timestamp for sorting
      };
      
      const existingEntryIndex = topScores.findIndex(e => e.nickname === nickname);

      if (existingEntryIndex > -1) {
        // Player already on the leaderboard, update if new score is higher
        if (topScores[existingEntryIndex].score < score) {
          topScores[existingEntryIndex] = newEntry;
        }
      } else {
        // New player
        topScores.push(newEntry);
      }
      
      // Sort by score (desc), then by time (asc for tie-breaking)
      topScores.sort((a, b) => {
          if (b.score !== a.score) {
              return b.score - a.score;
          }
          return a.createdAt.toMillis() - b.createdAt.toMillis();
      });

      const updatedTopScores = topScores.slice(0, MAX_RANKING_SIZE);
      
      const rankIndex = updatedTopScores.findIndex(e => e.nickname === nickname && e.score === score);
      if (rankIndex > -1) {
          newRank = rankIndex + 1;
      }

      if (!rankingDoc.exists) {
        transaction.set(rankingDocRef, {
          top: updatedTopScores,
          count: 1,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        transaction.update(rankingDocRef, {
          top: updatedTopScores,
          count: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });

    res.status(201).json({ ok: true, id: scoreDocRef.id, rank: newRank });

  } catch (error) {
    console.error('Error processing score submission:', error);
    res.status(500).json({ ok: false, error: 'Internal server error while submitting score.' });
  }
});

// --- SERVER START ---
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
