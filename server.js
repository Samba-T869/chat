import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { Pool } from 'pg';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import session from 'express-session';
import pgSession from 'connect-pg-simple';

dotenv.config();

const app = express();
const server = http.createServer(app);

// Trust proxy for Railway
app.set('trust proxy', 1);

const io = new Server(server, {
    cors: {
        origin: process.env.CLIENT_URL || "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    // Add these for Railway deployment
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
});

const onlineUsers = new Map();

function getOnlineUsersList() {
    const users = [];
    for (const [username, data] of onlineUsers) {
        users.push({
            username: username,
            status: data.status || 'online'
        });
    }
    return users;
}

// Middleware
app.use(cors({
    origin: process.env.CLIENT_URL || "*",
    credentials: true
}));
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// PostgreSQL connection with Railway config
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || '',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '45Ngalula',
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Session store
const PgSession = pgSession(session);
const sessionStore = new PgSession({
    pool: pool,
    tableName: 'session',
    createTableIfMissing: true
});

// Session middleware with Railway-compatible config
const sessionMiddleware = session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24,
        sameSite: process.env.NODE_ENV === 'production' ? 'lax' : 'lax'
    }
});

app.use(sessionMiddleware);

// Make Express session available to Socket.IO
io.engine.use(sessionMiddleware);

// Initialize database tables
const initDatabase = async () => {
    try {
        // Users table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Messages table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                username VARCHAR(50) NOT NULL,
                message TEXT NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create indexes
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_timestamp 
            ON messages(timestamp DESC);
            
            CREATE INDEX IF NOT EXISTS idx_messages_user_id 
            ON messages(user_id);
        `);

        console.log('Database initialized successfully');
    } catch (err) {
        console.error('Database initialization error:', err);
    }
};

initDatabase();

// Authentication middleware
const requireAuth = (req, res, next) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// Auth Routes
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    try {
        const userCheck = await pool.query(
            'SELECT id FROM users WHERE username = $1 OR email = $2',
            [username, email]
        );

        if (userCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        const result = await pool.query(
            'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
            [username, email, passwordHash]
        );

        req.session.userId = result.rows[0].id;
        req.session.username = result.rows[0].username;

        res.status(201).json({
            message: 'User registered successfully',
            user: result.rows[0]
        });
        console.log(`User registered ${username} successfully`);

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
            'SELECT id, username, email, password_hash FROM users WHERE username = $1',
            [username]
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

        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Login failed to initialize session' });
            }
            
            res.json({
                message: 'Login successful',
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email
                }
            });
        });

        console.log(`User ${username} logged in successfully`);
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
        res.json({ message: 'Logout successful' });
    });
});

app.get('/api/check-auth', (req, res) => {
    if (req.session && req.session.userId) {
        res.json({ 
            authenticated: true, 
            userId: req.session.userId,
            username: req.session.username 
        });
    } else {
        res.json({ authenticated: false });
    }
});

app.get('/api/messages', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM messages ORDER BY timestamp DESC LIMIT 50'
        );
        res.json(result.rows.reverse());
    } catch (err) {
        console.error('Error fetching messages:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/messages', requireAuth, async (req, res) => {
    const { message } = req.body;
    const userId = req.session.userId;
    const username = req.session.username;

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    try {
        const result = await pool.query(
            'INSERT INTO messages (user_id, username, message) VALUES ($1, $2, $3) RETURNING *',
            [userId, username, message]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error saving message:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get all registered users
app.get('/api/users', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, email, created_at FROM users ORDER BY username'
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Add this route after your other API routes
app.get('/api/online-users', requireAuth, (req, res) => {
    const users = getOnlineUsersList();
    res.json(users);
});

// Socket.IO with session support
io.use((socket, next) => {
    const session = socket.request.session;
    if (session && session.userId) {
        socket.userId = session.userId;
        socket.username = session.username;
        next();
    } else {
        next(new Error('Unauthorized'));
    }
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.username);

     // Add user to online list
    onlineUsers.set(socket.username, {
        userId: socket.userId,
        status: 'online',
        socketId: socket.id
    });

    // Broadcast updated user list to all clients
    io.emit('online users', getOnlineUsersList());

    pool.query('SELECT * FROM messages ORDER BY timestamp DESC LIMIT 50')
        .then(result => {
            socket.emit('previous messages', result.rows.reverse());
        })
        .catch(err => console.error('Error sending previous messages:', err));

    socket.on('send message', async (data) => {
        const { message } = data;
        if (!message) return;

        try {
            const result = await pool.query(
                'INSERT INTO messages (user_id, username, message) VALUES ($1, $2, $3) RETURNING *',
                [socket.userId, socket.username, message]
            );
            const newMessage = result.rows[0];
            io.emit('receive message', newMessage);
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
        console.log('User disconnected:', socket.username);

        // Remove user from online list
        onlineUsers.delete(socket.username);
        
        // Broadcast updated user list
        io.emit('online users', getOnlineUsersList());
    });
});

// Health check endpoint for Railway
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});