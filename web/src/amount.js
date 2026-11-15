export function parseAmount(text) {
  if (!/^\d+(\.\d{1,8})?$/.test(text)) throw new Error('Enter a positive amount with at most 8 decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const amount = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
  if (amount > 2100000000000000n) throw new Error('Amount exceeds the network limit.');
  return amount.toString();
}
export function formatAmount(satoshis = '0') {
  const n = BigInt(satoshis);
  return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, '0')}`;
}
