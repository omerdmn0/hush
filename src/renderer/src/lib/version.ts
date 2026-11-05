/** True if version `a` is newer than `b` ("0.10.0" > "0.9.3"). Pre-release tags are ignored. */
export function isNewer(a: string, b: string): boolean {
  const parts = (v: string): number[] => v.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}
