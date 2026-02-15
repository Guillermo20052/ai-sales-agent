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

    if (!userId) {
      console.log("⚠️ No userId in checkout session metadata");
      return res.json({ received: true });
    }

    await pool.query("UPDATE users SET is_paid = true, subscription_status = 'active' WHERE id = $1", [userId]);

    console.log("✅ Subscription activated for user:", userId);
  }

  /* =================================
     MONTHLY RENEWALS
  ================================== */
  if (
    event.type === "invoice.payment_succeeded" ||
    event.type === "invoice_payment.paid"
  ) {
    const invoice = event.data.object;
    const customerId = invoice.customer;

    if (!customerId) {
      console.log("⚠️ No customer ID found on invoice");
      return res.json({ received: true });
    }

    try {
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: "active",
        limit: 1,
      });

      if (!subscriptions.data.length) {
        console.log("⚠️ No active subscription found for customer");
        return res.json({ received: true });
      }

      const subscription = subscriptions.data[0];
      const userId = subscription.metadata?.userId;

      if (!userId) {
        console.log("⚠️ No userId found in subscription metadata");
        return res.json({ received: true });
      }

      await pool.query("UPDATE users SET is_paid = true, subscription_status = 'active' WHERE id = $1", [
        userId,
      ]);

      console.log("🔁 Monthly renewal successful for user:", userId);
    } catch (err) {
      console.error("⚠️ Error processing renewal:", err.message);
    }
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

      await pool.query("UPDATE users SET is_paid = false, subscription_status = 'inactive' WHERE id = $1", [
        userId,
      ]);

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

    // If not active anymore, downgrade
    if (subscription.status !== "active") {
      const userId = subscription.metadata?.userId;

      if (!userId) {
        console.log("⚠️ No userId found on canceled subscription");
        return res.json({ received: true });
      }

      await pool.query("UPDATE users SET is_paid = false, subscription_status = 'inactive' WHERE id = $1", [
        userId,
      ]);

      console.log("❌ Subscription canceled — user downgraded:", userId);
    }
  }

  res.json({ received: true });
});

module.exports = router;
