const express = require("express");
const Stripe = require("stripe");
const pool = require("../services/db");

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const ALLOWED_WEBHOOK_EVENTS = new Set([
  "checkout.session.completed",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

async function userExists(userId) {
  const id = typeof userId === "string" ? parseInt(userId, 10) : userId;
  if (!Number.isInteger(id) || id < 1) return false;
  const r = await pool.query("SELECT id FROM users WHERE id = $1", [id]);
  return r.rows.length > 0;
}

/*
  express.raw() is already applied in server.js
*/

router.post("/", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error("⚠️ Signature verification failed:", err.message);
    return res.status(400).send("Webhook Error");
  }

  if (!ALLOWED_WEBHOOK_EVENTS.has(event.type)) {
    return res.json({ received: true });
  }

  try {
    const insertResult = await pool.query(
      "INSERT INTO stripe_webhook_events (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
      [event.id],
    );
    if (insertResult.rows.length === 0) {
      return res.json({ received: true });
    }
  } catch (err) {
    console.error("Webhook idempotency check failed:", err.message);
    return res.status(500).json({ error: "Webhook processing failed." });
  }

  console.log("🔥 Webhook triggered:", event.type);

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      if (session.payment_status !== "paid") {
        return res.json({ received: true });
      }
      const userId = session.metadata?.userId;
      if (!userId || !(await userExists(userId))) {
        return res.json({ received: true });
      }
      await pool.query(
        `UPDATE users
         SET is_paid = true,
             subscription_status = 'active',
             stripe_customer_id = $1,
             stripe_subscription_id = $2
         WHERE id = $3`,
        [session.customer, session.subscription, userId],
      );
      console.log("✅ Checkout completed for user:", userId);
    }

    if (event.type === "customer.subscription.created") {
      const subscription = event.data.object;
      const userId = subscription.metadata?.userId;
      if (!userId || !(await userExists(userId))) {
        return res.json({ received: true });
      }
      const price = subscription.items?.data?.[0]?.price;
      if (!price) return res.json({ received: true });
      await pool.query(
        `UPDATE users
         SET stripe_subscription_id = $1,
             price_id = $2,
             billing_cycle = $3,
             subscription_amount = $4,
             current_period_end = TO_TIMESTAMP($5),
             is_paid = true,
             subscription_status = 'active'
         WHERE id = $6`,
        [
          subscription.id,
          price.id,
          price.recurring?.interval || null,
          price.unit_amount || null,
          subscription.current_period_end,
          userId,
        ],
      );
      console.log("✅ Subscription stored:", userId);
    }

    if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object;
      const userId = subscription.metadata?.userId;
      if (!userId || !(await userExists(userId))) {
        return res.json({ received: true });
      }
      const price = subscription.items?.data?.[0]?.price;
      const status = subscription.status;
      const periodEnd = subscription.current_period_end;
      const dbStatus = status === "active" ? "active" : "inactive";
      await pool.query(
        `UPDATE users
         SET subscription_status = $1,
             price_id = $2,
             billing_cycle = $3,
             subscription_amount = $4,
             current_period_end = TO_TIMESTAMP($5)
         WHERE id = $6`,
        [
          dbStatus,
          price?.id || null,
          price?.recurring?.interval || null,
          price?.unit_amount || null,
          periodEnd || null,
          userId,
        ],
      );
      console.log("✅ Subscription updated for user:", userId);
    }

    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      if (!customerId) return res.json({ received: true });

      const userResult = await pool.query(
        "SELECT id FROM users WHERE stripe_customer_id = $1",
        [customerId],
      );
      if (!userResult.rows.length) {
        console.log("⚠️ No user found for customer:", customerId);
        return res.json({ received: true });
      }
      const userId = userResult.rows[0].id;
      const periodEnd = invoice.lines?.data?.[0]?.period?.end || null;

      await pool.query(
        `UPDATE users
         SET lifetime_revenue = COALESCE(lifetime_revenue, 0) + $1,
             is_paid = true,
             subscription_status = 'active',
             current_period_end = TO_TIMESTAMP($2)
         WHERE id = $3`,
        [
          invoice.amount_paid,
          Number(periodEnd) || Math.floor(Date.now() / 1000),
          userId,
        ],
      );
      console.log("💰 Renewal processed for user:", userId);
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      if (!customerId) return res.json({ received: true });

      const userResult = await pool.query(
        "SELECT id FROM users WHERE stripe_customer_id = $1",
        [customerId],
      );
      if (!userResult.rows.length) return res.json({ received: true });
      const userId = userResult.rows[0].id;

      await pool.query(
        `UPDATE users
         SET is_paid = false,
             subscription_status = 'inactive'
         WHERE id = $1
         AND subscription_status != 'refunded'`,
        [userId],
      );
      console.log("❌ Payment failed:", userId);
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const userId = subscription.metadata?.userId;
      if (!userId || !(await userExists(userId))) {
        return res.json({ received: true });
      }
      await pool.query(
        `UPDATE users
         SET is_paid = false,
             subscription_status = 'inactive',
             stripe_subscription_id = NULL,
             billing_cycle = NULL,
             subscription_amount = NULL
         WHERE id = $1`,
        [userId],
      );
      console.log("❌ Subscription canceled:", userId);
    }

    res.json({ received: true });
  } catch (err) {
    console.error("🔥 FULL WEBHOOK ERROR:", err);
    res.status(500).json({ error: "Webhook processing failed." });
  }
});

module.exports = router;
