const pool = require("./db");

async function logAuditEvent(table, columns, values) {
  try {
    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
    await pool.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
      values,
    );
  } catch (err) {
    console.error(`AUDIT_WRITE_ERROR (${table}):`, err.message);
  }
}

module.exports = { logAuditEvent };
