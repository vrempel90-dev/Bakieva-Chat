import { Bot, InputFile } from "grammy";
import { pool } from "./db.js";
import { config } from "./config.js";

function isoInAlmaty(now: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: config.ADMIN_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const n=(type:string)=>p.find(v=>v.type===type)?.value??"";
  return `${n("year")}-${n("month")}-${n("day")}`;
}
function shiftDay(day: string, days: number): string {
  const ms = Date.parse(day + "T00:00:00Z");
  return new Date(ms + days*86_400_000).toISOString().slice(0,10);
}
function csvCell(v: unknown): string {
  const value=String(v??"");
  // Prevent formulas when a file is opened in Excel or similar apps.
  const safe=/^[=+\-@]/.test(value) ? "'"+value : value;
  return '"'+safe.replace(/"/g,'""')+'"';
}
type Sale={id:number; name:string; telegramId:number; whatsapp:string|null;
  amount:number; plan:string; days:number|null; approvedAt:Date; activeUntil:Date|null};
async function getSales(day:string|null):Promise<Sale[]> {
  if(day!==null && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day)))) throw new Error("Invalid report day");
  const r=await pool.query(`
    SELECT p.id,p.user_id,p.amount,p.approved_at,p.meta->>'plan_code' AS plan,
      CASE WHEN p.meta->>'duration_days' ~ '^[0-9]+$'
        THEN (p.meta->>'duration_days')::integer ELSE NULL END AS days,
      u.first_name,u.last_name,b.whatsapp_e164,s.active_until
    FROM payments p
      JOIN users u ON u.telegram_id=p.user_id
      LEFT JOIN buyer_profiles b ON b.user_id=p.user_id
      LEFT JOIN subscriptions s ON s.user_id=p.user_id AND s.status='active'
    WHERE p.status='approved' AND
      ($1::text IS NULL OR (p.approved_at AT TIME ZONE $2)::date=$1::date)
    ORDER BY p.approved_at,p.id`,[day,config.ADMIN_TIMEZONE]);
  return r.rows.map(v=>({
    id:Number(v.id),name:[v.first_name,v.last_name].filter(Boolean).join(" ")||"Без имени",
    telegramId:Number(v.user_id),whatsapp:v.whatsapp_e164||null,
    amount:Number(v.amount),plan:v.plan||"архивный тариф",
    days:v.days===null?null:Number(v.days),
    approvedAt:new Date(v.approved_at),activeUntil:v.active_until?new Date(v.active_until):null
  }));
}
function saleText(day:string,items:Sale[]):string[] {
  const total=items.reduce((sum,v)=>sum+v.amount,0);
  const out=[`📊 Bakieva Chat — продажи за ${day}`,
    `Подтверждённых покупок: ${items.length}`,
    `Выручка: ${total.toLocaleString("ru-RU")} ₸`, ""];
  if(!items.length) out.push("Подтверждённых покупок за день нет.");
  for (const [i,v] of items.entries()) {
    out.push(`${i+1}. ${v.name} | TG ${v.telegramId} | WhatsApp ${v.whatsapp??"не указан"}`);
    out.push(`Тариф: ${v.plan}, ${v.days??"?"} дней | ${v.amount.toLocaleString("ru-RU")} ₸ | #${v.id}`);
    out.push(`Доступ до: ${v.activeUntil?.toLocaleDateString("ru-RU",{timeZone:config.ADMIN_TIMEZONE})??"неактивен"}`);
  }
  const result:string[]=[];let block="";
  for(const line of out){
    if(block.length+line.length+1>3400){result.push(block);block="";}
    block+=(block?"\n":"")+line;
  }
  if(block)result.push(block);
  return result;
}
function salesCSV(items:Sale[]):Buffer {
  const head=["Payment ID","Name","Telegram ID","WhatsApp","Plan","Days","Amount KZT","Approved at ISO","Subscription until ISO"];
  const rows=items.map(v=>[v.id,v.name,String(v.telegramId),v.whatsapp??"",v.plan,
    v.days??"",v.amount,v.approvedAt.toISOString(),v.activeUntil?.toISOString()??""]);
  return Buffer.from("\uFEFF"+[head,...rows].map(row=>row.map(csvCell).join(";")).join("\r\n"),"utf8");
}
export async function sendSalesForDay(bot:Bot,adminId:number,day:string) {
  const sales=await getSales(day);
  for(const part of saleText(day,sales)) await bot.api.sendMessage(adminId,part);
  await bot.api.sendDocument(adminId,new InputFile(salesCSV(sales),`bakieva_sales_${day}.csv`),
    {caption:`CSV: ${sales.length} подтверждённых покупок за ${day}`});
}
export async function exportFullSales(bot:Bot,adminId:number) {
  const sales=await getSales(null);
  await bot.api.sendDocument(adminId,new InputFile(salesCSV(sales),"bakieva_all_sales.csv"),{
    caption:`Вся история: ${sales.length} подтверждённых покупок (повторные покупки считаются отдельно).`
  });
}
export async function exportMarketingContacts(bot:Bot,adminId:number) {
  const r=await pool.query(`SELECT b.user_id,u.first_name,u.last_name,b.whatsapp_e164
    FROM buyer_profiles b JOIN users u ON u.telegram_id=b.user_id
    WHERE b.marketing_consent_at IS NOT NULL AND b.whatsapp_e164 IS NOT NULL
      AND u.marketing_opt_in=TRUE ORDER BY b.user_id`);
  const head=["Telegram ID","Name","WhatsApp"];
  const values=r.rows.map(v=>[String(v.user_id),[v.first_name,v.last_name].filter(Boolean).join(" "),v.whatsapp_e164]);
  const csvText="\uFEFF"+[head,...values].map(row=>row.map(csvCell).join(";")).join("\r\n");
  await bot.api.sendDocument(adminId,new InputFile(Buffer.from(csvText,"utf8"),"bakieva_marketing_contacts.csv"),{
    caption:`Контакты с отдельным согласием: ${values.length}`
  });
}
export function registerSalesCommands(bot:Bot) {
  bot.command(["sales_today","sales_yesterday","sales_report","sales_export","contacts_export"],async ctx=>{
    if(!ctx.from || !ctx.message || ctx.chat.type!=="private" || !config.adminIds.has(ctx.from.id)) return;
    const command=ctx.message.text.split(/[\s@]/,1)[0].slice(1);
    const today=isoInAlmaty(new Date());
    const day=command==="sales_yesterday"?shiftDay(today,-1):
      command==="sales_today"?today:ctx.message.text.split(/\s+/)[1]||today;
    try{
      if(command==="sales_export") await exportFullSales(bot,ctx.from.id);
      else if(command==="contacts_export") await exportMarketingContacts(bot,ctx.from.id);
      else await sendSalesForDay(bot,ctx.from.id,day);
    } catch(error){console.error("sales_command_error",error instanceof Error?error.name:"unknown");
      await ctx.reply("Ошибка отчёта. Укажите дату как ГГГГ-ММ-ДД или проверьте данные.");}
  });
  bot.callbackQuery("panel:sales:today",async ctx=>{
    if(ctx.chat?.type!=="private" || !config.adminIds.has(ctx.from.id)) {
      await ctx.answerCallbackQuery({text:"Недоступно"});return;
    }
    await ctx.answerCallbackQuery();
    await sendSalesForDay(bot,ctx.from.id,isoInAlmaty(new Date()));
  });
}
export async function sendScheduledSales(bot:Bot,now=new Date()) {
  const time=new Intl.DateTimeFormat("en-GB",{timeZone:config.ADMIN_TIMEZONE,
    hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(now);
  const configured=process.env.SALES_REPORT_TIME||"09:00";
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(configured)) throw new Error("Invalid SALES_REPORT_TIME");
  if(time<configured) return;
  // Yesterday's completed calendar day, not a partial current day.
  const day=shiftDay(isoInAlmaty(now),-1);
  for(const adminId of config.adminIds){
    const reserved=await pool.query(`INSERT INTO buyer_sales_report_deliveries(admin_id,report_day,state)
      VALUES($1,$2,'reserved') ON CONFLICT DO NOTHING RETURNING 1`,[adminId,day]);
    if(!reserved.rowCount) continue;
    try{
      // Mark uncertain before contacting Telegram to avoid duplicates after ambiguous failures.
      await pool.query(`UPDATE buyer_sales_report_deliveries SET state='uncertain'
        WHERE admin_id=$1 AND report_day=$2`,[adminId,day]);
      await sendSalesForDay(bot,adminId,day);
      await pool.query(`UPDATE buyer_sales_report_deliveries
        SET state='sent',sent_at=NOW() WHERE admin_id=$1 AND report_day=$2`,[adminId,day]);
    }catch(error){
      console.error("buyer_sales_delivery_uncertain",{adminId,day,errorType:error instanceof Error?error.name:"unknown"});
    }
  }
}
