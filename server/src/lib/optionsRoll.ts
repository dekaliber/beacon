import type { Prisma, OptionsPosition } from "@prisma/client";

// The roll write path, shared by the Roll modal (POST /positions/:id/roll) and
// by confirming an imported roll draft. A roll closes `existing` as ROLLED and
// opens the replacement leg at the same instant, in the same roll chain.

export interface RollInput {
  closedAt: Date;
  closePremiumPerShare: number | null;
  feesClose: number | null;
  newPremiumPerShare: number;
  newStrikePrice: number;
  newExpirationDate: string; // YYYY-MM-DD
  newStockPriceAtOpen: number | null;
  newDeltaAtOpen: number | null;
  newDeltaAtOpenCapturedAt: Date | null;
  newFeesOpen: number | null;
  // Roll only N of the position's contracts, leaving the rest open. Omitted or
  // equal to the full size = roll the whole position.
  contracts?: number | null;
}

export interface RollOptions {
  // Use this existing row (an imported roll draft) as the new leg instead of
  // creating one, so its externalId and broker ids stay on the leg the broker
  // filled. The row is promoted out of draft and its staged fields are cleared.
  intoDraftId?: string;
  // Extra columns for a freshly created new leg (e.g. the broker ids when one
  // imported roll is spread over several positions). Ignored with intoDraftId.
  newLegExtra?: Partial<Prisma.OptionsPositionUncheckedCreateInput>;
}

export class RollError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const include = { ticker: true, group: true } as const;

export async function rollPosition(
  tx: Prisma.TransactionClient,
  userId: string,
  existing: OptionsPosition,
  input: RollInput,
  opts: RollOptions = {},
) {
  const rollContracts = input.contracts ?? null;
  const isPartial = rollContracts != null && rollContracts < existing.contracts;
  if (rollContracts != null && rollContracts > existing.contracts) {
    throw new RollError(409, "Cannot roll more contracts than the position holds.");
  }
  // A partial roll splits the position; like partial-close, that is incompatible
  // with a position that is already part of a roll chain (breaks chain stats).
  if (isPartial && existing.groupId) {
    throw new RollError(409, "Cannot partially roll a position that is already part of a roll chain.");
  }

  const closeAt = input.closedAt;
  const openAt = input.closedAt;
  const newExpiry = new Date(input.newExpirationDate + "T20:00:00.000Z");
  const newDeltaCapturedAt = input.newDeltaAtOpen != null ? input.newDeltaAtOpenCapturedAt : null;

  // Writes the replacement leg: a fresh row, or the imported draft promoted in place.
  const writeNewLeg = (data: Omit<Prisma.OptionsPositionUncheckedCreateInput, "userId">) =>
    opts.intoDraftId
      ? tx.optionsPosition.update({
          where: { id: opts.intoDraftId },
          data: {
            ...data,
            isDraft: false,
            stagedRollFromId: null,
            stagedBuybackPerShare: null,
            stagedFeesClose: null,
          },
          include,
        })
      : tx.optionsPosition.create({ data: { userId, ...opts.newLegExtra, ...data }, include });

  const newLegFields = {
    tickerId: existing.tickerId,
    optionType: existing.optionType,
    side: existing.side,
    strikePrice: input.newStrikePrice,
    expirationDate: newExpiry,
    openedAt: openAt,
    premiumPerShare: input.newPremiumPerShare,
    feesOpen: input.newFeesOpen ?? null,
    stockPriceAtOpen: input.newStockPriceAtOpen ?? null,
    deltaAtOpen: input.newDeltaAtOpen ?? null,
    deltaAtOpenCapturedAt: newDeltaCapturedAt,
    shareCostBasis: existing.shareCostBasis,
    assignedFromStrikePrice: existing.assignedFromStrikePrice,
    assignedFromExpirationDate: existing.assignedFromExpirationDate,
    investmentAccountId: existing.investmentAccountId,
  };

  if (isPartial) {
    const n = rollContracts!;
    // Fresh roll chain for the rolled-off slice. The original stays OPEN with the
    // remaining contracts and is NOT placed in the chain, so it can still be
    // partially closed/rolled later.
    const group = await tx.optionsPositionGroup.create({ data: { userId } });
    const splitGroupId = existing.splitGroupId ?? `split_${existing.id}`;

    // Reduce the original; stamp split group so the UI can relate the slices.
    await tx.optionsPosition.update({
      where: { id: existing.id },
      data: { contracts: existing.contracts - n, splitGroupId },
    });

    // Spin off the rolled-closed leg (seq 1). All open fees stay on the original.
    const closed = await tx.optionsPosition.create({
      data: {
        userId,
        tickerId: existing.tickerId,
        groupId: group.id,
        sequenceInGroup: 1,
        splitGroupId,
        optionType: existing.optionType,
        side: existing.side,
        strikePrice: existing.strikePrice,
        expirationDate: existing.expirationDate,
        openedAt: existing.openedAt,
        contracts: n,
        premiumPerShare: existing.premiumPerShare,
        feesOpen: null,
        shareCostBasis: existing.shareCostBasis,
        stockPriceAtOpen: existing.stockPriceAtOpen,
        assignedFromStrikePrice: existing.assignedFromStrikePrice,
        assignedFromExpirationDate: existing.assignedFromExpirationDate,
        investmentAccountId: existing.investmentAccountId,
        status: "CLOSED",
        outcome: "ROLLED",
        closedAt: closeAt,
        closePremiumPerShare: input.closePremiumPerShare ?? null,
        feesClose: input.feesClose ?? null,
      },
      include,
    });

    // Open the replacement leg (seq 2) for the same N contracts.
    const opened = await writeNewLeg({
      ...newLegFields,
      groupId: group.id,
      sequenceInGroup: 2,
      contracts: n,
    });

    return { closed, opened };
  }

  // ── Full roll ──────────────────────────────────────────────────────────────
  // Determine group: reuse existing or create a new one
  let groupId = existing.groupId;
  if (!groupId) {
    const group = await tx.optionsPositionGroup.create({ data: { userId } });
    groupId = group.id;
    // Assign the original position to the group as sequence 1
    await tx.optionsPosition.update({
      where: { id: existing.id },
      data: { groupId, sequenceInGroup: 1 },
    });
  }

  // Find next sequence number
  const maxSeq = await tx.optionsPosition.aggregate({
    where: { groupId, isActive: true },
    _max: { sequenceInGroup: true },
  });
  const nextSeq = (maxSeq._max.sequenceInGroup ?? 1) + 1;

  // Close the existing position
  const closed = await tx.optionsPosition.update({
    where: { id: existing.id },
    data: {
      status: "CLOSED",
      outcome: "ROLLED",
      closedAt: closeAt,
      closePremiumPerShare: input.closePremiumPerShare ?? null,
      feesClose: input.feesClose ?? null,
    },
    include,
  });

  // Open the new position
  const opened = await writeNewLeg({
    ...newLegFields,
    groupId,
    sequenceInGroup: nextSeq,
    contracts: existing.contracts,
  });

  return { closed, opened };
}
