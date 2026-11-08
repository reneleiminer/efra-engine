// Versioned inputs use UTC timestamps with millisecond precision.
export function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : Number.NaN;
}
