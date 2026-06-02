ALTER TABLE templates
  ADD COLUMN use_case text NOT NULL DEFAULT 'initial'
  CHECK (use_case IN ('initial', 'renewal', 'termination'));
