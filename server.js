import express from 'express';
import http from 'http';
import socketIo from 'socket.io';
import { Pool } from 'pg';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
const initDatabase = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) NOT NULL,
                message TEXT NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE INDEX IF NOT EXISTS idx_messages_timestamp 
            ON messages(timestamp DESC);
        `);
        console.log('Database initialized successfully');
    } catch (err) {
        console.error('Database initialization error:', err);
    }
};

initDatabase();

// API Routes
app.get('/api/messages', async (req, res) => {
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

app.post('/api/messages', async (req, res) => {
    const { username, message } = req.body;
    if (!username || !message) {
        return res.status(400).json({ error: 'Username and message required' });
    }

    try {
        const result = await pool.query(
            'INSERT INTO messages (username, message) VALUES ($1, $2) RETURNING *',
            [username, message]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error saving message:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Socket.IO handling
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Send existing messages to new user
    pool.query('SELECT * FROM messages ORDER BY timestamp DESC LIMIT 50')
        .then(result => {
            socket.emit('previous messages', result.rows.reverse());
        })
        .catch(err => console.error('Error sending previous messages:', err));

    // Handle new message
    socket.on('send message', async (data) => {
        const { username, message } = data;
        if (!username || !message) return;

        try {
            const result = await pool.query(
                'INSERT INTO messages (username, message) VALUES ($1, $2) RETURNING *',
                [username, message]
            );
            const newMessage = result.rows[0];
            
            // Broadcast to all clients
            io.emit('receive message', newMessage);
        } catch (err) {
            console.error('Error saving message:', err);
            socket.emit('error', 'Failed to save message');
        }
    });

    // Handle user typing
    socket.on('typing', (username) => {
        socket.broadcast.emit('user typing', username);
    });

    socket.on('stop typing', () => {
        socket.broadcast.emit('stop typing');
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});