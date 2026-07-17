-- 003_market_data — §B4 group 3: price_bars (partitioned), fx_rates,
-- fundamentals, fund_holdings — time-series + look-through.
--
-- §27.3.6: every table that grows with events is partitioned by month from
-- day one. Retrofitting partitioning onto a 400M-row table is avoidable
-- with an hour of thought now. Retention for prices: 10y (§29.2).

CREATE TABLE price_bars (
  security_id    uuid NOT NULL REFERENCES securities(id),
  bar_date       date NOT NULL,
  open           numeric NOT NULL,
  high           numeric NOT NULL,
  low            numeric NOT NULL,
  close          numeric NOT NULL,
  adjusted_close numeric NOT NULL,           -- split-adjusted (dividend adj. deliberately excluded at v1; documented)
  volume         numeric NOT NULL DEFAULT 0,
  currency       text NOT NULL,              -- §27.3.3
  source         text NOT NULL,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (security_id, bar_date)
) PARTITION BY RANGE (bar_date);

-- Partition management: ingest calls ensure_price_bars_partition() for each
-- month it is about to write. Deterministic naming; idempotent.
CREATE OR REPLACE FUNCTION ensure_price_bars_partition(d date) RETURNS void AS $$
DECLARE
  month_start date := date_trunc('month', d)::date;
  month_end   date := (date_trunc('month', d) + interval '1 month')::date;
  part_name   text := 'price_bars_' || to_char(month_start, 'YYYY_MM');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF price_bars FOR VALUES FROM (%L) TO (%L)',
      part_name, month_start, month_end
    );
  END IF;
END $$ LANGUAGE plpgsql;

CREATE TABLE fx_rates (
  base_currency  text NOT NULL,
  quote_currency text NOT NULL,
  rate_date      date NOT NULL,
  rate           numeric NOT NULL,           -- 1 base = rate quote
  source         text NOT NULL,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (base_currency, quote_currency, rate_date)
);

CREATE TABLE fundamentals (
  security_id uuid NOT NULL REFERENCES securities(id),
  as_of       date NOT NULL,
  period      text NOT NULL CHECK (period IN ('annual','quarter','ttm')),
  metric      text NOT NULL,
  value       numeric NOT NULL,
  currency    text,
  source      text NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (security_id, as_of, period, metric)
);

-- Self-referential to securities (§28.3): enables recursive look-through
-- fund → fund → equity. Funds of funds are common in European portfolios;
-- a non-recursive model silently under-reports exposure.
CREATE TABLE fund_holdings (
  fund_security_id    uuid NOT NULL REFERENCES securities(id),
  holding_security_id uuid NOT NULL REFERENCES securities(id),
  weight              numeric NOT NULL CHECK (weight >= 0 AND weight <= 1),
  as_of               date NOT NULL,
  source              text NOT NULL,
  ingested_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fund_security_id, holding_security_id, as_of)
);
CREATE INDEX fund_holdings_holding_idx ON fund_holdings (holding_security_id);
