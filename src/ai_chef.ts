import { config } from "./config.js";

const NO_REPLY = "__NO_REPLY__";

const QUESTION_HINT = /[?？]|\b(как|почему|зачем|чем|сколько|какой|какая|какие|можно\s+ли|что\s+делать|подскажите|помогите|посоветуйте|как\s+исправить|как\s+заменить|қалай|неге|немен|қанша|қандай|бола\s+ма|не\s+істеу|айтып\s+жібер|көмектес)\b/iu;
const CHEF_PREFIX = /^\s*(?:аи|ai)?\s*(?:повар|кондитер|аспаз)\s*[,!:—-]?/iu;

export function shouldTreatAsChefQuestion(input: {
  text: string;
  mentionedBot?: boolean;
  repliedToBot?: boolean;
}) {
  const text = input.text.trim();
  if (text.length < 3 || text.length > 1500) return false;
  if (input.mentionedBot || input.repliedToBot || CHEF_PREFIX.test(text)) return true;
  return QUESTION_HINT.test(text);
}

function stripBotMention(text: string, username?: string) {
  if (!username) return text.trim();
  return text.replace(new RegExp(`@${username}\\b`, "ig"), "").trim();
}

function extractText(response: any) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const parts: string[] = [];
  for (const item of response?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const content of item?.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

export async function askAiChef(input: {
  text: string;
  botUsername?: string;
  replyContext?: string | null;
}) {
  if (!config.OPENAI_API_KEY) return null;

  const question = stripBotMention(input.text, input.botUsername);
  const context = input.replyContext?.trim()
    ? `\n\nСообщение, на которое отвечает пользователь:\n${input.replyContext.trim().slice(0, 800)}`
    : "";

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${config.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({
      model: config.OPENAI_MODEL,
      store: false,
      reasoning: { effort: "none" },
      max_output_tokens: 450,
      instructions: [
        "Ты AI-кондитер внутри закрытого сообщества Bakieva Chat.",
        "Отвечай только на вопросы о кондитерском деле, выпечке, десертах, ингредиентах, технологиях приготовления, хранении, пересчёте рецептур, себестоимости и организации работы кондитера.",
        `Если вопрос не относится к этим темам, ответь ровно ${NO_REPLY} без дополнительного текста.`,
        "Отвечай на том же языке, на котором написал пользователь: русском или казахском.",
        "Ответ должен быть практичным, коротким и понятным, обычно 2–6 абзацев или небольшой список.",
        "Не выдавай себя за Амину Бакиеву и не утверждай, что знаешь закрытый рецепт Bakieva Chat, если его содержание не передано в вопросе.",
        "Если точного рецепта или пропорций недостаточно, прямо скажи, какие данные нужны.",
        "Не придумывай технологические факты. Если есть несколько возможных причин дефекта, перечисли наиболее вероятные и способы проверки.",
        "Для вопросов о хранении, температуре, яйцах, молочных продуктах и другой пищевой безопасности выбирай безопасную рекомендацию."
      ].join("\n"),
      input: `Вопрос участника:\n${question}${context}`
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI Responses API HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = extractText(data);
  if (!text || text === NO_REPLY) return null;
  return text.slice(0, 3500);
}
