import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { Pool } from 'pg';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { S3Client } from '@aws-sdk/client-s3';
import multerS3 from 'multer-s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// ============== PALMPESA PRODUCTION CONFIG ==============
const PALMPESA_BASE_URL = process.env.PALMPESA_BASE_URL || 'https://palmpesa.drmlelwa.co.tz';
const PALMPESA_API_TOKEN = process.env.PALMPESA_API_TOKEN;
const PALMPESA_DEFAULT_ADDRESS = process.env.PALMPESA_DEFAULT_ADDRESS || 'Tanzania';
const PALMPESA_DEFAULT_POSTCODE = process.env.PALMPESA_DEFAULT_POSTCODE;

const requirePalmPesaConfig = () => {
    if (!PALMPESA_API_TOKEN) {
        throw new Error('PALMPESA_API_TOKEN is not configured');
    }
    if (!PALMPESA_DEFAULT_POSTCODE) {
        throw new Error('PALMPESA_DEFAULT_POSTCODE is not configured');
    }
    if (!process.env.PALMPESA_CALLBACK_URL) {
        throw new Error('PALMPESA_CALLBACK_URL is not configured');
    }
};

const palmPesaHeaders = () => ({
    'Authorization': `Bearer ${PALMPESA_API_TOKEN}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
});

const palmPesaRequest = async (endpoint, options = {}) => {
    const response = await fetch(`${PALMPESA_BASE_URL}${endpoint}`, {
        ...options,
        headers: {
            ...palmPesaHeaders(),
            ...(options.headers || {})
        }
    });

    const raw = await response.text();
    let data = {};
    try {
        data = raw ? JSON.parse(raw) : {};
    } catch {
        data = { raw };
    }

    if (!response.ok) {
        throw new Error(`PalmPesa ${response.status}: ${data?.message || data?.error || raw || 'Request failed'}`);
    }

    return data;
};

const normalizeTanzaniaPhone = (phone) => {
    let value = String(phone || '').trim().replace(/\s+/g, '').replace(/-/g, '');

    if (value.startsWith('+255')) value = value.substring(1);
    else if (value.startsWith('255')) value = value;
    else if (value.startsWith('0')) value = `255${value.substring(1)}`;
    else throw new Error('Invalid Tanzania phone number');

    if (!/^255[67]\d{8}$/.test(value)) {
        throw new Error('Invalid Tanzania mobile number');
    }

    return value;
};

const extractPalmPesaStatus = (data) => {
    const item = data?.data?.[0] || data?.data || {};
    const status = String(
        data?.payment_status ||
        data?.status ||
        item?.payment_status ||
        item?.status ||
        ''
    ).toUpperCase();

    return {
        status,
        orderId: data?.order_id || item?.order_id || null,
        transactionId: data?.transid || item?.transid || null,
        reference: data?.reference || item?.reference || null,
        channel: data?.channel || item?.channel || null,
        amount: data?.amount || item?.amount || null
    };
};

const app = express();
const server = http.createServer(app);
app.set('trust proxy', 1);

// ============== SOCKET.IO SETUP ==============
const io = new Server(server, {
    cors: {
        origin: process.env.CLIENT_URL || ( process.env.NODE_ENV === 'production' 
            ? 'https://chat-production-4a8c.up.railway.app' 
            : 'http://localhost:3000' ),
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
});

// ============== DATABASE ==============
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'waudhao',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '45Ngalula',
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// ============== SESSION STORE ==============
const PgSession = pgSession(session);
const sessionStore = new PgSession({
    pool: pool,
    tableName: 'session',
    createTableIfMissing: true,
    pruneSessionInterval: 60,
});

const isProduction = process.env.NODE_ENV === 'production';

const sessionMiddleware = session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
        secure: isProduction,
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 * 7,
        sameSite: isProduction ? 'none' : 'lax'
    },
    name: 'neveralone.sid',
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// ============== FILE UPLOAD SETUP ==============
const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

const fileFilter = (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
    if (allowed.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type'), false);
    }
};

const upload = multer({
    storage: multerS3({
        s3: s3,
        bucket: process.env.R2_BUCKET_NAME,
        metadata: (req, file, cb) => {
            cb(null, { fieldName: file.fieldname });
        },
        key: (req, file, cb) => {
            let folder = 'misc/';
            if (file.fieldname === 'profile_pic') folder = 'profiles/';
            else if (file.fieldname === 'product_image') folder = 'products/';
            else if (file.fieldname === 'image' || file.fieldname === 'file') folder = 'blog/';

            const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, folder + unique + path.extname(file.originalname));
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: fileFilter,
});

// ============== MIDDLEWARE ==============
app.use(cors({
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============== DATABASE INIT ==============
async function initDatabase() {
    try {
        // Users table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                profile_pic VARCHAR(255),
                is_admin BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Subscriptions table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                plan VARCHAR(20) NOT NULL CHECK (plan IN ('daily', 'monthly', 'yearly')),
                amount DECIMAL(10,2) NOT NULL,
                payment_method VARCHAR(50) DEFAULT 'palmpesa',
                payment_reference VARCHAR(100),
                palmpesa_order_id VARCHAR(100),
                palmpesa_transaction_id VARCHAR(100),
                palmpesa_reference VARCHAR(100),
                status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
                starts_at TIMESTAMP,
                expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Products table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                title VARCHAR(200) NOT NULL,
                description TEXT,
                price DECIMAL(10,2) NOT NULL,
                category VARCHAR(50),
                media_path VARCHAR(255),
                status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'sold')),
                views INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Messages table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                username VARCHAR(50) NOT NULL,
                message TEXT NOT NULL,
                file_path VARCHAR(255),
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Blog posts table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS blog_posts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                username VARCHAR(50) NOT NULL,
                title VARCHAR(200) NOT NULL,
                content TEXT NOT NULL,
                category VARCHAR(50),
                price DECIMAL(10,2) DEFAULT 0,
                media_path VARCHAR(255),
                media_type VARCHAR(20),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Blog comments table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS blog_comments (
                id SERIAL PRIMARY KEY,
                post_id INTEGER REFERENCES blog_posts(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                username VARCHAR(50) NOT NULL,
                comment TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Product comments table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS product_comments (
                id SERIAL PRIMARY KEY,
                product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                username VARCHAR(50) NOT NULL,
                comment TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Activity logs table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                username VARCHAR(50),
                action VARCHAR(100) NOT NULL,
                details TEXT,
                ip_address VARCHAR(45),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Upgrade older subscription tables without destroying existing data.
        await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS palmpesa_order_id VARCHAR(100)`);
        await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS palmpesa_transaction_id VARCHAR(100)`);
        await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS palmpesa_reference VARCHAR(100)`);
        await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
        await pool.query(`ALTER TABLE subscriptions ALTER COLUMN starts_at DROP NOT NULL`);
        await pool.query(`ALTER TABLE subscriptions ALTER COLUMN expires_at DROP NOT NULL`);

        // Indexes
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_products_user_id ON products(user_id);
            CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
            CREATE INDEX IF NOT EXISTS idx_blog_posts_created_at ON blog_posts(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
            CREATE INDEX IF NOT EXISTS idx_subscriptions_expires_at ON subscriptions(expires_at);
        `);

        // Create admin user if not exists
        const adminCheck = await pool.query('SELECT id FROM users WHERE username = $1', ['Jaguar45']);
        if (adminCheck.rows.length === 0) {
            const hash = await bcrypt.hash('?phillipoKefren6', 10);
            await pool.query(
                'INSERT INTO users (username, email, password_hash, is_admin) VALUES ($1, $2, $3, $4)',
                ['jaguar45', 'sambahustler@gmail.com', hash, true]
            );
            console.log('✅ Admin user created');
        }

        console.log('✅ Database initialized successfully');
    } catch (err) {
        console.error('❌ Database initialization error:', err);
        throw err;
    }
}

pool.query('SELECT current_database() AS database_name')
  .then(result => {
    console.log(`🗄️ Database connected: ${result.rows[0].database_name}`);
  })
  .catch(err => {
    console.error('❌ Could not determine database name:', err.message);
  });

// ============== HELPER FUNCTIONS ==============
const requireAuth = (req, res, next) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

const requireAdmin = async (req, res, next) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.session.userId]);
        if (!result.rows[0]?.is_admin) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
};

const logActivity = async (userId, username, action, details = '', ipAddress = '') => {
    try {
        await pool.query(
            'INSERT INTO activity_logs (user_id, username, action, details, ip_address) VALUES ($1, $2, $3, $4, $5)',
            [userId, username, action, details, ipAddress]
        );
    } catch (err) {
        console.error('Failed to log activity:', err);
    }
};

const getClientIP = (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0] || 
           req.headers['x-real-ip'] || 
           req.connection?.remoteAddress || 
           req.socket?.remoteAddress || 
           'unknown';
};

// ============== AUTH ROUTES ==============
app.post('/api/register', upload.single('profile_pic'), async (req, res) => {
    const { username, email, password, confirm } = req.body;
    
    if (!username || !email || !password || !confirm) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (password !== confirm) {
        return res.status(400).json({ error: 'Passwords do not match' });
    }
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
        return res.status(400).json({ error: 'Username must be 3-30 characters (letters, numbers, underscore)' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
    }

    try {
        const userCheck = await pool.query(
            'SELECT id FROM users WHERE username = $1 OR email = $2',
            [username.toLowerCase(), email.toLowerCase()]
        );
        if (userCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }

        const salt = await bcrypt.genSalt(12);
        const passwordHash = await bcrypt.hash(password, salt);

        let profilePic = null;
        if (req.file) {
            profilePic = req.file.filename;
        }

        const result = await pool.query(
            'INSERT INTO users (username, email, password_hash, profile_pic) VALUES ($1, $2, $3, $4) RETURNING id, username, email, profile_pic',
            [username.toLowerCase(), email.toLowerCase(), passwordHash, profilePic]
        );

        req.session.userId = result.rows[0].id;
        req.session.username = result.rows[0].username;

        await new Promise((resolve, reject) => {
            req.session.save((err) => {
                if (err) {
                    console.error('❌ Registration session save error:', err);
                    reject(err);
                } else {
                    console.log('✅ Registration session saved:', req.sessionID);
                    resolve();
                }
            });
        });

        await logActivity(result.rows[0].id, username, 'register', 'User registered', getClientIP(req));

        res.status(201).json({
            success: true,
            message: 'Registration successful',
            user: result.rows[0]
        });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    try {
        const result = await pool.query(
            'SELECT id, username, email, password_hash, profile_pic, is_admin FROM users WHERE username = $1',
            [username.toLowerCase()]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);

        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        await pool.query(
            'UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE id = $1',
            [user.id]
        );

        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.isAdmin = user.is_admin;

        await new Promise((resolve, reject) => {
            req.session.save((err) => {
                if (err) {
                    console.error('❌ Session save error:', err);
                    reject(err);
                } else {
                    console.log('✅ Login session saved:', {
                        userId: req.session.userId,
                        username: req.session.username,
                        isAdmin: req.session.isAdmin,
                        sessionID: req.sessionID
                    });
                    resolve();
                }
            });
        });

        await logActivity(user.id, user.username, 'login', 'User logged in', getClientIP(req));

        res.json({
            success: true,
            message: 'Login successful',
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                profile_pic: user.profile_pic,
                is_admin: user.is_admin
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Logout failed' });
        }
        res.json({ success: true, message: 'Logout successful' });
    });
});

app.get('/api/check-auth', (req, res) => {
    console.log('🔐 AUTH CHECK:', {
        sessionID: req.sessionID,
        userId: req.session?.userId,
        username: req.session?.username,
        isAdmin: req.session?.isAdmin,
        hasSession: !!req.session
    });

    if (req.session?.userId) {
        return res.json({
            authenticated: true,
            userId: req.session.userId,
            username: req.session.username,
            isAdmin: req.session.isAdmin || false
        });
    }

    return res.json({
        authenticated: false
    });
});

// ============== USER ROUTES ==============
app.get('/api/users', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, email, profile_pic, is_admin, created_at FROM users ORDER BY username'
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/user/profile', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, email, profile_pic, is_admin, created_at FROM users WHERE id = $1',
            [req.session.userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/user/profile', requireAuth, upload.single('profile_pic'), async (req, res) => {
    const { email } = req.body;
    let profilePic = null;

    try {
        if (req.file) {
            profilePic = req.file.filename;
            // Delete old profile pic
            const old = await pool.query('SELECT profile_pic FROM users WHERE id = $1', [req.session.userId]);
            if (old.rows[0]?.profile_pic) {
                const oldPath = path.join('public/uploads/profiles/', old.rows[0].profile_pic);
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            }
        }

        let query = 'UPDATE users SET ';
        const params = [];
        let idx = 1;

        if (email) {
            query += `email = $${idx}, `;
            params.push(email.toLowerCase());
            idx++;
        }
        if (profilePic) {
            query += `profile_pic = $${idx}, `;
            params.push(profilePic);
            idx++;
        }

        if (params.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        query = query.slice(0, -2) + ` WHERE id = $${idx} RETURNING id, username, email, profile_pic`;
        params.push(req.session.userId);

        const result = await pool.query(query, params);
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error('Profile update error:', err);
        res.status(500).json({ error: 'Update failed' });
    }
});

// ============== SUBSCRIPTION ROUTES ==============
const subscriptionPrices = { daily: 2000, monthly: 20000, yearly: 100000 };
const subscriptionDurations = { daily: 1, monthly: 30, yearly: 365 };

const emitSubscriptionUpdate = async (subscriptionId) => {
    const result = await pool.query(
        `SELECT s.*, u.username
         FROM subscriptions s
         LEFT JOIN users u ON u.id = s.user_id
         WHERE s.id = $1`,
        [subscriptionId]
    );

    if (result.rows.length > 0) {
        const sub = result.rows[0];
        io.to(`user:${sub.user_id}`).emit('subscription update', {
            subscription_id: sub.id,
            status: sub.status,
            plan: sub.plan,
            amount: Number(sub.amount),
            payment_reference: sub.payment_reference,
            palmpesa_order_id: sub.palmpesa_order_id,
            palmpesa_transaction_id: sub.palmpesa_transaction_id,
            starts_at: sub.starts_at,
            expires_at: sub.expires_at
        });
    }
};

const verifyPalmPesaOrder = async (orderId) => {
    const data = await palmPesaRequest('/api/order-status', {
        method: 'POST',
        body: JSON.stringify({ order_id: orderId })
    });

    return extractPalmPesaStatus(data);
};

const completeSubscriptionPayment = async ({
    subscriptionId,
    orderId,
    transactionId = null,
    palmReference = null,
    channel = null
}) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const subResult = await client.query(
            `SELECT *
             FROM subscriptions
             WHERE id = $1
             FOR UPDATE`,
            [subscriptionId]
        );

        if (subResult.rows.length === 0) {
            throw new Error('Subscription not found');
        }

        const sub = subResult.rows[0];

        // Idempotency: a webhook/poll may arrive more than once.
        if (sub.status === 'completed') {
            await client.query('COMMIT');
            return sub;
        }

        const startsAt = new Date();
        const expiresAt = new Date(startsAt);
        expiresAt.setDate(expiresAt.getDate() + subscriptionDurations[sub.plan]);

        const update = await client.query(
            `UPDATE subscriptions
             SET status = 'completed',
                 starts_at = $1,
                 expires_at = $2,
                 palmpesa_order_id = COALESCE($3, palmpesa_order_id),
                 palmpesa_transaction_id = COALESCE($4, palmpesa_transaction_id),
                 palmpesa_reference = COALESCE($5, palmpesa_reference),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $6
             RETURNING *`,
            [
                startsAt,
                expiresAt,
                orderId,
                transactionId,
                palmReference,
                subscriptionId
            ]
        );

        await client.query('COMMIT');

        const completed = update.rows[0];

        await logActivity(
            completed.user_id,
            'system',
            'subscription_completed',
            `Plan: ${completed.plan}, Amount: ${completed.amount} TSh, PalmPesa order: ${orderId}, TX: ${transactionId || 'N/A'}, Channel: ${channel || 'N/A'}`,
            'palmpesa-webhook'
        );

        await emitSubscriptionUpdate(completed.id);
        return completed;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

const failSubscriptionPayment = async ({ subscriptionId, orderId, transactionId = null, palmReference = null }) => {
    const result = await pool.query(
        `UPDATE subscriptions
         SET status = 'failed',
             palmpesa_order_id = COALESCE($1, palmpesa_order_id),
             palmpesa_transaction_id = COALESCE($2, palmpesa_transaction_id),
             palmpesa_reference = COALESCE($3, palmpesa_reference),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4
           AND status = 'pending'
         RETURNING *`,
        [orderId, transactionId, palmReference, subscriptionId]
    );

    if (result.rows.length > 0) {
        await emitSubscriptionUpdate(subscriptionId);
    }

    return result.rows[0] || null;
};

app.get('/api/subscription/status', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM subscriptions
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 1`,
            [req.session.userId]
        );

        if (result.rows.length === 0) {
            return res.json({ active: false, payment_status: null });
        }

        const sub = result.rows[0];

        if (sub.status === 'completed' && sub.expires_at && new Date(sub.expires_at) > new Date()) {
            const timeLeft = Math.max(0, new Date(sub.expires_at) - new Date());

            return res.json({
                active: true,
                plan: sub.plan,
                expires_at: sub.expires_at,
                time_left_ms: timeLeft,
                time_left_days: Math.ceil(timeLeft / (1000 * 60 * 60 * 24)),
                payment_status: 'completed',
                payment_reference: sub.payment_reference,
                palmpesa_order_id: sub.palmpesa_order_id,
                palmpesa_transaction_id: sub.palmpesa_transaction_id
            });
        }

        res.json({
            active: false,
            plan: sub.plan,
            payment_status: sub.status,
            payment_reference: sub.payment_reference,
            palmpesa_order_id: sub.palmpesa_order_id,
            palmpesa_transaction_id: sub.palmpesa_transaction_id
        });
    } catch (err) {
        console.error('Subscription status error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/subscription/create', requireAuth, async (req, res) => {
    const { plan, phone, address, postcode } = req.body;

    if (!Object.prototype.hasOwnProperty.call(subscriptionPrices, plan)) {
        return res.status(400).json({ error: 'Invalid plan' });
    }

    try {
        requirePalmPesaConfig();

        const normalizedPhone = normalizeTanzaniaPhone(phone);

        const active = await pool.query(
            `SELECT id
             FROM subscriptions
             WHERE user_id = $1
               AND status = 'completed'
               AND expires_at > NOW()
             LIMIT 1`,
            [req.session.userId]
        );

        if (active.rows.length > 0) {
            return res.status(400).json({ error: 'You already have an active subscription' });
        }

        const userResult = await pool.query(
            'SELECT id, username, email FROM users WHERE id = $1',
            [req.session.userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userResult.rows[0];
        const amount = subscriptionPrices[plan];

        // Unique merchant reference. It is safe to retry status checks using this ID.
        const paymentReference = `SUB-${req.session.userId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

        // IMPORTANT: expiry is NULL until PalmPesa confirms payment.
        // This prevents a pending payment from consuming subscription time.
        const pending = await pool.query(
            `INSERT INTO subscriptions
                (user_id, plan, amount, payment_method, payment_reference, status, starts_at, expires_at)
             VALUES ($1, $2, $3, 'palmpesa', $4, 'pending', NULL, NULL)
             RETURNING *`,
            [req.session.userId, plan, amount, paymentReference]
        );

        const subscription = pending.rows[0];

        try {
            // Ensure the name string has at least two words to satisfy PalmPesa validation rules
            let formattedName = String(user.username || 'Valued Customer').trim();
            if (!formattedName.includes(' ')) {
                formattedName = `${formattedName} Customer`; // Append a second word if missing
            }

            const paymentData = await palmPesaRequest('/api/palmpesa/initiate', {
                method: 'POST',
                body: JSON.stringify({
                    name: formattedName,
                    email: user.email,
                    phone: normalizedPhone,
                    amount,
                    transaction_id: paymentReference,
                    address: address || PALMPESA_DEFAULT_ADDRESS,
                    postcode: postcode || PALMPESA_DEFAULT_POSTCODE,
                    callback_url: process.env.PALMPESA_CALLBACK_URL
                })
            });

            const orderId =
                paymentData?.order_id ||
                paymentData?.response?.order_id ||
                paymentData?.data?.order_id;

            const transactionId =
                paymentData?.response?.transid ||
                paymentData?.data?.transid ||
                null;

            const palmReference =
                paymentData?.response?.reference ||
                paymentData?.data?.reference ||
                null;

            if (!orderId) {
                throw new Error('PalmPesa did not return an order_id');
            }

            const updated = await pool.query(
                `UPDATE subscriptions
                 SET palmpesa_order_id = $1,
                     palmpesa_transaction_id = COALESCE($2, palmpesa_transaction_id),
                     palmpesa_reference = COALESCE($3, palmpesa_reference),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $4
                 RETURNING *`,
                [orderId, transactionId, palmReference, subscription.id]
            );

            await logActivity(
                req.session.userId,
                req.session.username,
                'subscription_payment_initiated',
                `Plan: ${plan}, Amount: ${amount} TSh, PalmPesa order: ${orderId}`,
                getClientIP(req)
            );

            res.status(201).json({
                success: true,
                subscription: updated.rows[0],
                payment_reference: paymentReference,
                palmpesa_order_id: orderId,
                amount,
                payment_status: 'pending',
                message: 'Payment request sent. Approve the mobile-money prompt on your phone.'
            });
        } catch (paymentError) {
            await pool.query(
                `UPDATE subscriptions
                 SET status = 'failed', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1 AND status = 'pending'`,
                [subscription.id]
            );

            throw paymentError;
        }
    } catch (err) {
        console.error('Subscription payment initiation error:', err);
        res.status(502).json({
            error: 'Could not initiate PalmPesa payment',
            details: process.env.NODE_ENV === 'production' ? undefined : err.message
        });
    }
});

// PalmPesa asynchronous webhook.
// The callback is NOT trusted by itself: after receiving it, the server verifies
// the order against PalmPesa's order-status endpoint before activating the subscription.
app.post('/api/payment/webhook', async (req, res) => {
    try {
        const callback = req.body || {};
        const callbackOrderId =
            callback?.order_id ||
            callback?.data?.[0]?.order_id ||
            callback?.data?.order_id;

        const callbackStatus = String(
            callback?.payment_status ||
            callback?.status ||
            callback?.data?.[0]?.payment_status ||
            ''
        ).toUpperCase();

        if (!callbackOrderId) {
            return res.status(400).json({ error: 'Missing PalmPesa order_id' });
        }

        const subResult = await pool.query(
            `SELECT id, user_id, status
             FROM subscriptions
             WHERE palmpesa_order_id = $1
                OR payment_reference = $2
             ORDER BY created_at DESC
             LIMIT 1`,
            [callbackOrderId, callbackOrderId]
        );

        if (subResult.rows.length === 0) {
            return res.status(404).json({ error: 'Subscription not found' });
        }

        const sub = subResult.rows[0];

        // Verify with PalmPesa instead of activating from an unverified callback.
        const verified = await verifyPalmPesaOrder(callbackOrderId);

        if (verified.status === 'COMPLETED') {
            await completeSubscriptionPayment({
                subscriptionId: sub.id,
                orderId: verified.orderId || callbackOrderId,
                transactionId: verified.transactionId || null,
                palmReference: verified.reference || null,
                channel: verified.channel || null
            });

            return res.status(200).json({ success: true, status: 'completed' });
        }

        if (verified.status === 'FAILED') {
            await failSubscriptionPayment({
                subscriptionId: sub.id,
                orderId: verified.orderId || callbackOrderId,
                transactionId: verified.transactionId || null,
                palmReference: verified.reference || null
            });

            return res.status(200).json({ success: true, status: 'failed' });
        }

        // PENDING or unknown: leave it pending and let the client/status endpoint poll.
        console.log('PalmPesa webhook received while payment is still pending:', {
            orderId: callbackOrderId,
            callbackStatus,
            verifiedStatus: verified.status
        });

        return res.status(200).json({ success: true, status: 'pending' });
    } catch (err) {
        console.error('PalmPesa webhook error:', err);
        // Return non-2xx so the provider can retry if its webhook system supports retries.
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// Status endpoint for frontend fallback polling.
// It also verifies pending orders directly against PalmPesa, so activation does
// not depend solely on webhook delivery.
app.get('/api/subscription/payment-status/:subscriptionId', requireAuth, async (req, res) => {
    try {
        requirePalmPesaConfig();

        const result = await pool.query(
            `SELECT *
             FROM subscriptions
             WHERE id = $1 AND user_id = $2`,
            [req.params.subscriptionId, req.session.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Subscription not found' });
        }

        const sub = result.rows[0];

        if (sub.status === 'pending' && sub.palmpesa_order_id) {
            const verified = await verifyPalmPesaOrder(sub.palmpesa_order_id);

            if (verified.status === 'COMPLETED') {
                const completed = await completeSubscriptionPayment({
                    subscriptionId: sub.id,
                    orderId: verified.orderId || sub.palmpesa_order_id,
                    transactionId: verified.transactionId || null,
                    palmReference: verified.reference || null,
                    channel: verified.channel || null
                });

                return res.json({
                    success: true,
                    status: completed.status,
                    subscription: completed
                });
            }

            if (verified.status === 'FAILED') {
                const failed = await failSubscriptionPayment({
                    subscriptionId: sub.id,
                    orderId: verified.orderId || sub.palmpesa_order_id,
                    transactionId: verified.transactionId || null,
                    palmReference: verified.reference || null
                });

                return res.json({
                    success: true,
                    status: failed?.status || 'failed',
                    subscription: failed
                });
            }
        }

        res.json({
            success: true,
            status: sub.status,
            subscription: sub
        });
    } catch (err) {
        console.error('PalmPesa payment-status error:', err);
        res.status(502).json({
            error: 'Could not verify PalmPesa payment',
            details: process.env.NODE_ENV === 'production' ? undefined : err.message
        });
    }
});

// ============== PRODUCT ROUTES ==============
app.get('/api/products', async (req, res) => {
    const { search, category, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    try {
        let query = `SELECT p.*, u.username, u.profile_pic 
                     FROM products p 
                     LEFT JOIN users u ON p.user_id = u.id 
                     WHERE p.status = 'active'`;
        const params = [];
        let idx = 1;

        if (search) {
            query += ` AND (p.title ILIKE $${idx} OR p.description ILIKE $${idx})`;
            params.push(`%${search}%`);
            idx++;
        }

        if (category && category !== 'all') {
            query += ` AND p.category = $${idx}`;
            params.push(category);
            idx++;
        }

        query += ` ORDER BY p.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);

        // Get total count
        let countQuery = 'SELECT COUNT(*) FROM products WHERE status = $1';
        const countParams = ['active'];
        if (search) {
            countQuery += ' AND (title ILIKE $2 OR description ILIKE $2)';
            countParams.push(`%${search}%`);
        }
        if (category && category !== 'all') {
            countQuery += ' AND category = $3';
            countParams.push(category);
        }
        const countResult = await pool.query(countQuery, countParams);

        res.json({
            products: result.rows,
            total: parseInt(countResult.rows[0].count),
            page: parseInt(page),
            totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
        });
    } catch (err) {
        console.error('Products fetch error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/products/:id', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT p.*, u.username, u.profile_pic 
             FROM products p 
             LEFT JOIN users u ON p.user_id = u.id 
             WHERE p.id = $1`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        
        // Increment views
        await pool.query('UPDATE products SET views = views + 1 WHERE id = $1', [req.params.id]);
        
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/products', requireAuth, upload.single('product_image'), async (req, res) => {
    const { title, description, price, category } = req.body;

    if (!title || !price || !category) {
        return res.status(400).json({ error: 'Title, price, and category are required' });
    }

    // Check subscription
    const subCheck = await pool.query(
        'SELECT id FROM subscriptions WHERE user_id = $1 AND status = $2 AND expires_at > NOW()',
        [req.session.userId, 'completed']
    );

    if (subCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Active subscription required to post products' });
    }

    try {
        let mediaPath = null;
        if (req.file) {
            mediaPath = req.file.filename;
        }

        const result = await pool.query(
            `INSERT INTO products (user_id, title, description, price, category, media_path) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [req.session.userId, title, description, parseFloat(price), category, mediaPath]
        );

        await logActivity(req.session.userId, req.session.username, 'product_created', 
            `Product: ${title}`, getClientIP(req));

        res.status(201).json({ success: true, product: result.rows[0] });
    } catch (err) {
        console.error('Product creation error:', err);
        res.status(500).json({ error: 'Failed to create product' });
    }
});

app.delete('/api/products/:id', requireAuth, async (req, res) => {
    try {
        const check = await pool.query(
            'SELECT user_id FROM products WHERE id = $1',
            [req.params.id]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        if (check.rows[0].user_id !== req.session.userId) {
            return res.status(403).json({ error: 'Not your product' });
        }

        await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Delete failed' });
    }
});

// ============== MESSAGE ROUTES ==============
app.get('/api/messages', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT m.*, u.profile_pic 
             FROM messages m 
             LEFT JOIN users u ON m.user_id = u.id 
             ORDER BY m.timestamp DESC LIMIT 50`
        );
        res.json(result.rows.reverse());
    } catch (err) {
        console.error('Error fetching messages:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/messages', requireAuth, upload.single('chat_file'), async (req, res) => {
    const { message } = req.body;

    if (!message && !req.file) {
        return res.status(400).json({ error: 'Message or file required' });
    }

    try {
        let filePath = null;
        if (req.file) {
            filePath = req.file.filename;
        }

        const result = await pool.query(
            'INSERT INTO messages (user_id, username, message, file_path) VALUES ($1, $2, $3, $4) RETURNING *',
            [req.session.userId, req.session.username, message || '', filePath]
        );

        const newMessage = result.rows[0];
        io.emit('receive message', newMessage);
        res.status(201).json(newMessage);
    } catch (err) {
        console.error('Error saving message:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// ============== BLOG ROUTES ==============
app.get('/api/blog', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT b.*, u.username, u.profile_pic 
             FROM blog_posts b 
             LEFT JOIN users u ON b.user_id = u.id 
             ORDER BY b.created_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/blog', requireAuth, upload.single('image'), async (req, res) => {
    const { title, content, category, price } = req.body;

    if (!title || !content || !category) {
        return res.status(400).json({ error: 'Title, content, and category required' });
    }

    const subCheck = await pool.query(
        'SELECT id FROM subscriptions WHERE user_id = $1 AND status = $2 AND expires_at > NOW()',
        [req.session.userId, 'completed']
    );
    if (subCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Active subscription required to create blog posts' });
    }

    try {
        let mediaPath = null;
        let mediaType = null;
        if (req.file) {
            mediaPath = req.file.filename;
            mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';
        }

        const result = await pool.query(
            `INSERT INTO blog_posts (user_id, username, title, content, category, price, media_path, media_type) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [req.session.userId, req.session.username, title, content, category, parseFloat(price) || 0, mediaPath, mediaType]
        );

        await logActivity(req.session.userId, req.session.username, 'blog_posted', 
            `Post: ${title}`, getClientIP(req));

        res.status(201).json({ success: true, post: result.rows[0] });
    } catch (err) {
        console.error('Blog post error:', err);
        res.status(500).json({ error: 'Failed to create post' });
    }
});

