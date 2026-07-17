-- 002_security_master — §B4 group 2: securities, listings, identifiers,
-- corporate_actions. "The security master everything references."
--
-- Structural invariant (§27.2): the security-master domain has NO user
-- foreign keys anywhere. It is physically impossible to write user data
-- into the shared analysis path, because these tables have nowhere to put it.
-- (Verified by an architecture test in packages/schema/src tests.)

CREATE TABLE securities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  type          text NOT NULL CHECK (type IN ('equity','etf','fund','bond','cash','other')),
  is_fund       boolean NOT NULL DEFAULT false,
  gics_sector   text,
  gics_industry text,
  country       text,                        -- ISO-3166 alpha-2, country of risk
  currency      text NOT NULL,               -- pricing currency of primary listing
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (is_fund = (type IN ('etf','fund')))
);

-- Listings: (exchange, ticker) over validity windows. Ticker changes close the
-- old row and open a new one — history is retained, resolution is by window.
CREATE TABLE listings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  security_id uuid NOT NULL REFERENCES securities(id),
  exchange    text NOT NULL,                 -- MIC, e.g. XNAS, XETR
  ticker      text NOT NULL,
  currency    text NOT NULL,
  is_primary  boolean NOT NULL DEFAULT true,
  valid_from  date NOT NULL,
  valid_to    date                            -- null = current
);
CREATE UNIQUE INDEX listings_live_uni ON listings (exchange, ticker) WHERE valid_to IS NULL;
CREATE INDEX listings_security_idx ON listings (security_id);

-- External identifiers (ISIN first-class; entity resolution key).
CREATE TABLE security_identifiers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  security_id uuid NOT NULL REFERENCES securities(id),
  id_type     text NOT NULL CHECK (id_type IN ('isin','cusip','sedol','figi')),
  value       text NOT NULL,
  valid_from  date NOT NULL,
  valid_to    date
);
CREATE UNIQUE INDEX security_identifiers_live_uni
  ON security_identifiers (id_type, value) WHERE valid_to IS NULL;
CREATE INDEX security_identifiers_security_idx ON security_identifiers (security_id);

CREATE TABLE corporate_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  security_id uuid NOT NULL REFERENCES securities(id),
  action_type text NOT NULL CHECK (action_type IN
                ('split','dividend','ticker_change','merger','spinoff','delisting')),
  ex_date     date NOT NULL,
  ratio       numeric,                       -- splits: new shares per old share
  cash_amount numeric,                       -- dividends: per-share cash
  currency    text,                          -- required when cash_amount present (§27.3.3)
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  source      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (cash_amount IS NULL OR currency IS NOT NULL),
  UNIQUE (security_id, action_type, ex_date)
);
CREATE INDEX corporate_actions_exdate_idx ON corporate_actions (ex_date);
