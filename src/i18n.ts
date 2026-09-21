import type { UserLanguage } from "./db.js";

export type Language = UserLanguage;

export const LANGUAGE_NAMES: Record<Language, string> = {
  ru: "Русский",
  kk: "Қазақша"
};

type Dictionary = {
  welcome: string;
  chooseSection: string;
  about: string;
  content: string;
  menuPayKz: string;
  menuAbout: string;
  menuPayCis: string;
  menuTrial: string;
  menuSupport: string;
  menuLanguage: string;
  freeChannel: string;
  trialUnavailable: string;
  trialIntro: string;
  trialButton: string;
  kaspiPayButton: (price: number) => string;
  kaspiPayment: (price: number, days: number) => string;
  cisPayButton: string;
  cisPayment: string;
  needPaymentFirst: string;
  sendReceipt: string;
  sendReceiptPdf: string;
  receiptPhotoRejected: string;
  receiptNeedPdf: string;
  receiptTooLarge: string;
  receiptChecking: string;
  receiptProcessingFailed: string;
  receiptCreateFailed: string;
  receiptTargetNotConfigured: string;
  receiptUsed: string;
  receiptApplyFailed: string;
  receiptApproved: string;
  accessOnlyActive: string;
  paymentRejected: string;
  supportButton: string;
  marketingDisabledToast: string;
  marketingDisabled: string;
  marketingEnabled: string;
  telegramId: (id: number) => string;
  languageSelected: string;
  chooseLanguage: string;
  accessApproved: (date: string) => string;
  joinChannel: string;
  joinChat: string;
  reminder: (date: string) => string;
  renewButton: string;
  expired: string;
  returnButton: string;
  videoNewsTitle: string;
  newsTitle: string;
  notificationsOff: string;
  genericNews: string;
  legacyRegistered: (date: string) => string;
};

