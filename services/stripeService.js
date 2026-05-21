const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function createCheckoutSession(userId) {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      metadata: {
        userId: userId,
      },
      subscription_data: {
        trial_period_days: 7,
        metadata: {
          userId: userId,
        },
      },
      success_url: `${process.env.BASE_URL}/install-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/cancel`,
    });
    return session.url;
  } catch (err) {
    console.error("Stripe checkout session error:", err.message);
    throw new Error("Unable to create checkout session.");
  }
}

module.exports = { createCheckoutSession };
