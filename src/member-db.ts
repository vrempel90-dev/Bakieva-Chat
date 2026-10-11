import { pool } from "./db.js";

export type MemberIdentity = {
  chatId: number;
  userId: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

export type MemberSnapshot = MemberIdentity & { joinedAt?: Date | null };

export async function saveMemberSnapshot(member: MemberSnapshot) {
  await pool.query(
    `INSERT INTO chat_memberships (
       chat_id, user_id, username, first_name, last_name, is_member, joined_at, join_source
     ) VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7)
     ON CONFLICT (chat_id, user_id) DO UPDATE SET
       username=COALESCE(EXCLUDED.username, chat_memberships.username),
       first_name=COALESCE(EXCLUDED.first_name, chat_memberships.first_name),
       last_name=COALESCE(EXCLUDED.last_name, chat_memberships.last_name),
       joined_at=CASE
         WHEN chat_memberships.is_member=FALSE THEN EXCLUDED.joined_at
         ELSE COALESCE(chat_memberships.joined_at, EXCLUDED.joined_at)
       END,
       join_source=CASE
         WHEN chat_memberships.is_member=FALSE THEN EXCLUDED.join_source
         WHEN chat_memberships.joined_at IS NULL AND EXCLUDED.joined_at IS NOT NULL
           THEN EXCLUDED.join_source
         ELSE chat_memberships.join_source
       END,
       is_member=TRUE, left_at=NULL, last_seen_at=NOW()`,
    [
      member.chatId, member.userId, member.username ?? null, member.firstName ?? null,
      member.lastName ?? null, member.joinedAt ?? null,
      member.joinedAt ? "mtproto" : "unknown"
    ]
  );
}

export async function saveMemberEvent(
  member: MemberIdentity,
  action: "joined" | "left",
  occurredAt: Date,
  source: "chat_member" | "service_message"
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const prior = await client.query(
      "SELECT is_member, joined_at, join_source FROM chat_memberships WHERE chat_id=$1 AND user_id=$2 FOR UPDATE",
      [member.chatId, member.userId]
    );
    const priorKnown = prior.rowCount !== null && prior.rowCount > 0;
    const priorIsMember = priorKnown ? Boolean(prior.rows[0].is_member) : null;
    const changed = priorIsMember === null || priorIsMember !== (action === "joined");
    if (action === "joined") {
      await client.query(
        `INSERT INTO chat_memberships(
           chat_id,user_id,username,first_name,last_name,is_member,joined_at,join_source
         ) VALUES($1,$2,$3,$4,$5,TRUE,$6,$7)
         ON CONFLICT(chat_id,user_id) DO UPDATE SET
           username=COALESCE(EXCLUDED.username,chat_memberships.username),
           first_name=COALESCE(EXCLUDED.first_name,chat_memberships.first_name),
           last_name=COALESCE(EXCLUDED.last_name,chat_memberships.last_name),
           is_member=TRUE, left_at=NULL, last_seen_at=NOW(),
           joined_at=CASE WHEN chat_memberships.is_member=FALSE OR chat_memberships.joined_at IS NULL
             THEN EXCLUDED.joined_at ELSE chat_memberships.joined_at END,
           join_source=CASE WHEN chat_memberships.is_member=FALSE OR chat_memberships.joined_at IS NULL
             THEN EXCLUDED.join_source ELSE chat_memberships.join_source END`,
        [
          member.chatId, member.userId, member.username ?? null, member.firstName ?? null,
          member.lastName ?? null, occurredAt, source
        ]
      );
    } else {
      await client.query(
        `INSERT INTO chat_memberships(
           chat_id,user_id,username,first_name,last_name,is_member,left_at
         ) VALUES($1,$2,$3,$4,$5,FALSE,$6)
         ON CONFLICT(chat_id,user_id) DO UPDATE SET
           username=COALESCE(EXCLUDED.username,chat_memberships.username),
           first_name=COALESCE(EXCLUDED.first_name,chat_memberships.first_name),
           last_name=COALESCE(EXCLUDED.last_name,chat_memberships.last_name),
           is_member=FALSE, left_at=$6, last_seen_at=NOW()`,
        [
          member.chatId, member.userId, member.username ?? null, member.firstName ?? null,
          member.lastName ?? null, occurredAt
        ]
      );
    }
    if (changed) {
      await client.query(
        `INSERT INTO membership_events(chat_id,user_id,event_type,event_at,source)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [member.chatId, member.userId, action, occurredAt, source]
      );
    }
    await client.query("COMMIT");
    return changed;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function membershipStats(chatIds: number[]) {
  if (chatIds.length === 0) return [];
  const r = await pool.query(
    `SELECT chat_id,
       COUNT(*) FILTER (WHERE is_member)::int AS current_members,
       COUNT(*) FILTER (WHERE is_member AND joined_at IS NOT NULL)::int AS dated_members,
       COUNT(*) FILTER (WHERE is_member AND join_source='mtproto')::int AS older_members,
       COUNT(*) FILTER (WHERE is_member AND joined_at >= NOW() - INTERVAL '1 day')::int AS last_day,
       COUNT(*) FILTER (WHERE NOT is_member)::int AS left_members
     FROM chat_memberships WHERE chat_id = ANY($1::bigint[])
     GROUP BY chat_id ORDER BY chat_id`,
    [chatIds.map(String)]
  );
  return r.rows.map(row => ({
    chatId: Number(row.chat_id),
    current: Number(row.current_members),
    dated: Number(row.dated_members),
    older: Number(row.older_members),
    lastDay: Number(row.last_day),
    left: Number(row.left_members)
  }));
}

export async function latestMembers(chatIds: number[], limit = 25) {
  if (!chatIds.length) return [];
  const r = await pool.query(
    `SELECT chat_id,user_id,username,first_name,last_name,is_member,joined_at,join_source,first_seen_at,left_at
     FROM chat_memberships WHERE chat_id=ANY($1::bigint[])
     ORDER BY COALESCE(joined_at, first_seen_at) DESC LIMIT $2`,
    [chatIds.map(String), limit]
  );
  return r.rows;
}

export async function allMembers(chatIds: number[]) {
  if (!chatIds.length) return [];
  const r = await pool.query(
    `SELECT chat_id,user_id,username,first_name,last_name,is_member,joined_at,join_source,first_seen_at,left_at
       FROM chat_memberships WHERE chat_id=ANY($1::bigint[])
       ORDER BY chat_id, user_id`,
    [chatIds.map(String)]
  );
  return r.rows;
}
