import { Pool } from 'pg';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

// DATABASE CONNECTION
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

// DATABASE INITIALIZATION
const initDb = async () => {
    const client = await pool.connect();

    try {
        console.log('🔄 Starting database initialization...');

        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                fullname VARCHAR(100) NOT NULL,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                phone VARCHAR (20) NOT NULL,
                country VARCHAR (100) NOT NULL,
                profile_pic VARCHAR(255),
                is_verified BOOLEAN DEFAULT FALSE,
                verification_code VARCHAR(6),
                code_expires_at TIMESTAMP,
                is_admin BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('✅ Users table ready');

        await client.query(`
            CREATE TABLE IF NOT EXISTS pending_users (
                id SERIAL PRIMARY KEY,
                fullname VARCHAR(100) NOT NULL,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                country VARCHAR(100) NOT NULL,
                profile_pic VARCHAR(255),
                verification_code VARCHAR(6) NOT NULL,
                code_expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
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
                starts_at TIMESTAMP DEFAULT NULL,
                expires_at TIMESTAMP DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('✅ Subscriptions table ready');

        await client.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                title VARCHAR(200) NOT NULL,
                category VARCHAR(50) NOT NULL,
                price DECIMAL(10,2) NOT NULL,
                location VARCHAR(150) NOT NULL,
                whatsapp VARCHAR(20) NOT NULL,
                call_number VARCHAR(20) NOT NULL,
                description TEXT NOT NULL,
                media_path TEXT[], -- Array to support multiple image paths/URLs
                status VARCHAR(20) DEFAULT 'active' 
                    CHECK (status IN ('active', 'inactive', 'sold')),
                views INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('✅ Products table ready');

        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
                message TEXT,
                message_type VARCHAR(20) DEFAULT 'text', -- 'text', 'offer', 'image', 'system'
                offer_amount NUMERIC(12, 2),             -- Stores custom price offers made in chat.html
                file_paths TEXT[],                       -- Stores multiple file/image attachments
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            ALTER TABLE messages
            ADD COLUMN IF NOT EXISTS user_id INTEGER;
        `);

        await client.query(`
            ALTER TABLE messages
            ADD COLUMN IF NOT EXISTS file_path VARCHAR(255);
        `);

        const messageForeignKey = await client.query(`
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'messages_user_id_fkey'
              AND conrelid = 'messages'::regclass
            LIMIT 1;
        `);

        if (messageForeignKey.rows.length === 0) {
            await client.query(`
                ALTER TABLE messages
                ADD CONSTRAINT messages_user_id_fkey
                FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE;
            `);
        }

        console.log('✅ Messages table ready');

        await client.query(`
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

        console.log('✅ Activity logs table ready');


        /*
         * ========================================================
         * INDEXES
         * ========================================================
         */

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_created_at
            ON messages(created_at DESC);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_user_id
            ON messages(user_id);
        `);

        await client.query(`
            -- Indexing for performance when querying conversation threads
            CREATE INDEX IF NOT EXISTS idx_messages_conversation 
            ON messages (sender_id, receiver_id, product_id);
        `);
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_products_user_id
            ON products(user_id);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_products_category
            ON products(category);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_products_status
            ON products(status);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id
            ON subscriptions(user_id);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_subscriptions_expires_at
            ON subscriptions(expires_at);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id
            ON activity_logs(user_id);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at
            ON activity_logs(created_at DESC);
        `);

        console.log('✅ Database indexes ready');


        const adminCheck = await client.query(
            `SELECT id FROM users WHERE username = $1 OR email = $2 LIMIT 1`,
            ['admin', 'admin@waudhao.com']
        );

        if (adminCheck.rows.length === 0) {

            const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';

            const passwordHash = await bcrypt.hash(adminPassword, 10);

            await client.query(
                `
                INSERT INTO users
                    (fullname, username, email, password_hash, phone, country, is_admin)
                VALUES
                    ($1, $2, $3, $4, $5, $6, $7)
                `,
                [
                    'Boniphace Samba',
                    'admin',
                    'admin@waudhao.com',
                    passwordHash,
                    '0618882762',
                    'tanzania',
                    true
                ]
            );

            console.log('✅ Admin user created');
        } else {
            console.log('ℹ️ Admin user already exists');
        }

        console.log('');
        console.log('✅ DATABASE INITIALIZATION COMPLETED SUCCESSFULLY');
        console.log('🚀 Database is compatible with server.js');


    } catch (error) {

        console.error('');
        console.error('❌ DATABASE INITIALIZATION FAILED');
        console.error('-----------------------------------');
        console.error(error);
        console.error('');

        throw error;

    } finally {

        client.release();
    }
};

export default initDb;