-- A document can be under review or approved only once, including concurrent uploads.
-- Existing payments without a receipt hash are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS unique_receipt_pdf_hash
  ON payments ((meta->>'receipt_hash'))
  WHERE status IN ('pending', 'approved') AND meta ? 'receipt_hash';
