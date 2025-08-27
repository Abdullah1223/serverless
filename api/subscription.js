import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient("https://voikpdiypqnulhscibme.supabase.co","eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvaWtwZGl5cHFudWxoc2NpYm1lIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTYxNzI4MCwiZXhwIjoyMDcxMTkzMjgwfQ.3nkPCohS6CLmh3YbqeT6rEfZws1ZAFY0ZTZc2Gj1aGo");

const stripe = new Stripe('sk_test_51Rx0fjDakjho3yKVRUjNARYAKsWSi7Ldo3phg86qDGIYc7pQm7DZdqbJnb20rhPNkRqFxSSEWRaAsvMdc4lpqo0K00tXDfrbfy')


export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': "http://localhost:5173",
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true',
    },
  });
}



export default async function handler(req,res){


    const priceIds = {
        'pro':"price_1S0hgYDakjho3yKVUN3foWWk",
        'starter':"price_1S0hh0Dakjho3yKViRNDgBdi"
    }
    const userId= req.body.userId
    const email =req.body.email;
    const paymentMethodId= req.body.paymentMethodId;
    const planId = req.body.planId;
    const priceId = priceIds[planId];
    let customerId;
    const { data: userRow } = await supabase.from("users").select("stripe_customer_id,email").eq("id", userId).single();
    if (userRow?.stripe_customer_id) { customerId= userRow.stripe_customer_id;}
    else{
        const customer = await stripe.customers.create({ email, metadata: { userId } });
        await supabase.from("users").update({ stripe_customer_id: customer.id }).eq("id", userId);    
        customerId = customer.id;
    }
  
    
    
    
    // 3) attach PM and set as default
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    const price = await stripe.prices.retrieve(priceId);
    const productPrice = price.unit_amount/100
    let invoiceAmount;
    if(planId=="starter")
    {
        const percentage = productPrice * (10/100)
        console.log('percentage ' , percentage)
         const totalAmountUsd = percentage + 0.30;
         console.log('TOTAL AMOUNT USD',totalAmountUsd)
         const deductAmount = totalAmountUsd*100
         invoiceAmount = deductAmount;
    }else if(planId=="pro"){
        
        const percentage = productPrice * (7.5/100)
        console.log('percentage ' , percentage)
         const totalAmountUsd = percentage + 0.40;
         console.log('TOTAL AMOUNT USD',totalAmountUsd)
         const deductAmount = totalAmountUsd*100
         invoiceAmount = deductAmount;        
    }

    await stripe.invoiceItems.create({
        customer: customerId,
        amount:invoiceAmount ,   // total fee in cents
        currency: "usd",
        description: "Platform Fee (10% + $0.30)",
      });

    // 4) create subscription in incomplete state
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: {
        payment_method_types: ["card"],
        save_default_payment_method: "on_subscription",
      },
      expand: ['latest_invoice.confirmation_secret'],
    });

    
  const {error:subError}=  await supabase.from("subscriptions").upsert({
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
      plan_type: planId,
      status: subscription.status,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });


    const { error: sellerError } = await supabase
    .from('sellers')
    .upsert({
      id: userId,
      user_id: userId,
      business_name:  'My Business',
      email:email,
      status: 'approved',
      approved_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id'
    });
 console.log('seller error' , sellerError)
 console.log('sub error' , subError)
  return res.status(200).send({
      subscriptionId: subscription.id,
      clientSecret: subscription.latest_invoice.confirmation_secret.client_secret,
    });
}
