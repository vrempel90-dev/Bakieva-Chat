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

  it("ignores ordinary chat messages", () => {
    expect(isLikelyChefQuestion("Всем доброе утро")).toBe(false);
    expect(isLikelyChefQuestion("Спасибо большое")).toBe(false);
  });
});
