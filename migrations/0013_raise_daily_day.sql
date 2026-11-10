-- Cost guard: pulse's joins_today/joins_week filter raise_daily by day alone, and the primary key
-- (raise_id, day) cannot serve a day-only predicate, so both were full scans of all history.
-- Write overhead per the D1 pricing model: a write that includes the indexed column adds one written
-- row (first join of a UTC day per RAISE); same-day counter updates (joins = joins + 1) do not
-- include `day`. The ON CONFLICT path's metered shape is on the pre-go real-D1 verification list.
CREATE INDEX raise_daily_day ON raise_daily(day);
