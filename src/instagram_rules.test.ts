import { describe, expect, it } from "vitest";
import {
  extractInstagramCommentEvents,
  matchesInstagramRule,
  normalizeKeywordList
} from "./instagram_rules.js";

describe("Instagram automation rules", () => {
  it("normalizes keywords", () => {
    expect(normalizeKeywordList("Рецепт, цена\nРЕЦЕПТ; гайд")).toEqual([
      "рецепт",
      "цена",
      "гайд"
    ]);
  });

  it("matches all or keyword modes", () => {
    expect(matchesInstagramRule("all", [], "Любой комментарий")).toBe(true);
    expect(matchesInstagramRule("keywords", ["рецепт", "гайд"], "Хочу рецепт пожалуйста")).toBe(true);
    expect(matchesInstagramRule("keywords", ["рецепт"], "Очень красиво!")).toBe(false);
  });

  it("extracts comment webhook events", () => {
    const events = extractInstagramCommentEvents({
      object: "instagram",
      entry: [{
        changes: [{
          field: "comments",
          value: {
            id: "comment-1",
            text: "Хочу рецепт",
            media: { id: "media-1" },
            from: { id: "user-1", username: "guest" }
          }
        }]
      }]
    });

    expect(events).toEqual([{
      commentId: "comment-1",
      mediaId: "media-1",
      text: "Хочу рецепт",
      username: "guest",
      fromId: "user-1"
    }]);
  });
});
