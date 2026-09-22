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

export async function askAiChef(input: {
  text: string;
  replyContext?: string | null;
}) {
  if (!config.OPENAI_API_KEY) return null;

  const replyContext = input.replyContext?.trim()
    ? `\n\nКонтекст сообщения, на которое отвечает участник:\n${input.replyContext.trim().slice(0, 900)}`
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
      max_output_tokens: 420,
      instructions: [
        "Ты AI-кондитер сообщества Bakieva Chat.",
        "Отвечай только на вопросы, связанные с кондитерским делом: выпечка, десерты, кремы, начинки, шоколад, тесто, ингредиенты, замены, технологии приготовления, хранение, декор, пересчёт рецептур, себестоимость и организация работы кондитера.",
        `Если вопрос не относится к этим темам, ответь ровно ${NO_REPLY} без пояснений.`,
        "Отвечай на том же языке, на котором написал участник: русском или казахском.",
        "Пиши практично и по делу. Обычно 2–6 коротких абзацев или небольшой список.",
        "Не выдавай себя за Амину Бакиеву.",
        "Не придумывай закрытые рецепты Bakieva Chat. Если точных данных не хватает, попроси нужные граммовки, температуру, размер формы или другие параметры.",
        "Если дефект может иметь несколько причин, перечисли наиболее вероятные причины и что проверить.",
        "В вопросах пищевой безопасности выбирай безопасный вариант и не советуй использовать явно испорченные продукты."
      ].join("\n"),
      input: `Вопрос участника:\n${input.text.trim()}${replyContext}`
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
