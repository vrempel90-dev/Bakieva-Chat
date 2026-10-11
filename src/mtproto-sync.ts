import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "./config.js";
import { saveMemberSnapshot } from "./member-db.js";

type SyncResult = {
  chatId: number;
  found: number;
  saved: number;
  partial: boolean;
  error?: string;
};

function shortError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 180);
}

function chatInput(chatId: number): Api.InputChannel {
  const repr = String(chatId);
  if (!repr.startsWith("-100")) {
    throw new Error("Автоматическая синхронизация поддерживает супергруппы и каналы (ID -100...).");
  }
  // Telegram permits zero access hashes for bots in some peer contexts.
  // For private chats this can still fail depending on server-side permissions.
  return new Api.InputChannel({
    channelId: BigInt(repr.slice(4)),
    accessHash: BigInt(0)
  });
}

/**
 * Best-effort roster reconstruction using the official MTProto API.
 * A channel participant's date is a join date only for the relevant constructor;
 * administrator promotion dates MUST NOT be passed off as join dates.
 * API search/visibility restrictions may prevent complete enumeration.
 */
export async function syncLegacyMembers(chatIds: number[]): Promise<SyncResult[]> {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) {
    throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH не заданы");
  }
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 3
  });
  const reports: SyncResult[] = [];
  await client.start({ botAuthToken: config.BOT_TOKEN });
  try {
    for (const chatId of chatIds) {
      const report: SyncResult = { chatId, found: 0, saved: 0, partial: true };
      reports.push(report);
      try {
        const input = chatInput(chatId);
        const members = new Map<number, {
          userId: number; username: string | null; firstName: string | null;
          lastName: string | null; joinedAt: Date | null;
        }>();
        let expectedCount: number | null = null;
        let reachedPageCap = false;

        async function scan(filter: Api.TypeChannelParticipantsFilter, maxPages: number) {
          let offset = 0;
          for (let page = 0; page < maxPages; page++) {
            const response = await client.invoke(new Api.channels.GetParticipants({
              channel: input, filter, offset, limit: 200, hash: BigInt(0)
            }));
            if (!("participants" in response)) break;
            if (expectedCount === null && filter instanceof Api.ChannelParticipantsRecent) {
              expectedCount = response.count;
            }
            const identities = new Map<string, Api.User>();
            for (const user of response.users) {
              if (user instanceof Api.User) identities.set(String(user.id), user);
            }
            for (const participant of response.participants) {
              if (!("userId" in participant)) continue;
              const userId = Number(String(participant.userId));
              if (!Number.isSafeInteger(userId)) continue;
              const user = identities.get(String(userId));
              let joinedAt: Date | null = null;
              if (
                (participant instanceof Api.ChannelParticipant ||
                 participant instanceof Api.ChannelParticipantSelf) &&
                typeof participant.date === "number" && participant.date > 0
              ) {
                joinedAt = new Date(participant.date * 1000);
              }
              const prior = members.get(userId);
              members.set(userId, {
                userId, username: user?.username ?? prior?.username ?? null,
                firstName: user?.firstName ?? prior?.firstName ?? null,
                lastName: user?.lastName ?? prior?.lastName ?? null,
                joinedAt: joinedAt ?? prior?.joinedAt ?? null
              });
            }
            offset += response.participants.length;
            if (response.participants.length < 200 || !response.participants.length) break;
            if (page === maxPages - 1) reachedPageCap = true;
            await new Promise(resolve => setTimeout(resolve, 180));
          }
        }

        // A recent-participants filter often returns only a subset in large chats.
        await scan(new Api.ChannelParticipantsRecent({}), 30);
        if (expectedCount === null || members.size < expectedCount) {
          const terms = [
            ..."abcdefghijklmnopqrstuvwxyz",
            ..."абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
            ..."0123456789"
          ];
          for (const term of terms) {
            await scan(new Api.ChannelParticipantsSearch({ q: term }), 12);
            if (expectedCount !== null && members.size >= expectedCount) break;
            await new Promise(resolve => setTimeout(resolve, 180));
          }
        }

        report.found = members.size;
        for (const member of members.values()) {
          await saveMemberSnapshot({ chatId, ...member });
          report.saved++;
        }
        report.partial = expectedCount === null || members.size < expectedCount || reachedPageCap;
      } catch (err) {
        report.error = shortError(err);
        console.warn("Legacy members sync error", { chatId, error: report.error });
      }
    }
  } finally {
    await client.disconnect();
  }
  return reports;
}
