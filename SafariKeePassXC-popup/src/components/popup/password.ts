export type GenOpts = { length: number; upper: boolean; lower: boolean; digits: boolean; symbols: boolean; phrase: boolean };
const words = ["glacier","sail","coffee","orbit","beacon","north","key","fog","amber","cedar","wave","dawn"];

export function generate(o: GenOpts): string {
  const rnd = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0]! % n;
  if (o.phrase) {
    const count = Math.max(3, Math.round(o.length / 6));
    return Array.from({ length: count }, () => words[rnd(words.length)]).join("-");
  }
  let set = "";
  if (o.upper) set += "ABCDEFGHJKLMNPQRSTUVWXYZ";
  if (o.lower) set += "abcdefghijkmnopqrstuvwxyz";
  if (o.digits) set += "23456789";
  if (o.symbols) set += "!@#$%^&*-_=+?";
  if (!set) set = "abcdefghijkmnopqrstuvwxyz";
  return Array.from({ length: o.length }, () => set[rnd(set.length)]).join("");
}

export function strength(o: GenOpts): { score: number; label: string } {
  let pool = o.phrase ? 12 ** (1 / 6) : 0;
  if (!o.phrase) pool = (o.upper ? 24 : 0) + (o.lower ? 25 : 0) + (o.digits ? 8 : 0) + (o.symbols ? 13 : 0) || 25;
  const bits = o.phrase ? Math.max(3, Math.round(o.length / 6)) * Math.log2(12) * 3 : o.length * Math.log2(pool);
  if (bits < 50) return { score: 1, label: "Weak" };
  if (bits < 80) return { score: 2, label: "Medium" };
  if (bits < 110) return { score: 3, label: "Strong" };
  return { score: 4, label: "Very strong" };
}
