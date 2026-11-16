export function money(cents: string | null) {
  if (cents === null) return '未填写价格';
  const digits = cents.padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
export function currentDate() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
