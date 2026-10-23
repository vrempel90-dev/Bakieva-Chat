import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const hasPostgres=Boolean(process.env.TEST_DATABASE_URL);
describe.skipIf(!hasPostgres)("Railway-stable WhatsApp purchase lifecycle on real PostgreSQL",()=>{
  let db:typeof import("./db.js");
  let report:typeof import("./buyer_sales.js");
  const userId=912345678901;
  const user2=912345678902;

  beforeAll(async()=>{
    process.env.DATABASE_URL=process.env.TEST_DATABASE_URL!;
    process.env.BOT_TOKEN="123456789:local-validation-token";
    process.env.ADMIN_IDS="42";
    process.env.PAID_CHANNEL_ID="-1001111111111";
    process.env.KASPI_MERCHANT_BIN="123456789012";
    process.env.OFFER_URL="https://example.com/offer";
    process.env.PRIVACY_URL="https://example.com/privacy";
    process.env.DATA_CONSENT_URL="https://example.com/consent";
    process.env.SUBSCRIPTION_TERMS_URL="https://example.com/terms";
    db=await import("./db.js");
    report=await import("./buyer_sales.js");
    await db.migrate();
  },120_000);
  afterAll(async()=>{if(db)await db.pool.end();});

  it("preserves full numbered production migrations 001..029",async()=>{
    const r=await db.pool.query("SELECT name FROM schema_migrations ORDER BY name");
    expect(r.rows.some(x=>x.name==="028_membership_history.sql")).toBe(true);
    expect(r.rows.some(x=>x.name==="029_buyer_profiles.sql")).toBe(true);
  });

  it("does not activate a freshly verified purchase before WhatsApp consent, then activates exactly once",async()=>{
    await db.ensureUser({id:userId,first_name:"Тестовая"});
    const p=await db.beginPlanPaymentSession(userId,"monthly",5000,30);
    const approval=await db.approvePayment(p.id,42);
    expect(approval?.activeUntil).toBeNull();
    const before=await db.pool.query("SELECT 1 FROM subscriptions WHERE user_id=$1",[userId]);
    expect(before.rowCount).toBe(0);
    const payment=await db.pool.query("SELECT status,meta FROM payments WHERE id=$1",[p.id]);
    expect(payment.rows[0].status).toBe("approved");
    expect(payment.rows[0].meta.whatsapp_required).toBe(true);

    await db.pool.query(`INSERT INTO buyer_profiles(user_id,whatsapp_e164,data_consent_at)
      VALUES($1,'+77001234567',NOW())`,[userId]);
    const first=await db.activateDeferredProfilePurchases(userId);
    expect(first).toBeInstanceOf(Date);
    const second=await db.activateDeferredProfilePurchases(userId);
    expect(second).toBeNull();
    const active=await db.pool.query("SELECT active_until FROM subscriptions WHERE user_id=$1",[userId]);
    expect(active.rowCount).toBe(1);
    expect(new Date(active.rows[0].active_until).getTime()).toBe(first!.getTime());
  });

  it("normalizes international and Kazakhstan numbers without pretending WhatsApp verification",async()=>{
    const {normalizeBuyerPhone}=await import("./buyer_profiles.js");
    expect(normalizeBuyerPhone("+7 (700) 123-45-67")).toBe("+77001234567");
    expect(normalizeBuyerPhone("87001234567")).toBe("+77001234567");
    expect(normalizeBuyerPhone("+447700900123")).toBe("+447700900123");
    expect(normalizeBuyerPhone("+123")).toBeNull();
    expect(normalizeBuyerPhone("example")).toBeNull();
  });

  it("rejects a third tariff and obsolete 10k or five-month offers at payment creation",async()=>{
    await expect(db.beginPlanPaymentSession(userId,"legacy_monthly",5000,30))
      .rejects.toThrow("Unknown or outdated subscription plan");
    await expect(db.beginPlanPaymentSession(userId,"five_months",25000,150))
      .rejects.toThrow("Unknown or outdated subscription plan");
    await expect(db.beginPlanPaymentSession(userId,"monthly",10000,30))
      .rejects.toThrow("Unknown or outdated subscription plan");
    await expect(db.beginPlanPaymentSession(userId,"six_months",25000,150))
      .rejects.toThrow("Unknown or outdated subscription plan");
  });

  it("does not change a previously confirmed historical five-month purchase",async()=>{
    const oldBuyer=912345678903;
    await db.ensureUser({id:oldBuyer,first_name:"Прежняя"});
    const expires=new Date("2027-05-01T00:00:00Z");
    await db.pool.query(`INSERT INTO subscriptions(user_id,status,active_until)
      VALUES($1,'active',$2)`,[oldBuyer,expires]);
    const receipt=await db.pool.query(`INSERT INTO payments(user_id,provider,amount,status,approved_at,meta)
      VALUES($1,'kaspi_receipt',25000,'approved',NOW(),
        '{"plan_code":"five_months","duration_days":150}'::jsonb)
      RETURNING id`,[oldBuyer]);
    await db.migrate(); // repeat deployment migration must not rewrite historical contracts
    const historical=await db.pool.query(`SELECT p.amount,p.meta,s.active_until
      FROM payments p JOIN subscriptions s ON s.user_id=p.user_id
      WHERE p.id=$1`,[receipt.rows[0].id]);
    expect(Number(historical.rows[0].amount)).toBe(25000);
    expect(historical.rows[0].meta.duration_days).toBe(150);
    expect(new Date(historical.rows[0].active_until).getTime()).toBe(expires.getTime());
  });

  it("immediately activates a new payment when the saved profile already has consent",async()=>{
    await db.ensureUser({id:user2,first_name:"Зарина"});
    await db.pool.query(`INSERT INTO buyer_profiles(user_id,whatsapp_e164,data_consent_at)
      VALUES($1,'+77001112233',NOW())`,[user2]);
    const p=await db.beginPlanPaymentSession(user2,"six_months",25000,180);
    const approved=await db.approvePayment(p.id,42);
    expect(approved?.activeUntil).toBeInstanceOf(Date);
    expect(await db.activateDeferredProfilePurchases(user2)).toBeNull();
  });

  it("exports individual payments as a real CSV without sending Telegram traffic",async()=>{
    const api={sendMessage:vi.fn(async()=>({})),sendDocument:vi.fn(async()=>({}))};
    await report.sendSalesForDay({api} as never,42,new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Almaty"})
      .split("/").reverse().join("-"));
    expect(api.sendDocument).toHaveBeenCalledOnce();
  });
});
