import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// Supabase client
const supabase = createClient(
  "https://voikpdiypqnulhscibme.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvaWtwZGl5cHFudWxoc2NpYm1lIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTYxNzI4MCwiZXhwIjoyMDcxMTkzMjgwfQ.3nkPCohS6CLmh3YbqeT6rEfZws1ZAFY0ZTZc2Gj1aGo"
);

// Stripe client
const stripe = new Stripe(
  "sk_test_51Rx0fjDakjho3yKVRUjNARYAKsWSi7Ldo3phg86qDGIYc7pQm7DZdqbJnb20rhPNkRqFxSSEWRaAsvMdc4lpqo0K00tXDfrbfy"
);

export default async function handler(req, res) {
  // Handle CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end(); // Preflight response
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const priceIds = {
      pro: "price_1S0hgYDakjho3yKVUN3foWWk",
      starter: "price_1S0hh0Dakjho3yKViRNDgBdi",
    };

    const { userId, email, paymentMethodId, planId } = req.body;
    const priceId = priceIds[planId];
    if (!priceId) return res.status(400).json({ error: "Invalid planId" });

    // 1) Get or create customer
    let customerId;
    const { data: userRow, error: userError } = await supabase
      .from("users")
      .select("stripe_customer_id,email")
      .eq("id", userId)
      .single();

    if (userError) console.log("Supabase user fetch error:", userError);

    if (userRow?.stripe_customer_id) {
      customerId = userRow.stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email,
        metadata: { userId },
      });
      await supabase
        .from("users")
        .update({ stripe_customer_id: customer.id })
        .eq("id", userId);
      customerId = customer.id;
    }

    // 2) Attach payment method & set default
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // 3) Calculate invoice amount
    const price = await stripe.prices.retrieve(priceId);
    const productPrice = price.unit_amount / 100;
    let invoiceAmount;

    if (planId === "starter") {
      const totalAmountUsd = productPrice * 0.1 + 0.3;
      invoiceAmount = Math.round(totalAmountUsd * 100);
    } else if (planId === "pro") {
      const totalAmountUsd = productPrice * 0.075 + 0.4;
      invoiceAmount = Math.round(totalAmountUsd * 100);
    }

    // 4) Create invoice item (platform fee)
    await stripe.invoiceItems.create({
      customer: customerId,
      amount: invoiceAmount,
      currency: "usd",
      description: `Platform Fee (${planId === "starter" ? "10% + $0.30" : "7.5% + $0.40"})`,
    });

    // 5) Create subscription in incomplete state
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: {
        payment_method_types: ["card"],
        save_default_payment_method: "on_subscription",
      },
      expand: ["latest_invoice.payment_intent"],
    });

    // 6) Upsert subscription in Supabase
    const { error: subError } = await supabase
      .from("subscriptions")
      .upsert(
        {
          user_id: userId,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscription.id,
          plan_type: planId,
          status: subscription.status,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

    // 7) Upsert seller in Supabase
    const { error: sellerError } = await supabase.from("sellers").upsert(
      {
        id: userId,
        user_id: userId,
        business_name: "My Business",
        email,
        status: "approved",
        approved_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    console.log("Supabase subscription error:", subError);
    console.log("Supabase seller error:", sellerError);

    return res.status(200).json({
      subscriptionId: subscription.id,
      clientSecret: subscription.latest_invoice.payment_intent.client_secret,
    });
  } catch (err) {
    console.error("Serverless function error:", err);
    return res.status(500).json({ error: "Internal server error", details: err.message });
  }
}
