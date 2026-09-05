import { Pool } from 'pg';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

/*
 * ============================================================
 * DATABASE CONNECTION
 * ============================================================
 */

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,

    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,

    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});


/*
 * ============================================================
 * DATABASE INITIALIZATION
 * ============================================================
 */

const initDb = async () => {
    const client = await pool.connect();

    try {
        console.log('🔄 Starting database initialization...');

        /*
         * --------------------------------------------------------
         * USERS
         * --------------------------------------------------------
         */
        await client.query(`
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

        console.log('✅ Users table ready');


        /*
         * --------------------------------------------------------
         * SUBSCRIPTIONS
         * --------------------------------------------------------
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                plan VARCHAR(20) NOT NULL
                    CHECK (plan IN ('daily', 'monthly', 'yearly')),
                amount DECIMAL(10,2) NOT NULL,
                payment_method VARCHAR(50) DEFAULT 'palmpesa',
                payment_reference VARCHAR(100),
                status VARCHAR(20) DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'failed')),
                starts_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('✅ Subscriptions table ready');


        /*
         * --------------------------------------------------------
         * PRODUCTS
         * --------------------------------------------------------
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                title VARCHAR(200) NOT NULL,
                description TEXT,
                price DECIMAL(10,2) NOT NULL,
                category VARCHAR(50),
                media_path VARCHAR(255),
                status VARCHAR(20) DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive', 'sold')),
                views INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('✅ Products table ready');


        /*
         * --------------------------------------------------------
         * MESSAGES
         *
         * This is the important fix.
         *
         * server.js uses:
         *   user_id
         *   username
         *   message
         *   file_path
         *   timestamp
         * --------------------------------------------------------
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                username VARCHAR(50) NOT NULL,
                message TEXT NOT NULL,
                file_path VARCHAR(255),
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        /*
         * IMPORTANT:
         * If the old messages table already existed, CREATE TABLE
         * IF NOT EXISTS does NOT modify it.
         *
         * These ALTER statements make the script compatible with
         * an existing old messages table.
         */

        await client.query(`
            ALTER TABLE messages
            ADD COLUMN IF NOT EXISTS user_id INTEGER;
        `);

        await client.query(`
            ALTER TABLE messages
            ADD COLUMN IF NOT EXISTS file_path VARCHAR(255);
        `);

        /*
         * Add the foreign-key relationship only if it doesn't
         * already exist.
         */

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


        /*
         * --------------------------------------------------------
         * BLOG POSTS
         * --------------------------------------------------------
         */

        await client.query(`
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

        console.log('✅ Blog posts table ready');


        /*
         * --------------------------------------------------------
         * BLOG COMMENTS
         * --------------------------------------------------------
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS blog_comments (
                id SERIAL PRIMARY KEY,
                post_id INTEGER REFERENCES blog_posts(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                username VARCHAR(50) NOT NULL,
                comment TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('✅ Blog comments table ready');


        /*
         * --------------------------------------------------------
         * PRODUCT COMMENTS
         * --------------------------------------------------------
         */

        await client.query(`
            CREATE TABLE IF NOT EXISTS product_comments (
                id SERIAL PRIMARY KEY,
                product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                username VARCHAR(50) NOT NULL,
                comment TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('✅ Product comments table ready');


        /*
         * --------------------------------------------------------
         * ACTIVITY LOGS
         * --------------------------------------------------------
         */

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
            CREATE INDEX IF NOT EXISTS idx_messages_timestamp
            ON messages(timestamp DESC);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_user_id
            ON messages(user_id);
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
            CREATE INDEX IF NOT EXISTS idx_blog_posts_created_at
            ON blog_posts(created_at DESC);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_blog_comments_post_id
            ON blog_comments(post_id);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_product_comments_product_id
            ON product_comments(product_id);
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


        /*
         * ========================================================
         * ADMIN USER
         * ========================================================
         *
         * Only create the admin if one doesn't already exist.
         *
         * IMPORTANT:
         * Change the default password before using this in
         * production.
         */

        const adminCheck = await client.query(
            `SELECT id FROM users WHERE username = $1 OR email = $2 LIMIT 1`,
            ['admin', 'admin@neveralone.com']
        );

        if (adminCheck.rows.length === 0) {

            const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';

            const passwordHash = await bcrypt.hash(adminPassword, 10);

            await client.query(
                `
                INSERT INTO users
                    (username, email, password_hash, is_admin)
                VALUES
                    ($1, $2, $3, $4)
                `,
                [
                    'admin',
                    'admin@neveralone.com',
                    passwordHash,
                    true
                ]
            );

            console.log('✅ Admin user created');
        } else {
            console.log('ℹ️ Admin user already exists');
        }


        /*
         * ========================================================
         * VERIFY IMPORTANT TABLES
         * ========================================================
         */

        const tables = await client.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name IN (
                'users',
                'subscriptions',
                'products',
                'messages',
                'blog_posts',
                'blog_comments',
                'product_comments',
                'activity_logs'
            )
            ORDER BY table_name;
        `);

        console.log('');
        console.log('📊 Database tables:');

        tables.rows.forEach(row => {
            console.log(`   ✓ ${row.table_name}`);
        });

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


/*
 * ============================================================
 * RUN INITIALIZATION
 * ============================================================
 */

initDb()
    .then(async () => {
        await pool.end();
        console.log('🔌 Database connection closed');
        process.exit(0);
    })
    .catch(async () => {
        await pool.end();
        console.error('❌ init-db.js finished with errors');
        process.exit(1);
    });