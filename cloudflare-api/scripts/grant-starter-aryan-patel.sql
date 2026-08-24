-- Complimentary Starter entitlement for aryan.patelxcr7@gmail.com (1 month). Not a schema migration.
PRAGMA foreign_keys = ON;

INSERT INTO customers (customer_id, email, created_at, updated_at, last_event_at)
VALUES (
  '23f287e3-5df2-45ef-be93-de1bb4c271ee',
  'aryan.patelxcr7@gmail.com',
  datetime('now'),
  datetime('now'),
  datetime('now')
)
ON CONFLICT(customer_id) DO UPDATE SET
  email = excluded.email,
  updated_at = excluded.updated_at,
  last_event_at = excluded.last_event_at;

INSERT INTO subscriptions (
  subscription_id, customer_id, status, price_id, product_id,
  scheduled_change_action, scheduled_change_at, created_at, updated_at, last_event_at
)
VALUES (
  'manual:starter:aryan.patelxcr7@gmail.com',
  '23f287e3-5df2-45ef-be93-de1bb4c271ee',
  'active',
  'P-28U48476G3567800GNKE432Y',
  'starter',
  NULL,
  NULL,
  datetime('now'),
  datetime('now'),
  datetime('now')
)
ON CONFLICT(subscription_id) DO UPDATE SET
  customer_id = excluded.customer_id,
  status = excluded.status,
  price_id = excluded.price_id,
  product_id = excluded.product_id,
  updated_at = excluded.updated_at,
  last_event_at = excluded.last_event_at;

INSERT INTO paypal_subscription_details (
  subscription_id, customer_id, plan_id, plan_type, status,
  amount_value, currency_code, billing_interval_unit, billing_interval_count,
  start_time, next_billing_at, last_payment_at,
  last_payment_amount_value, last_payment_currency_code, failed_payments_count,
  status_update_time, paypal_payer_id, subscriber_email,
  created_at, updated_at, last_event_at, last_event_id
)
VALUES (
  'manual:starter:aryan.patelxcr7@gmail.com',
  '23f287e3-5df2-45ef-be93-de1bb4c271ee',
  'P-28U48476G3567800GNKE432Y',
  'starter',
  'active',
  '5.00',
  'USD',
  'MONTH',
  1,
  datetime('now'),
  datetime('now', '+1 month'),
  datetime('now'),
  '5.00',
  'USD',
  0,
  datetime('now'),
  NULL,
  'aryan.patelxcr7@gmail.com',
  datetime('now'),
  datetime('now'),
  datetime('now'),
  'manual-starter-grant-1m'
)
ON CONFLICT(subscription_id) DO UPDATE SET
  customer_id = excluded.customer_id,
  plan_id = excluded.plan_id,
  plan_type = excluded.plan_type,
  status = excluded.status,
  amount_value = excluded.amount_value,
  currency_code = excluded.currency_code,
  billing_interval_unit = excluded.billing_interval_unit,
  billing_interval_count = excluded.billing_interval_count,
  start_time = excluded.start_time,
  next_billing_at = excluded.next_billing_at,
  last_payment_at = excluded.last_payment_at,
  last_payment_amount_value = excluded.last_payment_amount_value,
  last_payment_currency_code = excluded.last_payment_currency_code,
  status_update_time = excluded.status_update_time,
  subscriber_email = excluded.subscriber_email,
  updated_at = excluded.updated_at,
  last_event_at = excluded.last_event_at,
  last_event_id = excluded.last_event_id;
