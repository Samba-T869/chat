import { Client } from 'pg';

// Railway automatically provides DATABASE_URL in your environment variables
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Railway PostgreSQL SSL connections
  }
});

async function testConnection() {
  try {
    console.log('Connecting to Railway PostgreSQL...');
    await client.connect();
    
    // Execute a simple query to verify connection and fetch server time
    const res = await client.query('SELECT NOW() as current_time, version()');
    
    console.log(' Successfully connected!');
    console.log('Database Time:', res.rows[0].current_time);
    console.log('Postgres Version:', res.rows[0].version);
  } catch (err) {
    console.error(' Connection error:', err.stack);
  } finally {
    await client.end();
    console.log('Connection closed.');
  }
}

testConnection();