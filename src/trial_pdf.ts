import PDFDocument from "pdfkit";
import { createRequire } from "node:module";
import type { UserLanguage } from "./i18n.js";

const require = createRequire(import.meta.url);
const regularFont = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
const boldFont = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");

const PAGE_W = 1024;
const PAGE_H = 1536;
const PURPLE = "#A783EA";
const PALE = "#FFF2B8";
const CREAM = "#FFFDF4";
const PINK = "#F562A4";
const RED = "#E92336";
const GOLD = "#F8E98A";

type RecipeCopy = {
  title: string;
  subtitle: string;
  composition: string;
  ganacheTitle: string;
  ganache: string[];
  fillingTitle: string;
  filling: string[];
  gelatinTitle: string;
  gelatin: string[];
  coatingTitle: string;
  coating: string[];
  yieldText: string;
  method: string;
  gelatinMethod: string;
  ganacheMethod: string[];
  fillingMethod: string[];
  assemblyTitle: string;
  assemblyMethod: string[];
  coatingMethod: string[];
  important: string;
  storageTitle: string;
  storageFrozen: string;
  storageThawed: string;
};

const RECIPE: Record<UserLanguage, RecipeCopy> = {
  ru: {
    title: "«КЛУБНИЧКА»",
    subtitle: "КОРПУСНЫЙ ДЕСЕРТ",
    composition: "СОСТАВ",
    ganacheTitle: "Взбитый шоколадный ганаш:",
    ganache: [
      "Сливки 33% — 500 г",
      "Белый шоколад — 120 г",
      "Желатиновая масса — 30 г",
      "Глюкозный сироп — 10 г",
      "Ванильный сироп — по желанию, 1 ч. л."
    ],
    fillingTitle: "Клубничная начинка:",
    filling: [
      "Клубничное пюре — 100 г",
      "Свежая клубника — 70 г",
      "Сахар — 15 г",
      "Ксантан — 2,5 г"
    ],
    gelatinTitle: "Желатиновая масса:",
    gelatin: ["Желатин — 20 г", "Вода — 100 г"],
    coatingTitle: "Покрытие:",
    coating: [
      "Белый шоколад — 200 г",
      "Какао-масло — 200 г",
      "Красный жирорастворимый краситель"
    ],
    yieldText: "Выход: 30 мини-корпусных десертов «Клубничка».",
    method: "Способ приготовления:",
    gelatinMethod:
      "Смешайте желатин с водой и оставьте набухать. Используйте по рецепту. Храните не более 3 суток.",
    ganacheMethod: [
      "Разделите сливки на две части. Первые 250 г сливок смешайте с глюкозным сиропом, нагрейте до 60 °C и добавьте желатиновую массу.",
      "Горячую смесь вылейте на белый шоколад и пробейте блендером до однородности.",
      "Добавьте оставшиеся 250 г холодных сливок и снова пробейте блендером.",
      "Накройте пищевой плёнкой в контакт и стабилизируйте в холодильнике 10–12 часов. Перед сборкой взбейте до мягких, устойчивых пиков."
    ],
    fillingMethod: [
      "Смешайте клубничное пюре с сахаром и проварите 30 секунд. Добавьте ксантан и пробейте блендером до однородного геля.",
      "Нарежьте свежую клубнику кубиками 5 × 5 мм и смешайте с гелем.",
      "Разложите начинку по внутренним формам и заморозьте."
    ],
    assemblyTitle: "СБОРКА",
    assemblyMethod: [
      "Переложите ганаш в кондитерский мешок и заполните формы примерно наполовину.",
      "Вложите замороженную клубничную начинку, полностью закройте её ганашем и разровняйте поверхность.",
      "Заморозьте десерты до полного промораживания."
    ],
    coatingMethod: [
      "Растопите белый шоколад и какао-масло.",
      "Добавьте краситель и пробейте блендером до однородности.",
      "Полностью замороженные десерты окуните в смесь температурой 33 °C и покройте со всех сторон."
    ],
    important: "Важно: перед покрытием десерты должны быть полностью заморожены.",
    storageTitle: "ХРАНЕНИЕ",
    storageFrozen: "В замороженном виде: при −18 °C — до 1 месяца.",
    storageThawed: "После размораживания: в холодильнике — не более 48 часов."
  },
  kk: {
    title: "«ҚҰЛПЫНАЙ»",
    subtitle: "КОРПУСТЫҚ ДЕСЕРТІ",
    composition: "ҚҰРАМЫ",
    ganacheTitle: "Көпіртілген шоколадты ганаш:",
    ganache: [
      "33% кілегей — 500 г",
      "Ақ шоколад — 120 г",
      "Желатин массасы — 30 г",
      "Глюкоза шәрбаты — 10 г",
      "Ванильді шәрбат — қалауыңызша 1 шай қасық"
    ],
    fillingTitle: "Құлпынай салмасы:",
    filling: [
      "Құлпынай езбесі — 100 г",
      "Балғын құлпынай — 70 г",
      "Қант — 15 г",
      "Ксантан — 2,5 г"
    ],
    gelatinTitle: "Желатин массасына:",
    gelatin: ["Желатин — 20 г", "Су — 100 г"],
    coatingTitle: "Қаптама:",
    coating: [
      "Ақ шоколад — 200 г",
      "Какао майы — 200 г",
      "Майда еритін қызыл бояғыш"
    ],
    yieldText: "Шығымы: 30 дана мини-корпустық «Құлпынай» десерті.",
    method: "Дайындау тәсілі:",
    gelatinMethod:
      "Желатинді сумен араластырып, ісінуге қалдырыңыз. Рецепт бойынша қолданыңыз, 3 тәуліктен артық сақтамаңыз.",
    ganacheMethod: [
      "Кілегейді екіге бөліңіз. Алғашқы 250 г кілегейді глюкоза шәрбатымен араластырып, 60 °C-қа дейін қыздырыңыз да, желатин массасын қосыңыз.",
      "Ыстық қоспаны ақ шоколадтың үстіне құйып, біркелкі болғанша блендермен араластырыңыз.",
      "Қалған 250 г салқын кілегейді қосып, қайтадан блендермен араластырыңыз.",
      "Бетіне жанастыра тағамдық үлдірмен жауып, тоңазытқышта 10–12 сағат тұрақтандырыңыз. Құрастырар алдында жұмсақ әрі тұрақты шыңдар пайда болғанша көпіртіңіз."
    ],
    fillingMethod: [
      "Құлпынай езбесін қантпен араластырып, 30 секунд қайнатыңыз. Ксантанды қосып, біркелкі гель болғанша блендермен араластырыңыз.",
      "Балғын құлпынайды 5 × 5 мм текшелерге кесіп, гельмен араластырыңыз.",
      "Салманы ішкі қалыптарға бөліп салып, мұздатыңыз."
    ],
    assemblyTitle: "ҚҰРАСТЫРУ",
    assemblyMethod: [
      "Ганашты кондитерлік қапшыққа салып, қалыптарды шамамен жартысына дейін толтырыңыз.",
      "Мұздатылған құлпынай салмасын салып, үстін ганашпен толық жауып, бетін тегістеңіз.",
      "Десерттерді толық мұздағанша мұздатыңыз."
    ],
    coatingMethod: [
      "Ақ шоколад пен какао майын ерітіңіз.",
      "Бояғышты қосып, біркелкі болғанша блендермен араластырыңыз.",
      "Толық мұздатылған десерттерді 33 °C температурадағы қоспаға батырып қаптаңыз."
    ],
    important: "Маңызды: қаптар алдында десерттер толық мұздатылған болуы керек.",
    storageTitle: "САҚТАУ",
    storageFrozen: "Мұздатылған күйде: −18 °C температурада 1 айға дейін.",
    storageThawed: "Жібіткеннен кейін: тоңазытқышта 48 сағаттан артық сақтамаңыз."
  }
};

