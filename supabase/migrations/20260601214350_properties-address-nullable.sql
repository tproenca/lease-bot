-- Make properties.address nullable.
-- Apartments do not need an address — their building already has one.
-- Houses and commercial properties still require address (enforced at the API layer).
ALTER TABLE properties ALTER COLUMN address DROP NOT NULL;
