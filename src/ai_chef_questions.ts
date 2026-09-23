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
      const maxDistance = target.length >= 10 ? 2 : 1;
      return Math.abs(word.length - target.length) <= maxDistance &&
        editDistance(word, target) <= maxDistance;
    })
  );
}

export function isLikelyChefQuestion(text: string, hasRecentContext = false) {
  const value = text.trim();
  if (value.length < 2 || value.length > 1800 || value.startsWith("/")) return false;

  if (hasRecentContext) {
    const acknowledgement = /^(спасибо|понятно|ясно|ок|окей|хорошо|рахмет|түсінікті)[!. ]*$/iu;
    return !acknowledgement.test(value);
  }

  return QUESTION_HINT.test(value) ||
    DOMAIN_OR_SERVICE_HINT.test(value) ||
    hasFuzzyIntent(value);
}
