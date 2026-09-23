const QUESTION_HINT =
  /[?？]|как|почему|чем|сколько|какой|какая|какие|можно\s+ли|есть\s+ли|где|что\s+делать|подскажите|помогите|посоветуйте|заменить|пересчитать|қалай|неге|немен|қанша|қандай|қайда|бар\s+ма|бола\s+ма|не\s+істеу|айтыңыз|көмектес/iu;

const DOMAIN_OR_SERVICE_HINT =
  /рецеп|урок|курс|чат|подпис|оплат|продл|цен|стоим|себесто|таблиц|материал|эфир|разбор|встреч|bakieva|бакиева|корпус|ганаш|крем|начин|шоколад|торт|десерт|бисквит|мусс|пектин|желатин|глюкоз|сироп|сахар|мук|ягод|малин|клубнич|кофе|инвентар|температур|хранен|декор|сату|жазылым|төлем|баға|рецепт|сабақ|материал|өзіндік\s*құн|крем|шоколад/iu;

const FUZZY_TARGETS = [
  "подписка",
  "стоимость",
  "себестоимость",
  "рецепт",
  "урок",
  "оплата",
  "продлить",
  "корпусный",
  "ганаш",
  "желатин",
  "шоколад",
  "bakieva"
];

function editDistance(a: string, b: string) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return prev[b.length];
}

function hasFuzzyIntent(text: string) {
  const words = text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  return words.some(word =>
    FUZZY_TARGETS.some(target => {
      const maxDistance = target.length >= 7 ? 2 : 1;
      return Math.abs(word.length - target.length) <= maxDistance &&
        editDistance(word, target) <= maxDistance;
    })
  );
}

export function isLikelyChefQuestion(text: string, hasRecentContext = false) {
  const value = text.trim();
  if (value.length < 2 || value.length > 1800 || value.startsWith("/")) return false;

  const obviousChatter =
    /^(всем\s+доброе\s+утро|доброе\s+утро|добрый\s+вечер|спасибо(?:\s+большое)?|понятно|ясно|ок|окей|хорошо|рахмет|түсінікті|👍+|❤️+|🔥+)[!. ]*$/iu;
  if (obviousChatter.test(value)) return false;

  if (hasRecentContext) return true;

  if (QUESTION_HINT.test(value) ||
      DOMAIN_OR_SERVICE_HINT.test(value) ||
      hasFuzzyIntent(value)) {
    return true;
  }

  // Let the model make the semantic decision for natural multi-word messages.
  // It can return __NO_REPLY__ for ordinary chat, while this avoids brittle
  // punctuation/keyword requirements for real questions with typos.
  const words = value.split(/\s+/).filter(Boolean);
  return words.length >= 2 && value.length >= 6;
}
