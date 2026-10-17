import type { Account, Assignment, Campaign } from "../types";

/** Сколько минут осталось аккаунту до завершения кампании. */
export function remainingMinutes(account: Account, campaign: Campaign): number {
  const done = account.minutesByCampaign[campaign.id] ?? 0;
  return Math.max(0, campaign.requiredMinutes - done);
}

/** Успеет ли аккаунт закончить кампанию до её окончания (просмотр в реальном времени). */
export function isFeasible(account: Account, campaign: Campaign, now = Date.now()): boolean {
  const left = remainingMinutes(account, campaign);
  if (left === 0) return false;
  const minutesToEnd = (new Date(campaign.endsAt).getTime() - now) / 60000;
  return minutesToEnd >= left;
}

/**
 * Жадный планировщик: каждому аккаунту — по одной кампании.
 * Приоритет: кампании, которые скоро заканчиваются, но ещё выполнимы,
 * и разные аккаунты стараются получить разные кампании (больше наград суммарно).
 */
export function planAssignments(
  accounts: Account[],
  campaigns: Campaign[],
  now = Date.now()
): Assignment[] {
  const active = campaigns
    .filter((c) => new Date(c.endsAt).getTime() > now && new Date(c.startsAt).getTime() <= now)
    .sort((a, b) => new Date(a.endsAt).getTime() - new Date(b.endsAt).getTime());

  const result: Assignment[] = [];
  const takenByCampaign = new Map<string, number>();

  for (const account of accounts) {
    const options = active.filter((c) => isFeasible(account, c, now) && !account.claimed.includes(c.id));
    if (options.length === 0) continue;

    // Выбранная вручную кампания приоритетнее автоподбора, если её ещё можно пройти.
    const pinned = account.pinned ? options.find((c) => c.id === account.pinned) : undefined;
    if (pinned) {
      takenByCampaign.set(pinned.id, (takenByCampaign.get(pinned.id) ?? 0) + 1);
      result.push({ accountId: account.id, campaignId: pinned.id, channels: pinned.channels });
      continue;
    }

    // Сначала — кампании, на которые ещё не назначен ни один аккаунт.
    const best =
      options.find((c) => !takenByCampaign.has(c.id)) ?? options[0];

    takenByCampaign.set(best.id, (takenByCampaign.get(best.id) ?? 0) + 1);
    result.push({
      accountId: account.id,
      campaignId: best.id,
      channels: best.channels,
    });
  }
  return result;
}
