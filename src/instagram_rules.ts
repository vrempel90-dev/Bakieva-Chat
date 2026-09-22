export type InstagramCommentEvent = {
  commentId: string;
  mediaId: string;
  text: string;
  username: string | null;
  fromId: string | null;
};

export function normalizeKeywordList(input: string) {
  return [...new Set(
    input
      .split(/[\n,;]+/)
      .map(value => value.trim().toLocaleLowerCase("ru"))
      .filter(Boolean)
  )].slice(0, 50);
}

export function matchesInstagramRule(
  matchMode: "all" | "keywords",
  keywords: string[],
  text: string
) {
  if (matchMode === "all") return true;
  const haystack = text.toLocaleLowerCase("ru");
  return keywords.some(keyword => haystack.includes(keyword.toLocaleLowerCase("ru")));
}

export function extractInstagramCommentEvents(payload: unknown): InstagramCommentEvent[] {
  if (!payload || typeof payload !== "object") return [];
  const body = payload as any;
  const events: InstagramCommentEvent[] = [];

  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== "comments") continue;
      const value = change?.value ?? {};

      const commentId = String(value.id ?? value.comment_id ?? "").trim();
      const mediaId = String(value.media?.id ?? value.media_id ?? "").trim();
      if (!commentId || !mediaId) continue;

      events.push({
        commentId,
        mediaId,
        text: typeof value.text === "string"
          ? value.text
          : typeof value.message === "string"
            ? value.message
            : "",
        username: typeof value.from?.username === "string"
          ? value.from.username
          : typeof value.username === "string"
            ? value.username
            : null,
        fromId: value.from?.id != null
          ? String(value.from.id)
          : value.from_id != null
            ? String(value.from_id)
            : null
      });
    }
  }

  return events;
}
