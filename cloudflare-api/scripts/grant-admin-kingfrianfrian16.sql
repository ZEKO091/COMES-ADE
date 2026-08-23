-- Complimentary ADMIN entitlement for a single account. Not a schema migration.
PRAGMA foreign_keys = ON;

INSERT INTO customers (customer_id, email, created_at, updated_at, last_event_at)
VALUES (
  'bd9ecd15-fbd1-4920-9fcf-2813b5f0b0ad',
  'kingfrianfrian16@gmail.com',
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
  'admin:kingfrianfrian16@gmail.com',
  'bd9ecd15-fbd1-4920-9fcf-2813b5f0b0ad',
  'active',
  'admin',
  'admin',
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
  'admin:kingfrianfrian16@gmail.com',
  'bd9ecd15-fbd1-4920-9fcf-2813b5f0b0ad',
  'admin',
  'admin',
  'active',
  NULL,
  NULL,
  NULL,
  NULL,
  datetime('now'),
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  datetime('now'),
  NULL,
  'kingfrianfrian16@gmail.com',
  datetime('now'),
  datetime('now'),
  datetime('now'),
  'admin-grant'
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
  next_billing_at = excluded.next_billing_at,
  status_update_time = excluded.status_update_time,
  subscriber_email = excluded.subscriber_email,
  updated_at = excluded.updated_at,
  last_event_at = excluded.last_event_at,
  last_event_id = excluded.last_event_id;
