import { config } from "./config.js";

const NO_REPLY = "__NO_REPLY__";

export { isLikelyChefQuestion } from "./ai_chef_questions.js";

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

export type AiChefConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export async function askAiChef(input: {
  text: string;
  replyContext?: string | null;
  history?: AiChefConversationMessage[];
  knowledge?: string;
}) {
  if (!config.OPENAI_API_KEY) return null;

  const replyContext = input.replyContext?.trim()
    ? `\n\nСообщение, на которое отвечает участник:\n${input.replyContext.trim().slice(0, 1200)}`
    : "";

  const history = (input.history ?? [])
    .slice(-10)
    .map(message =>
      `${message.role === "assistant" ? "AI-повар" : "Участник"}: ${message.content.trim().slice(0, 1200)}`
    )
    .join("\n");

  const historyBlock = history
    ? `\n\nНедавний диалог с этим участником:\n${history}`
    : "";

  const knowledgeBlock = input.knowledge?.trim()
    ? `\n\nПроверенная база знаний Bakieva Chat:\n${input.knowledge.trim().slice(0, 16000)}`
    : "";

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({
      model: config.OPENAI_MODEL,
      store: false,
      reasoning: { effort: "none" },
      max_output_tokens: 520,
      instructions: [
        "Ты AI-повар и помощник сообщества Bakieva Chat.",
        "Ты отвечаешь на две группы запросов: (1) кондитерские вопросы; (2) вопросы о Bakieva Chat — подписка, цена, оплата, продление, содержание чата, рецепты, уроки, расписание новых материалов, таблицы, себестоимость и навигация по материалам.",
        "Понимай смысл даже без вопросительного знака, с опечатками, разговорными сокращениями и разными формулировками.",
        "Учитывай недавний диалог. Короткая реплика вроде «Корпусный кофе» может быть прямым ответом на твой предыдущий уточняющий вопрос.",
        `Если сообщение не является вопросом/просьбой и не является понятным продолжением недавнего диалога, ответь ровно ${NO_REPLY} без пояснений.`,
        "Отвечай на том же языке, на котором написал участник: русском или казахском.",
        "Пиши практично, дружелюбно и по делу. Обычно 1–5 коротких абзацев или небольшой список.",
        "Не выдавай себя за Амину Бакиеву.",
        "Факты о составе Bakieva Chat, наличии конкретного рецепта, месте таблицы или урока бери только из переданной проверенной базы знаний.",
        "Если в базе нет подтверждения конкретного рецепта или точного места материала, не выдумывай. Скажи, что пока не можешь подтвердить это по базе, и уточни название или предложи администратору добавить материал в базу.",
        "Не молчи на релевантный вопрос о Bakieva Chat только потому, что точного ответа нет: дай честный полезный ответ или уточняющий вопрос.",
        "По кондитерской технологии можешь использовать общие профессиональные знания, но не придумывай закрытые рецепты Bakieva Chat.",
        "Если дефект может иметь несколько причин, перечисли наиболее вероятные причины и что проверить.",
        "В вопросах пищевой безопасности выбирай безопасный вариант и не советуй использовать явно испорченные продукты."
      ].join("\n"),
      input:
        `Текущее сообщение участника:\n${input.text.trim()}` +
        replyContext +
        historyBlock +
        knowledgeBlock
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `OpenAI Responses API HTTP ${response.status}: ${body.slice(0, 300)}`
    );
  }

  const data = await response.json();
  const text = extractText(data);
  if (!text || text === NO_REPLY) return null;
  return text.slice(0, 3500);
}
