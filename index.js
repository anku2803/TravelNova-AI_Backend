const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
console.log("API KEY =", process.env.GEMINI_API_KEY);

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable Gzip/Deflate compression for fast page loading
app.use(compression());

// Enable Helmet to set security-hardened HTTP headers (defends against XSS, clickjacking, etc.)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'", // required for page inline scripts
          "'unsafe-eval'",
          "https://code.jquery.com"
        ],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'", // required for page inline styles
          "https://cdnjs.cloudflare.com",
          "https://fonts.googleapis.com"
        ],
        fontSrc: [
          "'self'",
          "https://cdnjs.cloudflare.com",
          "https://fonts.gstatic.com"
        ],
        imgSrc: [
          "'self'",
          "data:",
          "https://images.unsplash.com",
          "https://*.unsplash.com",
          "https://api.qrserver.com"
        ],
        connectSrc: ["'self'", "http://localhost:5000"]
      }
    }
  })
);

// Custom Security Middleware: Instantly blocks and rejects any attempts to access confidential backend files/secrets
app.use((req, res, next) => {
  const urlPath = req.path.toLowerCase();
  
  // Define blocked backend paths, env secrets, git files, and configurations
  const blockedPatterns = [
    /^\/\.env/i,                      // .env secrets in root
    /^\/\.git/i,                      // git history repository metadata
    /\.sqlite$/i,                     // backend sqlite database
    /\.env$/i,                        // any other env configurations
    /^\/backend/i,                    // backend source code logic
    /^\/client\/src/i,                // client react code
    /^\/client\/node_modules/i,       // client node dependencies
    /^\/node_modules/i,               // server node dependencies
    /package(-lock)?\.json$/i         // lockfiles and package descriptions
  ];
  
  const isBlocked = blockedPatterns.some(pattern => pattern.test(urlPath));
  if (isBlocked) {
    console.warn(`[Security Alert] Blocked unauthorized client request to access confidential backend asset: ${req.path} from IP: ${req.ip}`);
    return res.status(403).json({
      ok: false,
      error: 'Forbidden: Access to confidential backend assets is restricted.'
    });
  }
  next();
});

app.use(cors());
// parse JSON bodies with 1MB size limit to prevent simple buffer/payload DOS attacks
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ limit: '1mb', extended: true }));

// handle invalid JSON body parser errors without crashing the server
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    console.error('Invalid JSON received:', err.message);
    return res.status(400).json({ ok: false, error: 'Invalid JSON in request body' });
  }
  next(err);
});

console.log('MOCK_AI =', process.env.MOCK_AI);

app.get('/api/listings', (req, res) => {
  db.all('SELECT * FROM listings ORDER BY created_at DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/listings', (req, res) => {
  const { name, email, title, description } = req.body;

  if (!name || !email || !title) {
    return res.status(400).json({ error: 'name, email and title are required' });
  }

  const stmt = db.prepare(
    'INSERT INTO listings (name, email, title, description) VALUES (?,?,?,?)'
  );

  stmt.run(name, email, title, description || '', function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID });
  });

  stmt.finalize();
});

app.delete('/api/listings/:id', (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM listings WHERE id = ?', id, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: id });
  });
});

// ==================== Bookings & Payments API Endpoints ====================

app.get('/api/bookings', (req, res) => {
  const email = req.query.email;
  if (email) {
    db.all(
      'SELECT * FROM bookings WHERE user_email = ? ORDER BY created_at DESC',
      email.toLowerCase().trim(),
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
      }
    );
  } else {
    db.all('SELECT * FROM bookings ORDER BY created_at DESC', (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  }
});

app.post('/api/bookings', (req, res) => {
  const { tour_id, tour_title, user_name, user_email, booking_date, passengers, total_price, payment_id } = req.body;

  if (!tour_id || !tour_title || !user_name || !user_email || !booking_date || !passengers || !total_price || !payment_id) {
    return res.status(400).json({ error: 'All fields including passengers, total price, and payment_id are required' });
  }

  db.serialize(() => {
    const stmt = db.prepare(
      `INSERT INTO bookings (tour_id, tour_title, user_name, user_email, booking_date, passengers, total_price, payment_status, payment_id)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );

    stmt.run(
      parseInt(tour_id),
      tour_title,
      user_name,
      user_email.toLowerCase().trim(),
      booking_date,
      parseInt(passengers),
      parseFloat(total_price),
      'Paid',
      payment_id,
      function (err) {
        if (err) {
          console.error('Error inserting booking:', err.message);
          return res.status(500).json({ error: err.message });
        }
        
        const bookingId = this.lastID;

        // Transactionally increment agency revenue balance inside my account
        db.run(
          'UPDATE merchant_account SET balance = balance + ? WHERE id = 1',
          parseFloat(total_price),
          function (err2) {
            if (err2) {
              console.error('Error updating merchant balance:', err2.message);
              return res.status(500).json({ error: err2.message });
            }
            res.json({ success: true, booking_id: bookingId, transaction_id: payment_id });
          }
        );
      }
    );
    stmt.finalize();
  });
});

app.get('/api/merchant', (req, res) => {
  db.get('SELECT balance FROM merchant_account WHERE id = 1', (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    
    db.all(
      'SELECT user_name, user_email, tour_title, total_price, payment_id, created_at FROM bookings ORDER BY created_at DESC',
      (err2, receipts) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({
          balance: row ? row.balance : 0.00,
          receipts: receipts || []
        });
      }
    );
  });
});

const clientDist = path.join(__dirname, '..', 'client', 'dist');
const rootStatic = fs.existsSync(clientDist) ? clientDist : path.join(__dirname, '..', 'frontend');

// Aggressive Cache-Control configuration for fast loading on subsequent visits
const oneYear = 31536000000; // 1 year in milliseconds
const cacheOptions = {
  maxAge: oneYear,
  immutable: true,
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    // Cache styling, scripts, images and fonts aggressively
    // Cache images and fonts aggressively
    if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.webmanifest'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (['.html', '.css', '.js'].includes(ext)) {
      // HTML, CSS, and JS files must always revalidate to show updates instantly
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  }
};

app.use(express.static(rootStatic, cacheOptions));

try {
  const aiRoutes = require('./ai_routes');
  app.use('/api/ai', aiRoutes);
} catch (e) {
  console.warn('AI routes not available:', e.message);

  const aiDisabled = express.Router();
  aiDisabled.post('/chat', (req, res) => {
    res.json({ ok: false, error: 'AI routes unavailable' });
  });

  app.use('/api/ai', aiDisabled);
}

app.get('*', (req, res) => {
  const index = path.join(rootStatic, 'index.html');

  res.sendFile(index, (err) => {
    if (err) res.status(404).send('Not found');
  });
});

const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Server running on http://${displayHost}:${PORT}`);
});

module.exports = app;