function setupPage(doc: PDFKit.PDFDocument) {
  doc.rect(0, 0, PAGE_W, PAGE_H).fill(PALE);
  doc.roundedRect(50, 45, PAGE_W - 100, PAGE_H - 90, 34).fill(CREAM);
}

function heading(doc: PDFKit.PDFDocument, text: string, y: number, size = 60) {
  doc.font(boldFont).fontSize(size).fillColor(PURPLE).text(text, 70, y, {
    width: PAGE_W - 140,
    lineGap: 2
  });
}

function sectionTitle(doc: PDFKit.PDFDocument, text: string, y: number, size = 31) {
  doc.font(boldFont).fontSize(size).fillColor(PURPLE).text(text, 78, y, {
    width: PAGE_W - 156
  });
}

function body(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  size = 29,
  lineGap = 9
) {
  doc.font(regularFont).fontSize(size).fillColor(PURPLE).text(text, x, y, {
    width,
    lineGap
  });
  return doc.y;
}

function bullets(
  doc: PDFKit.PDFDocument,
  items: string[],
  x: number,
  y: number,
  width: number,
  size = 28
) {
  doc.font(regularFont).fontSize(size).fillColor(PURPLE);
  let yy = y;
  for (const item of items) {
    doc.text("• " + item, x, yy, { width, lineGap: 5 });
    yy = doc.y + 7;
  }
  return yy;
}

