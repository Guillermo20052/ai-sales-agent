const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function createCheckoutSession(userId) {
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
      metadata: {
        userId: userId,
      },
    },
    success_url: `${process.env.BASE_URL}/payment-success`,
    cancel_url: `${process.env.BASE_URL}/cancel`,
  });

  return session.url;
}

module.exports = { createCheckoutSession };
