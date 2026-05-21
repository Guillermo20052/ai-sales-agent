const { Pool } = require("pg");

if (process.env.NODE_ENV === "development" && !process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not defined");
}

const isProd = process.env.NODE_ENV === "production";
// Safe pool limits: prevent database overload and connection exhaustion
const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: Math.min(Number(process.env.POOL_MAX) || 20, 100),
  idleTimeoutMillis: Number(process.env.POOL_IDLE_TIMEOUT_MS) || 30000,
  connectionTimeoutMillis: Number(process.env.POOL_CONNECTION_TIMEOUT_MS) || 5000,
};

if (isProd && process.env.DATABASE_URL) {
  poolConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(poolConfig);

pool.on("error", (err) => {
  console.error("DATABASE_POOL_ERROR:", err.message);
});

module.exports = pool;
