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
import initDb from './scripts/init-db.js';
import nodemailer from 'nodemailer';

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
        s3,
        bucket: process.env.R2_BUCKET_NAME,
        metadata: (req, file, cb) => cb(null, { fieldName: file.fieldname }),
        key: (req, file, cb) => {
            let folder = 'misc/';
            if (file.fieldname === 'profile_pic') folder = 'profiles/';
            else if (file.fieldname === 'product_image') folder = 'products/';
            else if (file.fieldname === 'image' || file.fieldname === 'file' || file.fieldname === 'chat_file') folder = 'blog/';
            const unique = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
            cb(null, folder + unique + path.extname(file.originalname).toLowerCase());
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024, files: 6 },
    fileFilter
});

// multer-s3 does not provide the old local `filename` property. Always use the
// object URL/key returned by multer-s3 so uploads work correctly on Railway/R2.
const uploadedUrl = (file) => file?.location ||
    (file?.key && process.env.R2_PUBLIC_URL ? `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${file.key}` : null) ||
    file?.key || null;

// ============== MIDDLEWARE ==============
app.use(cors({
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));


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

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false, // true for port 465, false for other ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS, 
    },
});

// Function to generate and save verification code
async function sendVerify(email, code) {
    // HTML Email Template
    const mailOptions = {
        from: process.env.SMTP_FROM || '"Waudhao" <no-reply@waudhao.com>',
        to: email,
        subject: 'Nambari Yako ya Uhakiki / Your Verification Code',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
                <h2 style="color: #333; text-align: center;">Uhakiki wa Akaunti</h2>
                <p>Habari,</p>
                <p>Nambari yako ya siri ya kuthibitisha akaunti yako ni:</p>
                <div style="background-color: #f4f4f4; padding: 15px; text-align: center; border-radius: 6px; font-size: 28px; font-weight: bold; letter-spacing: 5px; color: #007bff; margin: 20px 0;">
                    ${code}
                </div>
                <p style="color: #666; font-size: 14px;">Nambari hii itaisha muda wake baada ya <strong>dakika 5</strong>.</p>
                <p style="color: #999; font-size: 12px; margin-top: 30px; text-align: center;">Ikiwa hukuomba ombi hili, tafadhali puuza barua pepe hii.</p>
            </div>
        `
    };

    // Dispatch Email
    try {
        await transporter.sendMail(mailOptions);
        console.log(`[VERIFICATION EMAIL] Code ${code} successfully dispatched to ${email}`);
    } catch (error) {
        console.error(`[VERIFICATION EMAIL ERROR] Failed to send email to ${email}:`, error);
        throw new Error('Imeshindikana kutuma barua pepe ya usajili.');
    }

    return code;
}

// ============== AUTH ROUTES ==============
app.post('/api/register', upload.single('profile_pic'), async (req, res) => {
    const { fullname, username, email, phone, country, password, confirm } = req.body;
    
    if (!fullname || !username || !email || !phone || !country || !password || !confirm) {
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
        // 1. Check if user already exists in verified users
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

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        // 2. Clear previous pending entry if user re-registers before verifying
        await pool.query(
            'DELETE FROM pending_users WHERE username = $1 OR email = $2',
            [username.toLowerCase(), email.toLowerCase()]
        );

        // 3. Save to pending_users
        await pool.query(
            `INSERT INTO pending_users 
                (fullname, username, email, phone, country, password_hash, profile_pic, verification_code, code_expires_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                fullname, 
                username.toLowerCase(), 
                email.toLowerCase(), 
                phone, 
                country.toLowerCase(), 
                passwordHash, 
                profilePic, 
                code, 
                expiresAt
            ]
        );

        // 4. Send email
        await sendVerify(email.toLowerCase(), code);

        res.status(201).json({
            success: true,
            message: 'Registration initiated. Please verify your email.',
            email: email.toLowerCase()
        });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Verification Code Endpoint
app.post('/api/verify-code', async (req, res) => {
    const { email, code } = req.body;

    if (!email || !code) {
        return res.status(400).json({ error: 'Email and verification code are required' });
    }

    try {
        const result = await pool.query(
            `SELECT * FROM pending_users WHERE email = $1`,
            [email.toLowerCase()]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Pending registration not found or expired. Please register again.' });
        }

        const pendingUser = result.rows[0];

        if (pendingUser.verification_code !== code) {
            return res.status(400).json({ error: 'Invalid verification code' });
        }

        if (new Date() > new Date(pendingUser.code_expires_at)) {
            return res.status(400).json({ error: 'Verification code has expired. Please register again.' });
        }

        // Move user to permanent 'users' table
        const newUser = await pool.query(
            `INSERT INTO users (fullname, username, email, phone, country, password_hash, profile_pic, is_verified)
             VALUES ($1, $2, $3, $4, $5, $6, $7, true)
             RETURNING id, username, email`,
            [
                pendingUser.fullname,
                pendingUser.username,
                pendingUser.email,
                pendingUser.phone,
                pendingUser.country,
                pendingUser.password_hash,
                pendingUser.profile_pic
            ]
        );

        const user = newUser.rows[0];

        // Delete from pending_users
        await pool.query('DELETE FROM pending_users WHERE id = $1', [pendingUser.id]);

        // Log registration activity
        await logActivity(user.id, user.username, 'register', 'User registered and verified', getClientIP(req));

        // Initialize user session
        req.session.userId = user.id;
        req.session.username = user.username;

        res.json({ success: true, message: 'Account verified and created successfully' });
    } catch (err) {
        console.error('Verification error:', err);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// Resend Code Endpoint
app.post('/api/resend-code', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    try {
        const result = await pool.query(
            'SELECT id, email FROM pending_users WHERE email = $1',
            [email.toLowerCase()]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No pending registration found for this email.' });
        }

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        await pool.query(
            'UPDATE pending_users SET verification_code = $1, code_expires_at = $2 WHERE email = $3',
            [code, expiresAt, email.toLowerCase()]
        );

        await sendVerify(email.toLowerCase(), code);

        res.json({ success: true, message: 'New verification code sent' });
    } catch (err) {
        console.error('Resend error:', err);
        res.status(500).json({ error: 'Failed to resend code' });
    }
});

app.post('/api/login', async (req, res) => {
    const { identifier, password } = req.body;
    const loginValue = (identifier || '').trim().toLowerCase();

    if (!loginValue || !password) {
        return res.status(400).json({ error: 'Username or email and password required' });
    }

    try {
        const result = await pool.query(
            'SELECT id, username, email, password_hash, profile_pic, is_admin FROM users WHERE username = $1 OR email = $1',
            [loginValue]
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
    try {
        const fields = [];
        const params = [];
        let idx = 1;
        if (email) { fields.push(`email = $${idx++}`); params.push(email.trim().toLowerCase()); }
        if (req.file) { fields.push(`profile_pic = $${idx++}`); params.push(uploadedUrl(req.file)); }
        if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
        params.push(req.session.userId);
        const result = await pool.query(
            `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}
             RETURNING id, fullname, username, email, phone, country, profile_pic, is_admin, created_at`, params);
        if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error('Profile update error:', err);
        if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' });
        res.status(500).json({ error: 'Update failed' });
    }
});

app.put('/api/user/password', requireAuth, async (req, res) => {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new passwords are required' });
    if (String(new_password).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    try {
        const result = await pool.query('SELECT password_hash, username FROM users WHERE id = $1', [req.session.userId]);
        if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
        const ok = await bcrypt.compare(current_password, result.rows[0].password_hash);
        if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
        const hash = await bcrypt.hash(new_password, 12);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.session.userId]);
        await logActivity(req.session.userId, result.rows[0].username, 'password_changed', 'Password changed', getClientIP(req));
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) { console.error('Password change error:', err); res.status(500).json({ error: 'Password change failed' }); }
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
        if(req.session.isAdmin){
            return res.json({
                active: true,
                plan: 'Admin Unlimited',
                expires_at: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
                payment_status: 'completed'
            });
        }

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

// ============== DASHBOARD PRODUCT ROUTES ==============
const activeSubscription = async (userId) => {
    const r = await pool.query(`SELECT id, plan, starts_at, expires_at FROM subscriptions
        WHERE user_id=$1 AND status='completed' AND expires_at > NOW()
        ORDER BY expires_at DESC LIMIT 1`, [userId]);
    return r.rows[0] || null;
};

app.get('/api/my/products', requireAuth, async (req, res) => {
    try {
        const r = await pool.query(`SELECT p.*, COALESCE(p.media_path, ARRAY[]::text[]) AS media_path,
            u.username, u.profile_pic AS seller_profile_pic
            FROM products p LEFT JOIN users u ON u.id=p.user_id
            WHERE p.user_id=$1 ORDER BY p.created_at DESC`, [req.session.userId]);
        res.json({ products: r.rows });
    } catch (err) { console.error('My products error:', err); res.status(500).json({ error:'Database error' }); }
});

app.get('/api/my/dashboard', requireAuth, async (req, res) => {
    try {
        const [u,p,stats,sub] = await Promise.all([
            pool.query(`SELECT id, fullname, username, email, phone, country, profile_pic, is_admin, created_at FROM users WHERE id=$1`, [req.session.userId]),
            pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='active')::int AS active,
                        COALESCE(SUM(views),0)::int AS views FROM products WHERE user_id=$1`, [req.session.userId]),
            pool.query(`SELECT COUNT(*) FILTER (WHERE receiver_id=$1 AND is_read=false)::int AS unread,
                        COUNT(*)::int AS total FROM messages WHERE receiver_id=$1`, [req.session.userId]),
            req.session.isAdmin ? Promise.resolve({ rows: [{plan:'Admin Unlimited', expires_at:null}] }) : pool.query(`SELECT plan,starts_at,expires_at FROM subscriptions WHERE user_id=$1 AND status='completed' AND expires_at>NOW() ORDER BY expires_at DESC LIMIT 1`, [req.session.userId])
        ]);
        if (!u.rows.length) return res.status(404).json({error:'User not found'});
        res.json({ user:u.rows[0], stats:{...p.rows[0], ...stats.rows[0]}, subscription:sub.rows[0]||null });
    } catch(err){ console.error('Dashboard error:',err); res.status(500).json({error:'Failed to load dashboard'}); }
});

app.get('/api/products', async (req, res) => {
    const { search, category, page=1, limit=20 }=req.query; const lim=Math.min(Math.max(Number(limit)||20,1),100); const pg=Math.max(Number(page)||1,1); const offset=(pg-1)*lim;
    try {
        let where=`WHERE p.status='active'`, params=[], i=1;
        if(search){where+=` AND (p.title ILIKE $${i} OR p.description ILIKE $${i})`;params.push(`%${search}%`);i++;}
        if(category&&category!=='all'){where+=` AND p.category=$${i}`;params.push(category);i++;}
        const count=await pool.query(`SELECT COUNT(*) FROM products p ${where}`,params);
        const r=await pool.query(`SELECT p.*,u.username,u.profile_pic FROM products p LEFT JOIN users u ON u.id=p.user_id ${where} ORDER BY p.created_at DESC LIMIT $${i} OFFSET $${i+1}`,[...params,lim,offset]);
        const total=Number(count.rows[0].count); res.json({products:r.rows,total,page:pg,totalPages:Math.ceil(total/lim)});
    }catch(err){console.error('Products fetch error:',err);res.status(500).json({error:'Database error'});}
});

app.get('/api/products/:id', async (req,res)=>{try{const r=await pool.query(`SELECT p.*,u.username,u.profile_pic FROM products p LEFT JOIN users u ON u.id=p.user_id WHERE p.id=$1`,[req.params.id]);if(!r.rows.length)return res.status(404).json({error:'Product not found'});await pool.query('UPDATE products SET views=views+1 WHERE id=$1',[req.params.id]);res.json(r.rows[0]);}catch(err){res.status(500).json({error:'Server error'});}});

app.post('/api/products', requireAuth, upload.array('product_image',6), async (req,res)=>{
    const {title,description,price,category,location,whatsapp,call_number}=req.body;
    if(!title||!description||!price||!category||!location||!whatsapp||!call_number)return res.status(400).json({error:'All product fields are required'});
    if(!req.session.isAdmin && !(await activeSubscription(req.session.userId)))return res.status(403).json({error:'Active subscription required to post products'});
    try{
        const media=(req.files||[]).map(uploadedUrl).filter(Boolean);
        if(media.length>6)return res.status(400).json({error:'Maximum 6 images allowed'});
        const r=await pool.query(`INSERT INTO products(user_id,title,category,price,location,whatsapp,call_number,description,media_path)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[req.session.userId,title.trim(),category,Number(price),location.trim(),whatsapp.trim(),call_number.trim(),description.trim(),media]);
        await logActivity(req.session.userId,req.session.username,'product_created',`Product: ${title}`,getClientIP(req));
        res.status(201).json({success:true,product:r.rows[0]});
    }catch(err){console.error('Product creation error:',err);res.status(500).json({error:'Failed to create product'});}
});

app.put('/api/products/:id', requireAuth, upload.array('product_image',6), async(req,res)=>{
    const {title,description,price,category,location,whatsapp,call_number,existing_media}=req.body;
    try{
        const own=await pool.query('SELECT * FROM products WHERE id=$1 AND user_id=$2',[req.params.id,req.session.userId]);
        if(!own.rows.length)return res.status(404).json({error:'Product not found'});
        const existing=Array.isArray(JSON.parse(existing_media||'[]'))?JSON.parse(existing_media||'[]'):[];
        const uploaded=(req.files||[]).map(uploadedUrl).filter(Boolean); const media=[...existing,...uploaded].slice(0,6);
        if(!title||!description||!price||!category||!location||!whatsapp||!call_number)return res.status(400).json({error:'All product fields are required'});
        const r=await pool.query(`UPDATE products SET title=$1,category=$2,price=$3,location=$4,whatsapp=$5,call_number=$6,description=$7,media_path=$8,updated_at=CURRENT_TIMESTAMP WHERE id=$9 AND user_id=$10 RETURNING *`,[title.trim(),category,Number(price),location.trim(),whatsapp.trim(),call_number.trim(),description.trim(),media,req.params.id,req.session.userId]);
        await logActivity(req.session.userId,req.session.username,'product_updated',`Product ID: ${req.params.id}`,getClientIP(req));res.json({success:true,product:r.rows[0]});
    }catch(err){console.error('Product update error:',err);res.status(500).json({error:'Update failed'});}
});

app.delete('/api/products/:id', requireAuth, async(req,res)=>{try{const r=await pool.query('DELETE FROM products WHERE id=$1 AND user_id=$2 RETURNING id',[req.params.id,req.session.userId]);if(!r.rows.length)return res.status(404).json({error:'Product not found'});await logActivity(req.session.userId,req.session.username,'product_deleted',`Product ID: ${req.params.id}`,getClientIP(req));res.json({success:true});}catch(err){console.error('Delete product error:',err);res.status(500).json({error:'Delete failed'});}});

// ============== PRIVATE MESSAGES ==============
app.get('/api/messages/inbox', requireAuth, async(req,res)=>{
    try{
        const r=await pool.query(`WITH ranked AS (
          SELECT m.*, ROW_NUMBER() OVER(PARTITION BY LEAST(sender_id,receiver_id),GREATEST(sender_id,receiver_id),COALESCE(product_id,0) ORDER BY created_at DESC) rn
          FROM messages m WHERE m.sender_id=$1 OR m.receiver_id=$1
        ) SELECT r.id,r.sender_id,r.receiver_id,r.product_id,r.message,r.message_type,r.offer_amount,r.file_paths,r.is_read,r.created_at,
                 u.id AS partner_id,u.username AS partner_username,u.profile_pic AS partner_profile,
                 p.title AS product_title,p.media_path AS product_media
          FROM ranked r LEFT JOIN users u ON u.id=CASE WHEN r.sender_id=$1 THEN r.receiver_id ELSE r.sender_id END
          LEFT JOIN products p ON p.id=r.product_id WHERE r.rn=1 ORDER BY r.created_at DESC`,[req.session.userId]);
        res.json({conversations:r.rows});
    }catch(err){console.error('Inbox error:',err);res.status(500).json({error:'Failed to load inbox'});}
});

app.get('/api/messages/conversation/:userId', requireAuth, async(req,res)=>{
    const other=Number(req.params.userId); if(!other||other===req.session.userId)return res.status(400).json({error:'Invalid conversation'});
    try{
        const r=await pool.query(`SELECT m.*,su.username sender_username,ru.username receiver_username
          FROM messages m JOIN users su ON su.id=m.sender_id JOIN users ru ON ru.id=m.receiver_id
          WHERE (m.sender_id=$1 AND m.receiver_id=$2) OR (m.sender_id=$2 AND m.receiver_id=$1)
          ORDER BY m.created_at ASC LIMIT 200`,[req.session.userId,other]);
        await pool.query(`UPDATE messages SET is_read=true WHERE receiver_id=$1 AND sender_id=$2`,[req.session.userId,other]);
        res.json({messages:r.rows});
    }catch(err){console.error('Conversation error:',err);res.status(500).json({error:'Failed to load conversation'});}
});

app.post('/api/messages', requireAuth, upload.single('chat_file'), async(req,res)=>{
    const {message,receiver_id,product_id,offer_amount}=req.body; const receiver=Number(receiver_id), product=product_id?Number(product_id):null;
    if(!receiver||receiver===req.session.userId)return res.status(400).json({error:'A valid receiver is required'});
    if(!message && !req.file && !offer_amount)return res.status(400).json({error:'Message is required'});
    try{
        const user=await pool.query('SELECT id FROM users WHERE id=$1',[receiver]); if(!user.rows.length)return res.status(404).json({error:'Receiver not found'});
        const file=req.file?[uploadedUrl(req.file)]:null;
        const r=await pool.query(`INSERT INTO messages(sender_id,receiver_id,product_id,message,offer_amount,file_paths,is_read) VALUES($1,$2,$3,$4,$5,$6,false) RETURNING *`,[req.session.userId,receiver,product||null,message||'',offer_amount?Number(offer_amount):null,file]);
        const msg=r.rows[0]; io.to(`user:${receiver}`).emit('private message',msg); io.to(`user:${req.session.userId}`).emit('private message',msg); res.status(201).json({success:true,message:msg});
    }catch(err){console.error('Send message error:',err);res.status(500).json({error:'Failed to send message'});}
});

app.patch('/api/messages/:id/read',requireAuth,async(req,res)=>{try{const r=await pool.query('UPDATE messages SET is_read=true WHERE id=$1 AND receiver_id=$2 RETURNING id',[req.params.id,req.session.userId]);res.json({success:true,updated:!!r.rows.length});}catch(err){res.status(500).json({error:'Failed to mark message read'});}});

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
io.use((socket,next)=>{const session=socket.request.session;if(session?.userId){socket.userId=session.userId;socket.username=session.username;socket.join(`user:${socket.userId}`);next();}else next(new Error('Unauthorized'));});
io.on('connection',socket=>{
    console.log(`User connected: ${socket.username}`); onlineUsers.set(socket.username,{userId:socket.userId,socketId:socket.id});
    io.emit('online users',Array.from(onlineUsers.keys()).map(username=>({username,status:'online'})));
    socket.on('typing',data=>{if(data?.receiver_id)io.to(`user:${Number(data.receiver_id)}`).emit('typing',{userId:socket.userId,username:socket.username});});
    socket.on('stop typing',data=>{if(data?.receiver_id)io.to(`user:${Number(data.receiver_id)}`).emit('stop typing',{userId:socket.userId});});
    socket.on('disconnect',()=>{console.log(`User disconnected: ${socket.username}`);onlineUsers.delete(socket.username);io.emit('online users',Array.from(onlineUsers.keys()).map(username=>({username,status:'online'})));});
});

// ============== FRONTEND ROUTES ==============
app.get('/mydashboard.html', requireAuth, async (req, res) => {
    try {
        if(req.session.isAdmin){
            return res.sendFile(path.join(__dirname, 'public', 'mydashboard.html'));
        }

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

initDb().then(() => {
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