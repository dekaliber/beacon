import { useEffect, useState } from "react";
import type { Account, Income } from "@/types";
import { toDateInputValue } from "@/lib/utils";

// ── Income origin vs. deposit ──────────────────────────────────────────────────
// `accountId`/`date` say where income originated and when it was earned;
// `depositAccountId`/`depositDate` say where the cash landed and when. Rows from
// before the deposit fields existed have them null: same as the origin.

/** Account the cash landed in. */
export const landingAccount = (i: Income): Account => i.depositAccount ?? i.account;

/** YYYY-MM-DD the cash landed. */
export const landingDate = (i: Income): string => toDateInputValue(i.depositDate ?? i.date);

/** True when the income was deposited somewhere other than where it originated. */
export const depositedElsewhere = (i: Income): boolean => landingAccount(i).id !== i.account.id;

/**
 * Where income earned in an account lands by default: an investment account
 * that pays as cash sends it to its cash destination; anything else keeps it.
 */
export function defaultDepositAccountId(account: Account | undefined, fallbackId: string): string {
  if (account?.type === "INVESTMENT" && account.dividendElection === "CASH" && account.defaultCashAccountId) {
    return account.defaultCashAccountId;
  }
  return account?.id ?? fallbackId;
}

/**
 * Form state for an income's origin and deposit. The deposit account and date
 * follow the origin until the user sets them; editing a row whose deposit
 * already differs leaves it alone.
 */
export function useIncomeDepositFields(open: boolean, income: Income | null, accounts: Account[]) {
  const [accountId, setAccountIdRaw] = useState("");
  const [date, setDateRaw] = useState("");
  const [depositAccountId, setDepositAccountIdRaw] = useState("");
  const [depositDate, setDepositDateRaw] = useState("");
  const [accountLinked, setAccountLinked] = useState(true);
  const [dateLinked, setDateLinked] = useState(true);

  useEffect(() => {
    if (!open) return;
    const origin = income?.accountId ?? "";
    const earned = toDateInputValue(income?.date);
    const landedIn = income ? landingAccount(income).id : "";
    const landedOn = income ? landingDate(income) : earned;
    setAccountIdRaw(origin);
    setDateRaw(earned);
    setDepositAccountIdRaw(landedIn);
    setDepositDateRaw(landedOn);
    setAccountLinked(!income || landedIn === origin);
    setDateLinked(landedOn === earned);
  }, [open, income]);

  const setAccountId = (id: string) => {
    setAccountIdRaw(id);
    if (accountLinked) setDepositAccountIdRaw(defaultDepositAccountId(accounts.find((a) => a.id === id), id));
  };
  const setDate = (d: string) => {
    setDateRaw(d);
    if (dateLinked) setDepositDateRaw(d);
  };
  const setDepositAccountId = (id: string) => {
    setDepositAccountIdRaw(id);
    setAccountLinked(false);
  };
  const setDepositDate = (d: string) => {
    setDepositDateRaw(d);
    setDateLinked(d === date);
  };

  return {
    accountId, setAccountId, date, setDate,
    depositAccountId, setDepositAccountId, depositDate, setDepositDate,
    /** Fields for the create/update payload; empty deposit values fall back to the origin. */
    depositPayload: () => ({
      depositAccountId: depositAccountId || accountId,
      depositDate: depositDate || date,
    }),
  };
}
