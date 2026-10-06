-- Pin the Kaspi Pay URL used by new 10 000 / 25 000 KZT customers.
-- Keep the historical kaspi_pay_url untouched so legacy 5 000 KZT payments
-- can continue to use their separate route until legacy_kaspi_pay_url is set.
INSERT INTO settings(key,value)
VALUES ('new_kaspi_pay_url','https://pay.kaspi.kz/pay/8j1mpcx4')
ON CONFLICT(key) DO UPDATE SET
  value=EXCLUDED.value,
  updated_at=NOW();
