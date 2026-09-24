/* zcode-workflow
description: "Solves a problem with several plausible solutions by competition:
  champions build competing solutions independently (no peeking), a judge
  compares them head to head and names the winner's weaknesses and the elements
  worth adopting from the rest, and the winner is finalized with those elements
  folded in."
whenToUse: When a problem has several plausible solutions or approaches and the
  best answer should emerge from competing independent attempts rather than one
  opinion.
args:
  task:
    type: string
    description: The problem to solve, including any constraints the solutions must respect.
    required: true
*/
/**
 * adversarial-solve: solve a problem that has several plausible solutions by
 * competition. Champions build competing solutions independently — no
 * peeking at each other — then a judge compares them head to head, picks
 * the best, and names the elements worth taking from the rest.
 */

interface Approach {
  /** Short id like "1". */
  id: string;
  /** The solution approach's name. */
  name: string;
  /** Why this approach could win, one sentence. */
  rationale: string;
}

interface ApproachList {
  approaches: Approach[];
}

interface Solution {
  /** The approach this solution implements. */
  approach: string;
  /** The solution itself: the design, the fix, or the implementation summary. */
  solution: string;
  /** What was actually produced: file paths, or "answer" for a design-only solution. */
  location: string;
  /** The strongest reason this solution should win. */
  whyBest: string;
}

interface Judgment {
  /** The approach whose solution wins. */
  winner: string;
  /** Why it wins over the others, one or two sentences. */
  why: string;
  /** What would break the winning solution — the judge's own objections. */
  weaknesses: string[];
  /** Concrete elements from other solutions worth taking into the winner. */
  adopt: string[];
}

interface Final {
  /** Path of the finished solution write-up. */
  path: string;
  /** Two or three sentences on what the solution is. */
  summary: string;
}

interface Finding {
  where: string;
  what: string;
  evidence: string;
  status: "verified" | "unconfirmed";
  severity: "low" | "medium" | "high";
}

const task = String(args.task ?? "").trim() || "Solve the problem.";

phase("Name the competing approaches");
const strategist = agent("Strategist", {
  system:
    "You frame problems as solution competitions: name 2 to 4 genuinely different approaches " +
    "to the same problem — different mechanisms, not variations of one. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const approaches = await strategist.ask<ApproachList>(
  `Problem: ${task}\n\nName 2 to 4 genuinely different solution approaches. Return approaches with id, name, and rationale.`
);
log(`${approaches.approaches.length} champions are competing independently`);

phase("Build each solution in parallel, competing independently");
const solutions = await Promise.all(
  approaches.approaches.map(async (a) => {
    const champion = agent(`Champion for ${a.name}`, {
      system:
        "You are one champion in a solution competition. Solve the problem YOUR way, completely " +
        "and to the best of your ability — you never see the other entries. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });
    return champion.ask<Solution>(
      `Problem: ${task}\n\nYour assigned approach: ${a.name} — ${a.rationale}\n\n` +
        "Solve the problem your way. If your solution produces files, put them under out/adversarial/. " +
        "Return approach, solution, location, and whyBest."
    );
  })
);

phase("Judge the solutions head to head");
const judge = agent("Judge", {
  system:
    "You judge a solution competition head to head: pick the winner, say what would break it, " +
    "and name any concrete elements from the losing entries worth adopting. " +
    "Judge from the solutions as written — ask for failures, not approval. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const judgment = await judge.ask<Judgment>(
  `Problem: ${task}\n\nCompeting solutions:\n${JSON.stringify(solutions)}\n\n` +
    "Return winner, why, weaknesses, and adopt."
);

const findings: Finding[] = [];
for (const w of judgment.weaknesses) {
  const f: Finding = {
    where: `winning solution (${judgment.winner})`,
    what: w,
    evidence: "raised by the head-to-head judge reading the solutions as written",
    status: "unconfirmed",
    severity: "medium",
  };
  findings.push(f);
  report(f);
}
report({ winner: judgment.winner, why: judgment.why, adopted: judgment.adopt.length });

phase("Produce the winning solution");
const finisher = agent("Finisher", {
  system:
    "You finalize a winning solution: fold in the adopted elements from the other entries, " +
    "address the judge's stated weaknesses where they can be addressed, and write the finished " +
    "solution to out/adversarial/deliverable.md. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const final = await finisher.ask<Final>(
  `Problem: ${task}\n\nWinning solution: ${JSON.stringify(solutions.find((s) => s.approach === judgment.winner) ?? solutions[0])}\n` +
    `Judge's verdict: ${JSON.stringify(judgment)}\nAll entries: ${JSON.stringify(solutions)}\n\n` +
    "Write the finished solution to out/adversarial/deliverable.md, folding in the adopted elements " +
    "and addressing the weaknesses where possible. Return path and summary."
);

try {
  await artifact.file("deliverable", final.path, { title: "Winning solution", primary: true });
} catch {
  await finisher.ask(`Re-write the solution to ${final.path} — the file is missing.`);
  await artifact.file("deliverable", final.path, { title: "Winning solution", primary: true });
}

return {
  conclusion: `Winner: ${judgment.winner} — ${judgment.why} ${final.summary} Solution: ${final.path}.`,
  findings,
  verified: [
    `${solutions.length} independent solutions were built and compared head to head`,
    "the winner's weaknesses were named by the judge rather than hidden",
  ],
  notCovered: [
    "the losing entries are kept as analysis, not implemented",
    "judge weaknesses that the finisher could not address remain open — see the findings",
  ],
};
