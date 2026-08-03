# Stripe Workflow Changes — 2026-06-09

## WF17 `stripe-renew` (id=17)

**Node:** `stripe_call` (type=`code`)

**Change:** `plan_key` source switched from DB lookup to request body.

Before: `local plan_key = existing_sub and existing_sub.rows and existing_sub.rows[1] and existing_sub.rows[1].billing_cycle or "monthly"`

After: `local plan_key = ctx.body.plan_key`

**Why:** Allows callers to choose a different billing cycle on renewal instead of being locked to the previously stored `billing_cycle`.

---

## WF20 `stripe-webhook` (id=20)

**Node:** `fulfill_payment` (type=`db_transaction`), 3rd SQL statement

**Change:** `expires_at` calculation now accumulates from existing expiry instead of restarting from `NOW()`.

Before: `NOW() + INTERVAL '1 month/year'`

After: `GREATEST(COALESCE(expires_at, NOW()), NOW()) + INTERVAL '1 month/year'`

**Why:** Prevents subscription time loss on renewal — remaining days are preserved when renewing before expiry.
