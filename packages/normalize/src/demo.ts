/**
 * Proof that the fuzzy key does what the search box needs.
 * Run: node packages/normalize/src/demo.ts
 *
 * Each block is one name as it would sit in the database (Devanagari, from the
 * PDF) followed by the spellings a user might actually type. A row passes when
 * the typed spelling folds to the same key as the stored name.
 */
import { nameForms, queryForms, similarity } from "./index.ts";

const CASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["\u0930\u093E\u092E\u0947\u0936\u094D\u0935\u0930 \u0932\u093E\u0932", ["Rameshwar Lal", "Rameshvar Lal", "Ramesvar Laal", "rameshwer lal", "\u0930\u093E\u092E\u0947\u0936\u094D\u0935\u0930 \u0932\u093E\u0932"]],
  ["\u0938\u0941\u0930\u0947\u0928\u094D\u0926\u094D\u0930 \u0938\u093F\u0902\u0939", ["Surendra Singh", "Surender Singh", "Surendar Sinh", "surendra sing"]],
  ["\u0905\u0928\u0940\u0924\u093E \u0926\u0947\u0935\u0940", ["Anita Devi", "Aneeta Devi", "Anitha Devy", "aneetha dewi"]],
  ["\u092D\u0901\u0935\u0930 \u0932\u093E\u0932", ["Bhanwar Lal", "Bhanvar Lal", "Banwar Laal", "bhanwarlal"]],
  ["\u092E\u094B\u0939\u092E\u094D\u092E\u0926 \u0907\u0915\u092C\u093E\u0932", ["Mohammad Iqbal", "Mohmmad Ikbal", "Muhammad Iqbaal"]],
  ["\u0913\u092E \u092A\u094D\u0930\u0915\u093E\u0936 \u0936\u0930\u094D\u092E\u093E", ["Om Prakash Sharma", "Om Prakas Sarma", "om prkash sharma"]],
  ["\u0915\u0948\u0932\u093E\u0936 \u091A\u0928\u094D\u0926\u094D\u0930", ["Kailash Chandra", "Kailas Chander", "Kelash Chandr"]],
  ["\u091B\u0917\u0928 \u0932\u093E\u0932", ["Chhagan Lal", "Chagan Lal", "Chhaganlal"]],
  ["\u0938\u0924\u094D\u092F\u0928\u093E\u0930\u093E\u092F\u0923", ["Satyanarayan", "Satya Narayan", "Sathyanarayana"]],
  ["\u092A\u0942\u0928\u092E \u0915\u0901\u0935\u0930", ["Poonam Kanwar", "Punam Kanvar", "Poonam Kunwar"]],
  ["जवाहर लाल", ["Jawahar Lal", "Javahar Lal", "Jawaharlal"]],
  ["विजय कुमार", ["Vijay Kumar", "Vijai Kumar", "Bijay Kumaar"]],
  ["चौधरी मूलचंद", ["Chaudhari Moolchand", "Chowdhary Mulchand", "Choudhri Mool Chand"]],
  ["गणेश स्वामी", ["Ganesh Swami", "Ganes Svami", "Ganesh Saami"]],
];

let exact = 0;
let near = 0;
let miss = 0;

for (const [stored, typed] of CASES) {
  const s = nameForms(stored);
  console.log(`\n${s.hi}`);
  console.log(`  latin=${s.latin}  key=${s.key}  skeleton=${s.skeleton}`);
  for (const t of typed) {
    const q = queryForms(t);
    const sim = similarity(q.key, s.key);
    const skelHit = q.skeleton === s.skeleton;
    let mark: string;
    if (q.key === s.key) {
      mark = "EXACT KEY ";
      exact++;
    } else if (sim >= 0.45 || skelHit) {
      mark = "fuzzy hit ";
      near++;
    } else {
      mark = "MISS      ";
      miss++;
    }
    console.log(
      `    ${mark} "${t}"  ->  key=${q.key}  sim=${sim.toFixed(2)}${skelHit && q.key !== s.key ? "  (skeleton match)" : ""}`,
    );
  }
}

const total = exact + near + miss;
console.log(
  `\n=== ${total} spellings: ${exact} land on the identical key, ${near} match fuzzily, ${miss} missed ===`,
);
