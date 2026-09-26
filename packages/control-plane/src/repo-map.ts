import fs from "node:fs";
import path from "node:path";

const STOP = new Set(
  "about above after again against also allow allows because been before being below between both cannot could does doing down during each existing feature features from further have having here into issue issues itself just like make makes more most must need needs only other over own same should some such than that their them then there these they this those through under until very were what when where which while will with would your easy hard summary problem statement proposed solution benefits additional context implementation implement include following change changes code repository resolve github backend frontend test tests prove fix add adds added new currently users user without better support option".split(
    " ",
  ),
);
const SKIP = /\.(png|jpe?g|gif|svg|ico|webp|mp4|webm|mov|woff2?|ttf|otf|eot|pdf|zip|gz|lock|map)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|LICENSE)$|(^|\/)\.github\//i;

/** Weighted search terms from a ticket: title words count three times as much as description words. */
export function ticketKeywords(title: string, description: string, exclude: string[] = [], words = new Map<string, string>()): Map<string, number> {
  const excluded = new Set(exclude.flatMap((item) => item.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean));
  const weights = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const word of text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []) {
      if (STOP.has(word) || excluded.has(word)) continue;
      // A short stem matches the word's other forms: duplication, duplicate, duplicated.
      const stem = word.length >= 8 ? word.slice(0, 6) : word.replace(/(ing|ed|es|s)$/, "") || word;
      if (stem.length < 4) continue;
      weights.set(stem, Math.min((weights.get(stem) ?? 0) + weight, 6));
      if (!words.has(stem)) words.set(stem, word);
    }
  };
  add(title, 3);
  add(description.slice(0, 4000), 1);
  return weights;
}

/**
 * The tracked files most related to a ticket, for the build prompt of an existing repository: a model that searches
 * with bare words (a glob for "workflow") finds nothing and spends its run exploring. Path matches weigh most, then
 * content matches. Returns null when nothing matches.
 */
export function repositoryMap(worktree: string, trackedFiles: string[], title: string, description: string, exclude: string[] = [], limit = 25): string | null {
  const words = new Map<string, string>();
  const keywords = ticketKeywords(title, description, exclude, words);
  if (keywords.size === 0) return null;
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of trackedFiles) {
    if (SKIP.test(file)) continue;
    const lowerPath = file.toLowerCase();
    let content = "";
    try {
      const absolute = path.join(worktree, file);
      if (fs.statSync(absolute).size <= 200_000) content = fs.readFileSync(absolute, "utf8").toLowerCase();
    } catch {
      continue;
    }
    let score = 0;
    for (const [stem, weight] of keywords) {
      if (lowerPath.includes(stem)) score += 4 * weight;
      let count = 0;
      for (let at = content.indexOf(stem); at >= 0 && count < 10; at = content.indexOf(stem, at + stem.length)) count += 1;
      score += (weight * count) / 5;
    }
    if (/\.(md|txt|json|sql)$/i.test(file)) score /= 3;
    if (score >= 2) scored.push({ file, score });
  }
  if (scored.length === 0) return null;
  const top = scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, limit).map((item) => item.file).sort();
  const strongest = [...keywords.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const example = (strongest && words.get(strongest)) ?? "name";
  const isTest = (file: string) => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
  return [
    `Files in this repository most related to the ticket (a keyword search of tracked files; start by reading these):`,
    ...top.filter((file) => !isTest(file)).map((file) => `- ${file}`),
    ...(top.some(isTest) ? ["Related tests:", ...top.filter(isTest).map((file) => `- ${file}`)] : []),
    `To search further, use grep on file contents (for example \`grep -rlni "${example}" --exclude-dir=node_modules .\`). The glob tool matches file names only and needs wildcards such as **/*name*.`,
  ].join("\n");
}
