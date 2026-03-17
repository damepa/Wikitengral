import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import * as Minio from 'minio';
import crypto from 'crypto';
import path from 'path';

const app = express();
const PORT = 3000;

// Increase JSON limit to handle large base64 payloads
app.use(express.json({ limit: '100mb' }));
app.use(cors());

// --- PostgreSQL Setup ---
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error('FATAL: DATABASE_URL environment variable is not set!');
  console.error('Please add DATABASE_URL to your environment variables in Coolify.');
  process.exit(1);
}

// Log the DB URL (masking password) for debugging
const maskedUrl = dbUrl.replace(/:([^:@]+)@/, ':****@');
console.log(`Attempting to connect to database: ${maskedUrl}`);

const pool = new Pool({
  connectionString: dbUrl,
});

async function initDB(retries = 15) {
  while (retries > 0) {
    try {
      // Test connection first
      console.log(`Connecting to PostgreSQL (Attempt ${16 - retries}/15)...`);
      const client = await pool.connect();
      console.log('Successfully connected to PostgreSQL');
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS app_data (
          key VARCHAR(255) PRIMARY KEY,
          value JSONB NOT NULL
        );
      `);
      client.release();
      console.log('Database schema initialized successfully');
      return;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`Failed to initialize database (retries left: ${retries - 1}):`, errorMessage);
      
      if (errorMessage.includes('EAI_AGAIN') || errorMessage.includes('ENOTFOUND')) {
        console.error('TROUBLESHOOTING: The hostname in your DATABASE_URL could not be resolved.');
        console.error('1. Check if your database container is running in Coolify.');
        console.error('2. Ensure your app and database are in the same Docker network.');
        console.error('3. Try using the "Internal Database URL" provided by Coolify in the database settings.');
      }

      retries -= 1;
      if (retries === 0) {
        console.error('FATAL: Could not connect to database after multiple attempts.');
      } else {
        // Wait 5 seconds before retrying
        await new Promise(res => setTimeout(res, 5000));
      }
    }
  }
}
initDB();

// --- MinIO Setup ---
// The MinIO client expects the endpoint WITHOUT http:// or https://
let rawEndpoint = process.env.MINIO_ENDPOINT || 'localhost';
const cleanEndpoint = rawEndpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');

const minioClient = new Minio.Client({
  endPoint: cleanEndpoint,
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
});

const bucketName = process.env.MINIO_BUCKET || 'wikitegral';

async function initMinio() {
  try {
    const exists = await minioClient.bucketExists(bucketName);
    if (!exists) {
      await minioClient.makeBucket(bucketName, 'us-east-1');
      console.log(`Bucket ${bucketName} created`);
    } else {
      console.log(`Bucket ${bucketName} exists`);
    }
  } catch (err) {
    console.error('Failed to initialize MinIO:', err);
  }
}
initMinio();

// --- Helper to process base64 and upload to MinIO ---
async function processDataUrls(data: any): Promise<any> {
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      data[i] = await processDataUrls(data[i]);
    }
  } else if (typeof data === 'object' && data !== null) {
    for (const key in data) {
      if (key === 'dataUrl' && typeof data[key] === 'string' && data[key].startsWith('data:')) {
        try {
          const matches = data[key].match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
          if (matches && matches.length === 3) {
            const mimeType = matches[1];
            const base64Data = matches[2];
            const buffer = Buffer.from(base64Data, 'base64');
            
            // Generate a unique filename
            const ext = mimeType.split('/')[1] || 'bin';
            const filename = `${crypto.randomUUID()}.${ext}`;
            
            // Upload to MinIO
            await minioClient.putObject(bucketName, filename, buffer, buffer.length, {
              'Content-Type': mimeType
            });
            
            // Replace dataUrl with the API endpoint to fetch the file
            data[key] = `/api/files/${filename}`;
          }
        } catch (err) {
          console.error('Error processing base64 dataUrl:', err);
        }
      } else {
        data[key] = await processDataUrls(data[key]);
      }
    }
  }
  return data;
}

// --- API Endpoints ---

// Generic GET handler
async function getFromDB(req: express.Request, res: express.Response, key: string, defaultValue: any) {
  try {
    const result = await pool.query('SELECT value FROM app_data WHERE key = $1', [key]);
    if (result.rows.length > 0) {
      res.json(result.rows[0].value);
    } else {
      res.json(defaultValue);
    }
  } catch (err) {
    console.error(`Error getting ${key}:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Generic POST handler
async function saveToDB(req: express.Request, res: express.Response, key: string) {
  try {
    let data = req.body;
    // Process any base64 files and upload them to MinIO
    data = await processDataUrls(data);
    
    await pool.query(
      'INSERT INTO app_data (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, JSON.stringify(data)]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(`Error saving ${key}:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

app.get('/api/docs', (req, res) => getFromDB(req, res, 'wikiTegralDocs', {}));
app.post('/api/docs/sync', (req, res) => saveToDB(req, res, 'wikiTegralDocs'));

app.get('/api/buildings', (req, res) => getFromDB(req, res, 'wikiTegralEdificios', []));
app.post('/api/buildings/sync', (req, res) => saveToDB(req, res, 'wikiTegralEdificios'));

app.get('/api/security', (req, res) => getFromDB(req, res, 'wikiTegralSecurity', { pinEnabled: false, pin: '', dni: '' }));
app.post('/api/security', (req, res) => saveToDB(req, res, 'wikiTegralSecurity'));

// File serving endpoint
app.get('/api/files/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const stat = await minioClient.statObject(bucketName, filename);
    res.setHeader('Content-Type', stat.metaData['content-type'] || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    
    const stream = await minioClient.getObject(bucketName, filename);
    stream.pipe(res);
  } catch (err) {
    console.error('Error serving file:', err);
    res.status(404).json({ error: 'File not found' });
  }
});

// --- Vite Integration ---
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is starting in ${process.env.NODE_ENV || 'development'} mode`);
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
