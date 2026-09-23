import { describe, expect, it } from "vitest";
import { isLikelyChefQuestion } from "./ai_chef_questions.js";

describe("AI chef question detection", () => {
  it("detects Russian pastry questions", () => {
    expect(isLikelyChefQuestion("Почему ганаш получился слишком жидкий?")).toBe(true);
    expect(isLikelyChefQuestion("Подскажите чем заменить пектин")).toBe(true);
  });

  it("detects Kazakh pastry questions", () => {
    expect(isLikelyChefQuestion("Кремді қалай қоюлатуға болады?")).toBe(true);
  });

  it("understands Bakieva Chat questions without perfect punctuation", () => {
    expect(isLikelyChefQuestion("Есть ли корпусная малина в чате")).toBe(true);
    expect(isLikelyChefQuestion("где себестоимость")).toBe(true);
    expect(isLikelyChefQuestion("сколько стоит подписка")).toBe(true);
    expect(isLikelyChefQuestion("патписка сколько стоит")).toBe(true);
  });

  it("accepts short follow-ups when there is recent conversation context", () => {
    expect(isLikelyChefQuestion("Корпусный кофе", true)).toBe(true);
    expect(isLikelyChefQuestion("А малина", true)).toBe(true);
  });

  it("ignores ordinary chat messages", () => {
    expect(isLikelyChefQuestion("Всем доброе утро")).toBe(false);
    expect(isLikelyChefQuestion("Спасибо большое")).toBe(false);
    expect(isLikelyChefQuestion("/start")).toBe(false);
  });
});
