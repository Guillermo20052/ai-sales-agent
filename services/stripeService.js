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
    success_url:
      "https://a9b5a386-8e68-4cc3-9b36-ccd6db49e494-00-f01uu4m4bexo.picard.replit.dev/success",
    cancel_url:
      "https://a9b5a386-8e68-4cc3-9b36-ccd6db49e494-00-f01uu4m4bexo.picard.replit.dev/cancel",
  });

  return session.url;
}

module.exports = { createCheckoutSession };