app.delete('/api/blog/:id', requireAuth, async (req, res) => {
    try {
        const check = await pool.query(
            'SELECT user_id FROM blog_posts WHERE id = $1',
            [req.params.id]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Post not found' });
        }
        if (check.rows[0].user_id !== req.session.userId) {
            return res.status(403).json({ error: 'Not your post' });
        }

        await pool.query('DELETE FROM blog_posts WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Delete failed' });
    }
});

// Blog comments
app.post('/api/blog/:id/comment', requireAuth, async (req, res) => {
    const { comment } = req.body;
    const postId = req.params.id;

    if (!comment) {
        return res.status(400).json({ error: 'Comment required' });
    }

    try {
        const result = await pool.query(
            `INSERT INTO blog_comments (post_id, user_id, username, comment) 
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [postId, req.session.userId, req.session.username, comment]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Comment failed' });
    }
});

app.get('/api/blog/:id/comments', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT c.*, u.profile_pic 
             FROM blog_comments c 
             LEFT JOIN users u ON c.user_id = u.id 
             WHERE c.post_id = $1 
             ORDER BY c.created_at ASC`,
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ============== ADMIN ROUTES ==============
app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [users, products, subscriptions, messages, revenue] = await Promise.all([
            pool.query('SELECT COUNT(*) FROM users'),
            pool.query('SELECT COUNT(*) FROM products'),
            pool.query('SELECT COUNT(*) FROM subscriptions WHERE status = $1 AND expires_at > NOW()', ['completed']),
            pool.query('SELECT COUNT(*) FROM messages'),
            pool.query('SELECT COALESCE(SUM(amount), 0) FROM subscriptions WHERE status = $1', ['completed'])
        ]);

        // Subscription breakdown
        const subBreakdown = await pool.query(
            `SELECT plan, COUNT(*) FROM subscriptions 
             WHERE status = $1 AND expires_at > NOW() 
             GROUP BY plan`,
            ['completed']
        );

        res.json({
            users: parseInt(users.rows[0].count),
            products: parseInt(products.rows[0].count),
            subscribers: parseInt(subscriptions.rows[0].count),
            messages: parseInt(messages.rows[0].count),
            revenue: parseFloat(revenue.rows[0].coalesce),
            subscription_breakdown: subBreakdown.rows
        });
    } catch (err) {
        console.error('Admin stats error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    const { search, plan, role, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    try {
        let query = `SELECT u.*, 
                     s.plan as subscription_plan, s.expires_at as subscription_expiry,
                     CASE WHEN s.expires_at > NOW() THEN 'active' 
                          WHEN s.expires_at IS NOT NULL THEN 'expired' 
                          ELSE 'free' END as sub_status
                     FROM users u
                     LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'completed'`;
        const params = [];
        let idx = 1;
        const conditions = [];

        if (search) {
            conditions.push(`(u.username ILIKE $${idx} OR u.email ILIKE $${idx})`);
            params.push(`%${search}%`);
            idx++;
        }

        if (plan && plan !== 'free') {
            conditions.push(`s.plan = $${idx}`);
            params.push(plan);
            idx++;
        } else if (plan === 'free') {
            conditions.push(`s.id IS NULL`);
        }

        if (role === 'admin') {
            conditions.push(`u.is_admin = true`);
        } else if (role === 'user') {
            conditions.push(`u.is_admin = false`);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ` ORDER BY u.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Admin users error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const check = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.params.id]);
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (check.rows[0].is_admin) {
            return res.status(403).json({ error: 'Cannot delete admin users' });
        }

        await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Delete failed' });
    }
});

app.get('/api/admin/payments', requireAuth, requireAdmin, async (req, res) => {
    const { search, status, method, date, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    try {
        let query = `SELECT s.*, u.username 
                     FROM subscriptions s 
                     LEFT JOIN users u ON s.user_id = u.id 
                     WHERE 1=1`;
        const params = [];
        let idx = 1;

        if (search) {
            query += ` AND (u.username ILIKE $${idx} OR s.payment_reference ILIKE $${idx})`;
            params.push(`%${search}%`);
            idx++;
        }

        if (status && ['pending', 'completed', 'failed'].includes(status)) {
            query += ` AND s.status = $${idx}`;
            params.push(status);
            idx++;
        }

        if (method) {
            query += ` AND s.payment_method = $${idx}`;
            params.push(method);
            idx++;
        }

        if (date) {
            query += ` AND DATE(s.created_at) = $${idx}`;
            params.push(date);
            idx++;
        }

        query += ` ORDER BY s.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);

        // Get total revenue with filters
        let revQuery = `SELECT COALESCE(SUM(amount), 0) FROM subscriptions WHERE status = 'completed'`;
        // Apply same filters to revenue
        // ... (simplified for brevity)

        res.json(result.rows);
    } catch (err) {
        console.error('Admin payments error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/logs', requireAuth, requireAdmin, async (req, res) => {
    const { search, action, date, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    try {
        let query = `SELECT * FROM activity_logs WHERE 1=1`;
        const params = [];
        let idx = 1;

        if (search) {
            query += ` AND (username ILIKE $${idx} OR action ILIKE $${idx} OR details ILIKE $${idx})`;
            params.push(`%${search}%`);
            idx++;
        }

        if (action) {
            query += ` AND action = $${idx}`;
            params.push(action);
            idx++;
        }

        if (date) {
            query += ` AND DATE(created_at) = $${idx}`;
            params.push(date);
            idx++;
        }

        query += ` ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Admin logs error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============== ONLINE USERS ==============
let onlineUsers = new Map();

app.get('/api/online-users', requireAuth, (req, res) => {
    const users = [];
    for (const [username, data] of onlineUsers) {
        users.push({ username, status: 'online' });
    }
    res.json(users);
});

// ============== SOCKET.IO ==============
io.use((socket, next) => {
    const session = socket.request.session;
    if (session && session.userId) {
        socket.userId = session.userId;
        socket.username = session.username;
        socket.join(`user:${socket.userId}`);
        next();
    } else {
        next(new Error('Unauthorized'));
    }
});

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.username}`);

    onlineUsers.set(socket.username, { userId: socket.userId, socketId: socket.id });
    io.emit('online users', Array.from(onlineUsers.keys()).map(u => ({ username: u, status: 'online' })));

    // Send recent messages
    pool.query(`
    SELECT m.*, u.profile_pic 
    FROM messages m 
    LEFT JOIN users u ON m.user_id = u.id 
    ORDER BY m.timestamp DESC LIMIT 50
    `)
        .then(result => {
            socket.emit('previous messages', result.rows.reverse());
        })
        .catch(err => console.error('Error sending previous messages:', err));

    socket.on('send message', async (data) => {
        const { message } = data;
        if (!message) return;

        try {
            const result = await pool.query(
                `INSERT INTO messages (user_id, username, message) 
             VALUES ($1, $2, $3) 
             RETURNING *, 
                (SELECT profile_pic FROM users WHERE id = $1) AS profile_pic`,
                [socket.userId, socket.username, message]
            );
            io.emit('receive message', result.rows[0]);
        } catch (err) {
            console.error('Error saving message:', err);
            socket.emit('error', 'Failed to save message');
        }
    });

    socket.on('typing', () => {
        socket.broadcast.emit('user typing', socket.username);
    });

    socket.on('stop typing', () => {
        socket.broadcast.emit('stop typing');
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.username}`);
        onlineUsers.delete(socket.username);
        io.emit('online users', Array.from(onlineUsers.keys()).map(u => ({ username: u, status: 'online' })));
    });
});

// ============== FRONTEND ROUTES ==============
app.get('/mydashboard.html', requireAuth, async (req, res) => {
    try {
        const subCheck = await pool.query(
            'SELECT id FROM subscriptions WHERE user_id = $1 AND status = $2 AND expires_at > NOW()',
            [req.session.userId, 'completed']
        );
        
        if (subCheck.rows.length === 0) {
            return res.redirect('/subscribe.html');
        }
        
        res.sendFile(path.join(__dirname, 'public', 'mydashboard.html'));
    } catch (err) {
        res.redirect('/login.html');
    }
});

app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
        return res.status(404).json({ error: 'Not found' });
    }

    // Check if requested file exists in public directory
    const filePath = path.join(__dirname, 'public', req.path);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return res.sendFile(filePath);
    }

    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ============== START SERVER ==============
const PORT = process.env.PORT || 3000;

initDatabase().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`🔗 URL: http://localhost:${PORT}`);
        console.log(`💳 PalmPesa: ${PALMPESA_API_TOKEN ? 'configured' : 'NOT CONFIGURED'}`);
        if (process.env.PALMPESA_CALLBACK_URL) {
            console.log(`🔔 PalmPesa webhook: ${process.env.PALMPESA_CALLBACK_URL}`);
        }
    });
}).catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        pool.end(() => {
            console.log('Database pool closed');
            process.exit(0);
        });
    });
});