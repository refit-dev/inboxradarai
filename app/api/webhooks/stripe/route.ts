import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { headers } from "next/headers";
import type Stripe from "stripe";

type PeriodItem = { price?: { id?: string } | null };
type PeriodField = 'current_period_start' | 'current_period_end';
type PlanItem = (items: PeriodItem[]) => PeriodItem | undefined;

// Typed like the removed field, which was also absent at runtime when Stripe omitted it.
function subscriptionPeriod(subscription: object, field: PeriodField, planItem?: PlanItem): number {
  const legacy: unknown = Reflect.get(subscription, field);
  if (typeof legacy === 'number') return legacy;
  const list: unknown = Reflect.get(subscription, 'items');
  const data: unknown = list && typeof list === 'object' ? Reflect.get(list, 'data') : undefined;
  const items = (Array.isArray(data) ? data : []).filter(
    (item): item is PeriodItem => typeof item === 'object' && item !== null,
  );
  const periods = new Set(items.map((item) => Reflect.get(item, field)));
  const chosen = periods.size === 1 ? items[0] : planItem?.(items);
  const value: unknown = chosen ? Reflect.get(chosen, field) : undefined;
  return (typeof value === 'number' ? value : undefined) as number;
}

function getSubscriptionPeriodEnd(subscription: object, planItem?: PlanItem): number {
  return subscriptionPeriod(subscription, 'current_period_end', planItem);
}

// Typed like the removed field under old stripe types, like the new location under new ones.
type InvoiceSubscription<T> = T extends { subscription: infer S }
  ? S
  : T extends { parent: infer P }
    ? NonNullable<P> extends { subscription_details: infer D }
      ? NonNullable<D> extends { subscription: infer S }
        ? S | null
        : string | null
      : string | null
    : string | null;

// The old top-level field when present (old-version payloads), otherwise the new location.
function getInvoiceSubscription<T extends object>(invoice: T): InvoiceSubscription<T> {
  const legacy: unknown = Reflect.get(invoice, 'subscription');
  const parent: unknown = Reflect.get(invoice, 'parent');
  const details: unknown =
    parent && typeof parent === 'object' ? Reflect.get(parent, 'subscription_details') : undefined;
  const moved: unknown =
    details && typeof details === 'object' ? Reflect.get(details, 'subscription') : undefined;
  return (legacy !== undefined ? legacy : (moved ?? null)) as InvoiceSubscription<T>;
}

export async function POST(request: Request) {
  const body = await request.text();
  const signature = headers().get("Stripe-Signature") ?? "";

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET || ""
    );
  } catch (err) {
    return new Response(
      `Webhook Error: ${err instanceof Error ? err.message : "Unknown Error"}`,
      { status: 400 }
    );
  }

  if (event.type === "customer.subscription.updated") {
    const session = event.data.object as Stripe.Subscription;
    try {
      const subscription = await stripe.subscriptions.retrieve(
        session.id as string
      );
      const planId = subscription.items.data[0].price.id;
      const user = await db.user.findFirst({
        where: {
          stripeSubscriptionId: subscription.id,
        },
      });
      if (!user) {
        return new Response(null, {
          status: 200,
        });
      }
      await db.user.update({
        where: {
          stripeSubscriptionId: subscription.id,
        },
        data: {
          stripePriceId: planId,
          stripeCurrentPeriodEnd: new Date(
            (getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000
          ),
          lastFreeTierRefillDate: new Date(
            (getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000
          ),
          changeToFreePlanOnPeriodEnd: subscription.cancel_at_period_end,
        },
      });
    } catch (error) {
      console.error("Error updating user", error);
      return new Response(null, {
        status: 500,
      });
    }
  }
  if (event.type === "customer.subscription.deleted") {
    const session = event.data.object as Stripe.Subscription;
    try {
      const subscription = await stripe.subscriptions.retrieve(
        session.id as string
      );
      const planId = subscription.items.data[0].price.id;
      const user = await db.user.findFirst({
        where: {
          stripeSubscriptionId: subscription.id,
        },
      });
      if (!user) {
        return new Response(null, {
          status: 200,
        });
      }
      await db.user.update({
        where: {
          stripeSubscriptionId: subscription.id,
        },
        data: {
          stripePriceId: planId,
          stripeCurrentPeriodEnd: new Date(),
          lastFreeTierRefillDate: new Date(),
          emailProcessed: 0,
          changeToFreePlanOnPeriodEnd: false,
        },
      });
    } catch (error) {
      console.error("Error updating user", error);
      return new Response(null, {
        status: 500,
      });
    }
  }

  if (event.type === "invoice.payment_succeeded") {
    const session = event.data.object as Stripe.Invoice;
    if (session.billing_reason == "subscription_create") {
      return new Response(null, {
        status: 200,
      });
    }
    try {
      const subscription = await stripe.subscriptions.retrieve(
        (getInvoiceSubscription(session)) as string
      );

      await db.user.update({
        where: {
          stripeSubscriptionId: subscription.id,
        },
        data: {
          stripePriceId: subscription.items.data[0].price.id,
          stripeCurrentPeriodEnd: new Date(
            (getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000
          ),
          lastFreeTierRefillDate: new Date(
            (getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000
          ),
        },
      });
    } catch (error) {
      console.error("Error updating user", error);
      return new Response(null, {
        status: 500,
      });
    }
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    try {
      if (!session?.metadata?.userId) {
        console.warn("No user ID found in metadata");
        return new Response(null, {
          status: 200,
        });
      }
      const subscription = await stripe.subscriptions.retrieve(
        session.subscription as string
      );
      await db.user.update({
        where: {
          id: session.metadata.userId,
        },
        data: {
          stripeCustomerId: subscription.customer as string,
          stripeSubscriptionId: subscription.id,
          stripePriceId: subscription.items.data[0].price.id,
          stripeCurrentPeriodEnd: new Date(
            (getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000
          ),
          lastFreeTierRefillDate: new Date(
            (getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000
          ),
        },
      });
    } catch (error) {
      console.error("Error updating user", error);
      return new Response(null, {
        status: 500,
      });
    }
  }

  return new Response(null, { status: 200 });
}
