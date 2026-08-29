const MAX_ABSOLUTE_OPENING_BALANCE = 1_000_000_000_000;

export function updateOpeningBalances(accounts, values) {
  if (!Array.isArray(accounts) || !accounts.length) {
    throw new Error('找不到可設定的帳戶');
  }

  return accounts.map(account => {
    const rawValue = values?.[account.id];
    const amount = rawValue === '' || rawValue == null ? Number.NaN : Number(rawValue);
    if (
      !Number.isSafeInteger(amount) ||
      Math.abs(amount) > MAX_ABSOLUTE_OPENING_BALANCE
    ) {
      throw new Error(`${account.name}初始金額必須是±1 兆以內的整數`);
    }
    return { ...account, openingBalance: amount };
  });
}
