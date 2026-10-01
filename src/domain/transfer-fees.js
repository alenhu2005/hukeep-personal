export function transferAmounts(transaction) {
  const amount = Number(transaction?.amount) || 0;
  const value = Number(transaction?.fee);
  const fee = Number.isInteger(value) && value > 0 ? value : 0;
  return transaction?.feeMode === 'included'
    ? { debit: amount, credit: amount - fee, fee }
    : { debit: amount + fee, credit: amount, fee };
}