function numbered(
  doc: PDFKit.PDFDocument,
  items: string[],
  x: number,
  y: number,
  width: number,
  size = 29
) {
  doc.font(regularFont).fontSize(size).fillColor(PURPLE);
  let yy = y;
  items.forEach((item, index) => {
    doc.text(String(index + 1) + ". " + item, x, yy, { width, lineGap: 8 });
    yy = doc.y + 22;
  });
  return yy;
}

function addCover(doc: PDFKit.PDFDocument, t: RecipeCopy, lang: UserLanguage) {
  doc.rect(0, 0, PAGE_W, PAGE_H).fill(CREAM);
  doc.font(regularFont).fontSize(28).fillColor(PINK).text(
    lang === "ru" ? "Сообщество счастливых кондитеров" : "Бақытты кондитерлер қауымдастығы",
    0,
    80,
    { width: PAGE_W, align: "center" }
  );
  doc.font(boldFont).fontSize(102).fillColor(PURPLE).text("BAKIEVA", 80, 180, {
    width: 650
  });
  doc.font(regularFont).fontSize(86).fillColor(PINK).text("chat", 590, 235, {
    width: 330
  });
  doc.rect(0, 360, PAGE_W, 18).fill(GOLD);

  const berries = [
    [220, 570, 150, 180],
    [430, 505, 170, 205],
    [650, 560, 155, 190],
    [290, 790, 165, 200],
    [525, 770, 170, 205],
    [740, 800, 160, 195]
  ] as const;
  for (const [x, y, w, h] of berries) {
    doc.ellipse(x, y, w / 2, h / 2).fill(RED);
    doc.ellipse(x - 18, y - 28, w / 7, h / 12).fill("#F96C77");
  }

  doc.rect(0, 1215, PAGE_W, 18).fill(GOLD);
  doc.rect(0, 1233, PAGE_W, PAGE_H - 1233).fill(PURPLE);
  doc.font(boldFont).fontSize(58).fillColor("#FFFFFF").text(t.title, 70, 1305, {
    width: PAGE_W - 140,
    align: "center"
  });
  doc.font(boldFont).fontSize(52).fillColor("#FFFFFF").text(t.subtitle, 70, 1380, {
    width: PAGE_W - 140,
    align: "center"
  });
}

function addComposition(doc: PDFKit.PDFDocument, t: RecipeCopy) {
  setupPage(doc);
  heading(doc, t.composition, 90, 68);
  let y = 205;
  const groups: Array<[string, string[]]> = [
    [t.ganacheTitle, t.ganache],
    [t.fillingTitle, t.filling],
    [t.gelatinTitle, t.gelatin],
    [t.coatingTitle, t.coating]
  ];
  for (const [title, items] of groups) {
    sectionTitle(doc, title, y, 31);
    y += 48;
    y = bullets(doc, items, 88, y, 830, 28) + 18;
  }
  doc.font(boldFont).fontSize(29).fillColor(PURPLE).text(t.yieldText, 120, 1370, {
    width: PAGE_W - 240,
    align: "center",
    underline: true
  });
}

