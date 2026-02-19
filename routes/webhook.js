const express = require("express");
const Stripe = require("stripe");
const pool = require("../services/db");

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/*
  IMPORTANT:
  express.raw() is already applied in server.js
  server.js mounts this route at "/webhook"
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
    console.error("⚠️ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("🔥 Webhook triggered:", event.type);

  /* =================================
     FIRST PAYMENT (Subscription Start)
  ================================== */
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata?.userId;

    if (!userId) return res.json({ received: true });

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

  /* =================================
     SUBSCRIPTION CREATED
  ================================== */
  if (event.type === "customer.subscription.created") {
    const subscription = event.data.object;
    const userId = subscription.metadata?.userId;

    if (!userId) return res.json({ received: true });

    const price = subscription.items.data[0].price;

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
        price.recurring.interval,
        price.unit_amount,
        subscription.current_period_end,
        userId,
      ],
    );

    console.log("✅ Subscription stored for user:", userId);
  }

  /* =================================
     MONTHLY RENEWALS
  ================================== */
  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object;
    const customerId = invoice.customer;

    if (!customerId) return res.json({ received: true });

    const userResult = await pool.query(
      "SELECT id FROM users WHERE stripe_customer_id = $1",
      [customerId],
    );

    if (!userResult.rows.length) return res.json({ received: true });

    const userId = userResult.rows[0].id;

    // Get subscription to refresh period end
    const subscription = await stripe.subscriptions.retrieve(
      invoice.subscription,
    );

    await pool.query(
      `UPDATE users
       SET lifetime_revenue = lifetime_revenue + $1,
           is_paid = true,
           subscription_status = 'active',
           current_period_end = TO_TIMESTAMP($2)
       WHERE id = $3`,
      [invoice.amount_paid, subscription.current_period_end, userId],
    );

    console.log("💰 Renewal processed for user:", userId);
  }
  /* =================================
     FAILED PAYMENT (Auto Downgrade)
  ================================== */
  if (
    event.type === "invoice.payment_failed" ||
    event.type === "invoice_payment.failed"
  ) {
    const invoice = event.data.object;
    const customerId = invoice.customer;

    if (!customerId) return res.json({ received: true });

    try {
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        limit: 1,
      });

      if (!subscriptions.data.length) return res.json({ received: true });

      const subscription = subscriptions.data[0];
      const userId = subscription.metadata?.userId;

      if (!userId) return res.json({ received: true });

      await pool.query(
        "UPDATE users SET is_paid = false, subscription_status = 'inactive' WHERE id = $1 AND subscription_status != 'refunded'",
        [userId],
      );

      console.log("❌ Payment failed — user downgraded:", userId);
    } catch (err) {
      console.error("⚠️ Error handling failed payment:", err.message);
    }
  }

  /* =================================
     SUBSCRIPTION CANCELED
  ================================== */
  if (
    event.type === "customer.subscription.deleted" ||
    event.type === "customer.subscription.updated"
  ) {
    const subscription = event.data.object;

    if (subscription.status !== "active") {
      const userId = subscription.metadata?.userId;

      if (!userId) return res.json({ received: true });

      await pool.query(
        `UPDATE users
         SET is_paid = false,
             subscription_status = 'inactive',
             stripe_subscription_id = NULL,
             billing_cycle = NULL,
             subscription_amount = NULL
         WHERE id = $1
         AND subscription_status != 'refunded'`,
        [userId],
      );

      console.log("❌ Subscription canceled — cleaned user:", userId);
    }
  }

  res.json({ received: true });
});

module.exports = router;
