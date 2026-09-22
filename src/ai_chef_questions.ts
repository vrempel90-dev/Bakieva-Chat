const QUESTION_HINT =
  /[?？]|как|почему|чем|сколько|какой|какая|какие|можно\s+ли|что\s+делать|подскажите|помогите|посоветуйте|заменить|пересчитать|қалай|неге|немен|қанша|қандай|бола\s+ма|не\s+істеу|айтыңыз|көмектес/iu;

export function isLikelyChefQuestion(text: string) {
  const value = text.trim();
  if (value.length < 3 || value.length > 1800) return false;
  return QUESTION_HINT.test(value);
}