function addGanache(doc: PDFKit.PDFDocument, t: RecipeCopy) {
  setupPage(doc);
  heading(doc, t.gelatinTitle.replace(/:$/, "").toUpperCase(), 85, 55);
  sectionTitle(doc, t.method, 175, 29);
  body(doc, t.gelatinMethod, 78, 225, 860, 28, 9);

  heading(doc, t.ganacheTitle.replace(/:$/, "").toUpperCase(), 505, 48);
  sectionTitle(doc, t.method, 585, 29);
  numbered(doc, t.ganacheMethod, 78, 635, 865, 27);
}

function addFilling(doc: PDFKit.PDFDocument, t: RecipeCopy) {
  setupPage(doc);
  heading(doc, t.fillingTitle.replace(/:$/, "").toUpperCase(), 90, 62);
  sectionTitle(doc, t.method, 310, 30);
  numbered(doc, t.fillingMethod, 78, 385, 860, 34);
}

function addAssembly(doc: PDFKit.PDFDocument, t: RecipeCopy) {
  setupPage(doc);
  heading(doc, t.assemblyTitle, 90, 64);
  sectionTitle(doc, t.method, 295, 30);
  numbered(doc, t.assemblyMethod, 78, 365, 860, 31);

  doc.roundedRect(240, 1040, 545, 330, 24).fill("#F7D7D7");
  doc.ellipse(415, 1195, 210, 150).fill(RED);
  doc.ellipse(610, 1195, 210, 150).fill(RED);
  doc.ellipse(475, 1195, 125, 95).fill("#FFF8E9");
  doc.ellipse(550, 1195, 125, 95).fill("#FFF8E9");
  doc.ellipse(490, 1195, 70, 55).fill("#BE2037");
  doc.ellipse(535, 1195, 70, 55).fill("#BE2037");
}

function addCoating(doc: PDFKit.PDFDocument, t: RecipeCopy) {
  setupPage(doc);
  heading(doc, t.coatingTitle.replace(/:$/, "").toUpperCase(), 90, 64);
  sectionTitle(doc, t.method, 260, 30);
  const y = numbered(doc, t.coatingMethod, 68, 325, 875, 31);
  doc.font(boldFont).fontSize(30).fillColor("#D73944").text("❗ " + t.important, 68, y + 5, {
    width: 875,
    lineGap: 8
  });

  heading(doc, t.storageTitle, 1110, 40);
  body(doc, t.storageFrozen, 68, 1195, 870, 30, 8);
  body(doc, t.storageThawed, 68, 1300, 870, 30, 8);
}

export async function generateTrialRecipePdf(lang: UserLanguage): Promise<Buffer> {
  const t = RECIPE[lang];
  const doc = new PDFDocument({
    size: [PAGE_W, PAGE_H],
    margin: 0,
    autoFirstPage: false,
    info: {
      Title: lang === "ru" ? "Клубничка — корпусный десерт" : "Құлпынай — корпустық десерті",
      Author: "Bakieva Chat"
    }
  });

  const chunks: Buffer[] = [];
  doc.on("data", chunk => chunks.push(Buffer.from(chunk)));

  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.addPage();
  addCover(doc, t, lang);
  doc.addPage();
  addComposition(doc, t);
  doc.addPage();
  addGanache(doc, t);
  doc.addPage();
  addFilling(doc, t);
  doc.addPage();
  addAssembly(doc, t);
  doc.addPage();
  addCoating(doc, t);
  doc.end();

  return finished;
}

export function trialRecipeFileName(lang: UserLanguage) {
  return lang === "ru"
    ? "Клубничка — рецепт Bakieva Chat.pdf"
    : "Құлпынай — Bakieva Chat рецепті.pdf";
}
