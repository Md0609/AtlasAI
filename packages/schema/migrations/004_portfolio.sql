-- 004_portfolio — §B4 group 4: portfolios, positions, transactions,
-- private_assets — user state; transactions from day 1 (FR-3.3).
--
-- §27.3.4: transactions are the source of truth; positions are a derived,
-- reconciled fold over transactions, recomputed in the same DB transaction
-- as any transaction write (§27.4 strong consistency: money).

CREATE TABLE portfolios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL,
  type          text NOT NULL CHECK (type IN ('taxable','tax_advantaged','pension','other')),
  base_currency text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX portfolios_user_idx ON portfolios (user_id) WHERE deleted_at IS NULL;

CREATE TABLE transactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES portfolios(id),
  security_id uuid REFERENCES securities(id),  -- null for pure cash movements
  tx_type     text NOT NULL CHECK (tx_type IN
                ('buy','sell','dividend','split','spinoff','fee','fx','deposit','withdrawal')),
  trade_date  date NOT NULL,
  quantity    numeric,
  price       numeric,                         -- per unit, in currency
  amount      numeric NOT NULL,                -- signed cash effect in currency
  currency    text NOT NULL,                   -- §27.3.3
  fee         numeric NOT NULL DEFAULT 0,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (tx_type NOT IN ('buy','sell','dividend','split','spinoff') OR security_id IS NOT NULL)
);
CREATE INDEX transactions_portfolio_idx ON transactions (portfolio_id, trade_date);
-- §29.3: positions(security_id)-style index on transactions too — demand
-- forecasting groups by security across users.
CREATE INDEX transactions_security_idx ON transactions (security_id);

-- Derived positions (materialized fold over transactions).
CREATE TABLE positions (
  portfolio_id uuid NOT NULL REFERENCES portfolios(id),
  security_id  uuid NOT NULL REFERENCES securities(id),
  quantity     numeric NOT NULL,
  avg_cost     numeric,                        -- per unit, in cost_currency
  cost_currency text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (portfolio_id, security_id)
);
-- §29.3: non-obvious but critical — the demand forecast is a GROUP BY
-- security_id across every user's positions, and it runs constantly.
CREATE INDEX positions_security_idx ON positions (security_id);

-- Derived cash balances per currency (fold over cash effects).
CREATE TABLE cash_balances (
  portfolio_id uuid NOT NULL REFERENCES portfolios(id),
  currency     text NOT NULL,
  amount       numeric NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (portfolio_id, currency)
);

-- FR-3.10: private/illiquid assets as opaque line items. The user tells us
-- the value; we mark it stale after 12 months (§14.2). Never auto-valued.
CREATE TABLE private_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id  uuid NOT NULL REFERENCES portfolios(id),
  name          text NOT NULL,
  asset_class   text NOT NULL,                 -- e.g. real_estate, private_equity, collectible
  value         numeric NOT NULL,
  currency      text NOT NULL,
  country       text,
  liquidity     text NOT NULL DEFAULT 'illiquid' CHECK (liquidity IN ('illiquid','semi_liquid')),
  valued_at     date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX private_assets_portfolio_idx ON private_assets (portfolio_id) WHERE deleted_at IS NULL;
