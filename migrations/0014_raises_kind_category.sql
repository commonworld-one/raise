-- Cost guard: the Reports area filter reads its list of areas with a skip-scan (one index seek per
-- distinct area) instead of scanning every visible report. Write overhead per the D1 pricing model:
-- a write that includes kind/hidden/category (every card creation, hide/unhide) adds one written row.
CREATE INDEX raises_kind_category ON raises(kind, hidden, category);
