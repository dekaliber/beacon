// ── Income origin vs. deposit ──────────────────────────────────────────────────
// An Income row's `accountId`/`date` say where the income originated and when it
// was earned (option close, dividend pay date, sale date). `depositAccountId`/
// `depositDate` say where the cash landed and when. Rows written before the
// deposit fields existed have them null and read as "landed where and when it
// originated" until backfilled.

import type { DividendElection } from "@prisma/client";

type IncomeLike = { accountId: string; date: Date; depositAccountId: string | null; depositDate: Date | null };

/** Account the cash landed in. */
export const landingAccountId = (i: IncomeLike): string => i.depositAccountId ?? i.accountId;

/** Day the cash landed. */
export const landingDate = (i: IncomeLike): Date => i.depositDate ?? i.date;

/**
 * Where income earned in an investment account is deposited by default: the
 * account's cash destination when it pays as cash, otherwise the account itself
 * (reinvested, kept as settlement cash, or "ask each time").
 */
export function defaultDepositAccountId(
  account: { id: string; dividendElection: DividendElection | null; defaultCashAccountId: string | null },
  isCashReceived: boolean,
): string {
  if (isCashReceived && account.dividendElection === "CASH" && account.defaultCashAccountId) {
    return account.defaultCashAccountId;
  }
  return account.id;
}

/** Select for `defaultDepositAccountId`'s account argument. */
export const DEPOSIT_DEFAULT_SELECT = { id: true, dividendElection: true, defaultCashAccountId: true } as const;
