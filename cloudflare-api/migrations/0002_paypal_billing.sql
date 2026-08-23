PRAGMA foreign_keys = ON;

-- Billing tables are shared by the Cloudflare API and the Pages Worker that
-- serves the public pricing/account pages.
CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  price_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  scheduled_change_action TEXT,
  scheduled_change_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paypal_subscription_details (
  subscription_id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_type TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_value TEXT,
  currency_code TEXT,
  billing_interval_unit TEXT,
  billing_interval_count INTEGER,
  start_time TEXT,
  next_billing_at TEXT,
  last_payment_at TEXT,
  last_payment_amount_value TEXT,
  last_payment_currency_code TEXT,
  failed_payments_count INTEGER NOT NULL DEFAULT 0,
  status_update_time TEXT,
  paypal_payer_id TEXT,
  subscriber_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  last_event_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_paypal_subscription_customer
  ON paypal_subscription_details(customer_id);

CREATE INDEX IF NOT EXISTS idx_paypal_subscription_status
  ON paypal_subscription_details(status);

CREATE TABLE IF NOT EXISTS paypal_webhook_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL,
  subscription_id TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_paypal_webhook_subscription
  ON paypal_webhook_events(subscription_id);
