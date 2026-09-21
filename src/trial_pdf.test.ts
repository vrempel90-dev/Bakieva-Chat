import { describe, expect, it } from "vitest";
import { generateTrialRecipePdf, trialRecipeFileName } from "./trial_pdf.js";

describe("trial recipe PDF", () => {
  for (const lang of ["ru", "kk"] as const) {
    it("generates a valid " + lang + " PDF", async () => {
      const pdf = await generateTrialRecipePdf(lang);
      expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      expect(pdf.length).toBeGreaterThan(10_000);
      expect(trialRecipeFileName(lang)).toMatch(/\.pdf$/);
    });
  }
});