export const I18N: Record<Language, Dictionary> = {
  ru: {
    welcome: `Доброго времени суток✨

Этот бот поможет тебе попасть в Bakieva Chat — закрытую базу уроков и рецептов от Амины Бакиевой.

Доступ оформляется по ежемесячной подписке. Оплатить её можно в любой валюте, а отменить — в любой момент.

Скорее присоединяйся в наше сообщество🫂`,
    chooseSection: "Выберите нужный раздел:",
    about: `Bakieva Chat — закрытое сообщество с уроками, рецептами и новыми материалами от Амины Бакиевой.

Подписка открывает доступ на 30 дней. После окончания срока доступ продлевается после новой подтверждённой оплаты.`,
    content: `В Bakieva Chat:
• закрытая база уроков;
• рецепты и новые материалы;
• обновления и дополнительные уроки;
• доступ к закрытому чату сообщества.`,
    menuPayKz: "🇰🇿 Оплатить доступ — Казахстан",
    menuAbout: "📘 Подробнее о Bakieva Chat",
    menuPayCis: "🌍 Оплатить доступ — страны СНГ",
    menuTrial: "🔥 Бесплатный пробный урок",
    menuSupport: "🧑🏻‍💼 Служба поддержки",
    menuLanguage: "🌐 Сменить язык",
    freeChannel: "🎁 Бесплатный канал",
    trialUnavailable: "Пробный урок пока обновляется. Ссылка появится здесь после публикации.",
    trialIntro: `🔥 Бесплатный пробный урок

Чтобы вы могли оценить качество наших уроков и понять, подходит ли вам формат Bakieva Chat, мы подготовили для вас бесплатный урок.

🍓 Корпусная клубничка

Понравился урок? ❤️

Тогда скорее вступай в Bakieva Chat, чтобы получить полный доступ к рецептам, и урокам от Амины.

В чате регулярно выходят:
• новые рецепты и уроки.
• обновления материалов.
• бизнес-разборы.
• эфиры.
• живые встречи и общение с другими кондитерами.`,
    trialButton: "▶️ Смотреть пробный урок",
    kaspiPayButton: price => `💳 Оплатить ${price.toLocaleString("ru-RU")} ₸ через Kaspi`,
    kaspiPayment: (price, days) => `Стоимость подписки — ${price.toLocaleString("ru-RU")} ₸ на ${days} дней.

Для клиентов из Казахстана доступна оплата через Kaspi. После оплаты скачайте фискальный чек Kaspi в формате PDF и отправьте PDF-файл сюда. Бот автоматически считает данные чека и проверит оплату.`,
    cisPayButton: "🌍 Перейти к оплате",
    cisPayment: `Оплата подписки для стран СНГ

Для оплаты используется платёжный сервис Tribute. Обратите внимание: в зависимости от выбранного способа оплаты сервис может взимать дополнительную комиссию. Точная итоговая сумма будет показана до подтверждения платежа.`,
    needPaymentFirst: "Сначала откройте оплату",
    sendReceipt: "Отправьте чек",
    sendReceiptPdf: "Отправьте сюда фискальный чек Kaspi именно в формате PDF. Фото, скриншоты и другие форматы для подтверждения оплаты не принимаются.",
    receiptPhotoRejected: "Фото и скриншоты не принимаются. Скачайте фискальный чек Kaspi в формате PDF и отправьте его как файл.",
    receiptNeedPdf: "Нужен именно PDF-файл фискального чека Kaspi.",
    receiptTooLarge: "PDF слишком большой. Отправьте исходный фискальный чек Kaspi размером до 10 МБ.",
    receiptChecking: "🔎 Читаю PDF-чек и проверяю данные оплаты...",
    receiptProcessingFailed: "❌ Не удалось обработать PDF-чек. Скачайте исходный фискальный чек Kaspi и отправьте файл ещё раз.",
    receiptCreateFailed: "Не удалось создать проверку платежа. Попробуйте ещё раз.",
    receiptTargetNotConfigured: "✅ Чек подтверждён, но выдача доступа в закрытый канал и чат ещё не настроена полностью.",
    receiptUsed: "❌ Этот чек уже использовался для активации подписки.",
    receiptApplyFailed: "Не удалось применить этот чек к текущему платежу.",
    receiptApproved: "✅ PDF-чек подтверждён. Оплата принята автоматически.",
    accessOnlyActive: "Доступ в Bakieva Chat доступен только при активной оплаченной подписке.",
    paymentRejected: "Платёж не найден или сумма не совпала. Если вы оплатили, напишите в службу поддержки.",
    supportButton: "💬 Служба поддержки",
    marketingDisabledToast: "Рассылка отключена",
    marketingDisabled: "Вы отписались от информационных и рекламных рассылок.",
    marketingEnabled: "Рассылка включена.",
    telegramId: id => `Ваш Telegram ID: ${id}`,
    languageSelected: "✅ Язык интерфейса: русский.",
    chooseLanguage: "Выберите язык / Тілді таңдаңыз:",
    accessApproved: date => `✅ Оплата подтверждена. Доступ активен до ${date} включительно.

Ссылки действуют 1 час. После перехода отправьте заявку на вступление — бот одобрит её только для аккаунта с активной подпиской.`,
    joinChannel: "📚 Вступить в закрытый канал",
    joinChat: "💬 Вступить в закрытый чат",
    reminder: date => `⏳ До окончания подписки осталось не больше 3 дней. Доступ действует до ${date}.

Чтобы не потерять доступ, продлите подписку.`,
    renewButton: "💳 Продлить подписку",
    expired: "Срок подписки закончился, поэтому доступ к платным материалам закрыт. Вы можете вернуться в Bakieva Chat в любой момент.",
    returnButton: "Вернуться в Bakieva Chat",
    videoNewsTitle: "🎬 Новое видео в Bakieva Chat",
    newsTitle: "📰 Новость Bakieva Chat",
    notificationsOff: "🔕 Отключить уведомления",
    genericNews: "Опубликована новая новость.",
    legacyRegistered: date => `✅ Текущая подписка зарегистрирована.

Доступ зафиксирован минимум до ${date}.
За 3 дня до окончания бот напомнит о продлении.
Если вы продлите подписку заранее, новый срок будет добавлен к действующему.`
  },
  kk: {
    welcome: `Қош келдіңіз✨

Бұл бот сізге Амина Бакиеваның сабақтары, рецептері және жаңа материалдары жинақталған жабық Bakieva Chat қауымдастығына қосылуға көмектеседі.

Қолжетімділік ай сайынғы жазылым арқылы беріледі. Төлемді қолжетімді төлем тәсілдерімен жасауға болады, ал жазылымды кез келген уақытта тоқтатуға болады.

Біздің қауымдастыққа қосылыңыз🫂`,
    chooseSection: "Қажетті бөлімді таңдаңыз:",
    about: `Bakieva Chat — Амина Бакиеваның сабақтары, рецептері және жаңа материалдары жарияланатын жабық қауымдастық.

Жазылым 30 күнге қолжетімділік береді. Мерзім аяқталғаннан кейін жаңа төлем расталған соң қолжетімділік ұзартылады.`,
    content: `Bakieva Chat ішінде:
• жабық сабақтар базасы;
• рецепттер мен жаңа материалдар;
• жаңартулар және қосымша сабақтар;
• қауымдастықтың жабық чатына қолжетімділік.`,
    menuPayKz: "🇰🇿 Қолжетімділікті төлеу — Қазақстан",
    menuAbout: "📘 Bakieva Chat туралы толығырақ",
    menuPayCis: "🌍 Қолжетімділікті төлеу — ТМД",
    menuTrial: "🔥 Тегін сынақ сабағы",
    menuSupport: "🧑🏻‍💼 Қолдау қызметі",
    menuLanguage: "🌐 Тілді өзгерту",
    freeChannel: "🎁 Тегін арна",
    trialUnavailable: "Сынақ сабағы әзірге жаңартылуда. Сілтеме жарияланғаннан кейін осы жерде пайда болады.",
    trialIntro: `🔥 Тегін сынақ сабағы

Сабақтарымыздың сапасын бағалап, Bakieva Chat форматы сізге сәйкес келетінін түсіну үшін сізге тегін сабақ дайындадық.

🍓 Корпустық құлпынай

Сабақ ұнады ма? ❤️

Онда Аминаның рецепттері мен сабақтарына толық қолжетімділік алу үшін Bakieva Chat-қа қосылыңыз.

Чатта тұрақты түрде:
• жаңа рецепттер мен сабақтар.
• материалдардың жаңартулары.
• бизнес-талдаулар.
• тікелей эфирлер.
• офлайн кездесулер және басқа кондитерлермен қарым-қатынас.`,
    trialButton: "▶️ Сынақ сабағын көру",
    kaspiPayButton: price => `💳 Kaspi арқылы ${price.toLocaleString("kk-KZ")} ₸ төлеу`,
    kaspiPayment: (price, days) => `Жазылым құны — ${price.toLocaleString("kk-KZ")} ₸, мерзімі — ${days} күн.

Қазақстандағы клиенттер Kaspi арқылы төлей алады. Төлемнен кейін Kaspi фискалдық чегін PDF форматында жүктеп, осы жерге PDF-файл ретінде жіберіңіз. Бот чек деректерін автоматты түрде оқып, төлемді тексереді.`,
    cisPayButton: "🌍 Төлемге өту",
    cisPayment: `ТМД елдеріне арналған жазылым төлемі

Төлем Tribute сервисі арқылы жүргізіледі. Назар аударыңыз: таңдалған төлем тәсіліне байланысты сервис қосымша комиссия алуы мүмкін. Нақты қорытынды сома төлемді растағанға дейін көрсетіледі.`,
    needPaymentFirst: "Алдымен төлем бөлімін ашыңыз",
    sendReceipt: "Чекті жіберіңіз",
    sendReceiptPdf: "Kaspi фискалдық чегін дәл PDF форматында жіберіңіз. Фото, скриншот және басқа форматтар төлемді растау үшін қабылданбайды.",
    receiptPhotoRejected: "Фото мен скриншот қабылданбайды. Kaspi фискалдық чегін PDF форматында жүктеп, файл ретінде жіберіңіз.",
    receiptNeedPdf: "Kaspi фискалдық чегінің PDF-файлы қажет.",
    receiptTooLarge: "PDF файлы тым үлкен. Kaspi фискалдық чегінің түпнұсқа файлын 10 МБ-қа дейінгі көлемде жіберіңіз.",
    receiptChecking: "🔎 PDF-чекті оқып, төлем деректерін тексеріп жатырмын...",
    receiptProcessingFailed: "❌ PDF-чекті өңдеу мүмкін болмады. Kaspi фискалдық чегінің түпнұсқа PDF-файлын қайта жіберіңіз.",
    receiptCreateFailed: "Төлемді тексеру әрекетін жасау мүмкін болмады. Қайталап көріңіз.",
    receiptTargetNotConfigured: "✅ Чек расталды, бірақ жабық арна мен чатқа қолжетімділік беру әлі толық бапталмаған.",
    receiptUsed: "❌ Бұл чек жазылымды белсендіру үшін бұрын қолданылған.",
    receiptApplyFailed: "Бұл чекті ағымдағы төлемге қолдану мүмкін болмады.",
    receiptApproved: "✅ PDF-чек расталды. Төлем автоматты түрде қабылданды.",
    accessOnlyActive: "Bakieva Chat-қа кіру тек белсенді төленген жазылымы бар пайдаланушыларға қолжетімді.",
    paymentRejected: "Төлем табылмады немесе сома сәйкес келмейді. Егер төлем жасаған болсаңыз, қолдау қызметіне жазыңыз.",
    supportButton: "💬 Қолдау қызметі",
    marketingDisabledToast: "Хабарламалар өшірілді",
    marketingDisabled: "Сіз ақпараттық және жарнамалық хабарламалардан бас тарттыңыз.",
    marketingEnabled: "Хабарламалар қосылды.",
    telegramId: id => `Сіздің Telegram ID: ${id}`,
    languageSelected: "✅ Интерфейс тілі: қазақша.",
    chooseLanguage: "Выберите язык / Тілді таңдаңыз:",
    accessApproved: date => `✅ Төлем расталды. Қолжетімділік ${date} күніне дейін белсенді.

Сілтемелер 1 сағат жарамды. Сілтеме арқылы өткеннен кейін қосылуға өтінім жіберіңіз — бот оны тек белсенді жазылымы бар аккаунт үшін мақұлдайды.`,
    joinChannel: "📚 Жабық арнаға қосылу",
    joinChat: "💬 Жабық чатқа қосылу",
    reminder: date => `⏳ Жазылымның аяқталуына 3 күннен аз уақыт қалды. Қолжетімділік ${date} күніне дейін жарамды.

Қолжетімділікті жоғалтпау үшін жазылымды ұзартыңыз.`,
    renewButton: "💳 Жазылымды ұзарту",
    expired: "Жазылым мерзімі аяқталды, сондықтан ақылы материалдарға қолжетімділік жабылды. Bakieva Chat-қа кез келген уақытта қайта орала аласыз.",
    returnButton: "Bakieva Chat-қа қайта оралу",
    videoNewsTitle: "🎬 Bakieva Chat-та жаңа видео",
    newsTitle: "📰 Bakieva Chat жаңалығы",
    notificationsOff: "🔕 Хабарламаларды өшіру",
    genericNews: "Жаңа жаңалық жарияланды.",
    legacyRegistered: date => `✅ Ағымдағы жазылым тіркелді.

Қолжетімділік кемінде ${date} күніне дейін бекітілді.
Аяқталуына 3 күн қалғанда бот ұзарту туралы еске салады.
Егер алдын ала ұзартсаңыз, жаңа мерзім ағымдағы жазылымға қосылады.`
  }
};

export function t(language: Language | null | undefined) {
  return I18N[language === "kk" ? "kk" : "ru"];
}

export function locale(language: Language) {
  return language === "kk" ? "kk-KZ" : "ru-RU";
}

export function formatDate(date: Date, language: Language) {
  return date.toLocaleDateString(locale(language));
}
