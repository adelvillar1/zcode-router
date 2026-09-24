/* zcode-workflow
description: "Runs a task as a multi-agent swarm with router-decided topology:
  the auto-router decides single vs mixture vs swarm, the swarm path decomposes
  the task, builds parts in parallel with per-part reviewers and a bounded fix
  loop, integrates one deliverable, and gives it an independent read before
  handover. Fails loudly when no task is provided. Subagents run on the router's
  auto model, so every delegation call routes by workload."
whenToUse: When a task is large, hard, or important enough to deserve
  multi-agent execution — parallel builders, independent review, and an
  integrated deliverable — and you want the router to decide whether it needs
  the full swarm or one focused worker.
args:
  task:
    type: string
    description: The task the swarm should execute end to end.
    required: true
*/
/**
 * Swarm: multi-agent task execution with router-decided topology.
 *
 * The auto-router (127.0.0.1:8300) decides the execution style first —
 * single / mixture / swarm. Single and mixture get one focused worker;
 * swarm gets the full pipeline: decompose, split the big parts further,
 * build every part in parallel with its own reviewer and a bounded fix
 * loop, integrate, then give the finished deliverable to a reader who has
 * seen nothing else before handing it over.
 *
 * Workers run on the router's `auto` model, so every subagent call routes
 * by workload — the router chooses both the topology and the models.
 */

interface Subtask {
  /** Short id for the part, like "1" or "2a". */
  id: string;
  /** One or two sentences: what this part of the work must produce. */
  description: string;
  /** Short human label for dashboards and reports. */
  title: string;
  /** True when this part is itself large enough to split further. */
  needsSplit: boolean;
}

interface Decomposition {
  subtasks: Subtask[];
}

interface WorkProduct {
  /** Paths of files written or changed, or "answer" when the product is prose only. */
  location: string;
  /** Two or three sentences: what was produced and the key decisions taken. */
  summary: string;
  /** Workspace-relative path of the file written, when this part produced one. */
  artifactPath: string | null;
}

interface Review {
  /** "accept" when the work is done; "revise" when specific fixes are needed. */
  verdict: "accept" | "revise";
  /** Concrete fix requests, one sentence each; empty when accepting. */
  fixes: string[];
  /** What is missing or would break — things the author did not see. */
  risks: string[];
}

interface Integrated {
  /** Workspace-relative path of the integrated deliverable that was written. */
  deliverablePath: string;
  /** Two or three sentences on what the deliverable concludes. */
  summary: string;
}

interface ReaderNotes {
  /** Points where the deliverable is unclear, unsupported, or incomplete. */
  issues: string[];
}

interface Finding {
  /** Workspace-relative path, or the part id the finding belongs to. */
  where: string;
  /** One sentence: what is wrong, or what was found. */
  what: string;
  /** What showed it: the review note, the lines read, or the command output. */
  evidence: string;
  /** "verified" when an independent reviewer confirmed it; "unconfirmed" otherwise. */
  status: "verified" | "unconfirmed";
  /** How much it matters. "high" only for data loss, a crash, or a wrong result. */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** Two or three sentences answering what the user asked for. */
  conclusion: string;
  findings: Finding[];
  /** What the run checked and how. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

interface BuiltPart {
  subtask: Subtask;
  product: WorkProduct;
  /** Risks the reviewer raised that the last revision did not resolve. */
  openRisks: string[];
  /** True when the final review accepted the work. */
  accepted: boolean;
}

const task = String(args.task ?? "").trim();
if (!task) {
  throw new Error("swarm: no task provided — the run needs args.task with the task to execute");
}

artifact.board("tasks", {
  title: "Parts of the work",
  key: "id",
  status: "stage",
  columns: ["building", "revise-requested", "accepted"],
  cardTitle: "title",
  detail: [{ field: "summary" }],
});

const findings: Finding[] = [];
const verified: string[] = [];
const notCovered: string[] = [];

phase("Ask the auto-router how this task should be executed");
let execution = "swarm";
let routerNote = "router unavailable — ran the full swarm";
try {
  const verdict = await world.run("curl", [
    "-s",
    "--max-time",
    "30",
    "-X",
    "POST",
    "http://127.0.0.1:8300/route",
    "-H",
    "Authorization: Bearer local-auto-router",
    "-H",
    "Content-Type: application/json",
    "-d",
    JSON.stringify({ task }),
  ]);
  if (verdict.exitCode === 0) {
    const parsed = JSON.parse(verdict.stdout) as { execution?: string; workload?: string };
    if (parsed.execution === "single" || parsed.execution === "mixture" || parsed.execution === "swarm") {
      execution = parsed.execution;
      routerNote = `router verdict: ${parsed.execution} for a ${parsed.workload ?? "unknown"} workload`;
    }
  } else {
    routerNote = `router returned exit ${verdict.exitCode} — ran the full swarm`;
  }
} catch {
  routerNote = "router unreachable — ran the full swarm";
}
log(routerNote);

if (execution !== "swarm") {
  phase("Handle the task with one focused worker");
  const worker = agent("Worker", {
    system:
      "You are a senior engineer completing one task end to end. " +
      "Produce finished, expert-level work, not a draft. " +
      "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
  });
  const product = await worker.ask<WorkProduct>(
    `Complete this task in ${task}\n\n` +
      "Write the finished deliverable to out/swarm/deliverable.md (and any other files under out/swarm/). " +
      "Return location, summary, and artifactPath."
  );
  report(
    { id: "task", title: "The task", stage: "accepted", summary: product.summary },
    "tasks"
  );
  notCovered.push(
    execution === "mixture"
      ? "multi-model comparison: run the router's `mixture` model for parallel answers judged against each other"
      : "nothing beyond the single worker's own review of its work"
  );
  verified.push("one focused worker completed the task and reported what it produced");
  try {
    await artifact.file("deliverable", "out/swarm/deliverable.md", {
      title: "Deliverable",
      description: `The integrated answer to the task: ${task.slice(0, 150)}`,
      primary: true,
    });
  } catch {
    await worker.ask("Re-write your deliverable to out/swarm/deliverable.md — the file is missing.");
    await artifact.file("deliverable", "out/swarm/deliverable.md", {
      title: "Deliverable",
      description: `The integrated answer to the task: ${task.slice(0, 150)}`,
      primary: true,
    });
  }
  const single: WorkflowReport = {
    conclusion: `${routerNote}. One worker completed the task: ${product.summary}`,
    findings,
    verified,
    notCovered,
  };
  return single;
}

phase("Break the task into independent parts");
const planner = agent("Planner", {
  system:
    "You split a task into 3 to 7 substantial, independent parts that different " +
    "people could build in parallel without stepping on each other. Each part must " +
    "have a clear, checkable outcome. Prefer fewer, substantial parts over many thin ones. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const decomposition = await planner.ask<Decomposition>(
  `Split this task into independent parts:\n\n${task}\n\n` +
    "Set needsSplit to true only for a part that is itself too large for one person to do well in one sitting."
);
log(`Split into ${decomposition.subtasks.length} parts`);

phase("Split any part that is still too large");
const expandedGroups = await Promise.all(
  decomposition.subtasks.map(async (part) => {
    if (!part.needsSplit) return [part];
    const expander = agent(`Planner for part ${part.id}`, {
      system:
        "You split one large piece of work into 2 to 4 independent sub-parts with clear outcomes. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });
    const split = await expander.ask<Decomposition>(
      `Split this part of a larger task into independent sub-parts.\n\n` +
        `Larger task: ${task}\n\nPart to split: ${part.description}\n\n` +
        "Keep every sub-part inside the scope of its parent part. needsSplit is always false for your sub-parts."
    );
    return split.subtasks.map((child) => ({
      ...child,
      id: `${part.id}.${child.id}`,
      needsSplit: false,
    }));
  })
);
const parts = expandedGroups.flat();
log(`Building ${parts.length} parts in parallel`);

phase("Build each part in parallel, have it reviewed, and fix what the review finds");
const built = await Promise.all(
  parts.map(async (part): Promise<BuiltPart> => {
    const builder = agent(`Builder for part ${part.id}`, {
      system:
        "You are a senior engineer producing one part of a larger task. " +
        "Produce finished, expert-level work for your part only, and write files under out/swarm/. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });
    const reviewer = agent(`Reviewer for part ${part.id}`, {
      system:
        "You review one part of a larger task with fresh eyes. You never edit files. " +
        "Ask for failures, not approval: say what is missing, what would break, and what the author assumed. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });

    let product = await builder.ask<WorkProduct>(
      `Produce this part of a larger task.\n\nLarger task: ${task}\n\n` +
        `Your part: ${part.description}\n\n` +
        "Write any file you produce under out/swarm/ and report its path in artifactPath. " +
        "Return location, summary, and artifactPath."
    );

    let openRisks: string[] = [];
    let accepted = false;
    for (let round = 0; round < 2; round++) {
      const review = await reviewer.ask<Review>(
        `Review this work product for the part "${part.description}".\n\n` +
          `Work product summary: ${product.summary}\n` +
          `Files: ${product.artifactPath ?? product.location}\n\n` +
          "Read the files it produced before judging. What is missing? What would break? " +
          "Return verdict, fixes, and risks."
      );
      if (review.verdict === "accept") {
        accepted = true;
        openRisks = review.risks;
        break;
      }
      openRisks = [...review.fixes, ...review.risks];
      report(
        {
          id: part.id,
          title: part.title,
          stage: "revise-requested",
          summary: review.fixes[0] ?? review.risks[0] ?? "revisions requested",
        },
        "tasks"
      );
      product = await builder.ask<WorkProduct>(
        `The review did not pass. Address each comment and answer each risk:\n` +
          `${JSON.stringify({ fixes: review.fixes, risks: review.risks })}\n\n` +
          "Update the work and return location, summary, and artifactPath."
      );
    }

    report(
      {
        id: part.id,
        title: part.title,
        stage: accepted ? "accepted" : "revise-requested",
        summary: product.summary,
      },
      "tasks"
    );
    for (const risk of openRisks) {
      const finding: Finding = {
        where: `part ${part.id} (${part.title})`,
        what: risk,
        evidence: `raised by the independent reviewer of this part after ${accepted ? "acceptance" : "the last revision"}`,
        status: "unconfirmed",
        severity: "medium",
      };
      findings.push(finding);
      report(finding);
    }
    return { subtask: part, product, openRisks, accepted };
  })
);

phase("Integrate the parts into one deliverable");
const integrator = agent("Integrator", {
  system:
    "You integrate the finished parts of a task into one coherent deliverable. " +
    "Resolve contradictions in favor of what is correct, drop filler, and keep the " +
    "strongest content of each part. Write the integrated deliverable to out/swarm/deliverable.md. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const integrated = await integrator.ask<Integrated>(
  `Original task: ${task}\n\n` +
    `Parts and their work products:\n${JSON.stringify(
      built.map((b) => ({
        part: b.subtask.description,
        summary: b.product.summary,
        files: b.product.artifactPath ?? b.product.location,
        openRisks: b.openRisks,
      }))
    )}\n\n` +
    "Write the integrated deliverable to out/swarm/deliverable.md and return deliverablePath and summary."
);

phase("Have someone new read the deliverable before handing it over");
const reader = agent("Reader", {
  system:
    "You judge a deliverable as a reader would, from the text alone. You never verify " +
    "it against the repository and you never edit files. Say what is unclear, what the " +
    "text itself fails to support, and what the reader will ask next.",
});
const notes = await reader.ask<ReaderNotes>(
  `Read this deliverable and report what is unclear, unsupported, or missing:\n\n` +
    `Deliverable: ${integrated.deliverablePath}\n\nRead the file before judging. Return issues.`
);
if (notes.issues.length > 0) {
  log(`The reader raised ${notes.issues.length} issues; handing them back for a fix`);
  await integrator.ask(
    `A reader of ${integrated.deliverablePath} raised these issues. Fix the deliverable for each:\n` +
      `${JSON.stringify(notes.issues)}`
  );
  for (const issue of notes.issues) {
    const finding: Finding = {
      where: integrated.deliverablePath,
      what: issue,
      evidence: "raised by the independent reader of the deliverable",
      status: "unconfirmed",
      severity: "medium",
    };
    findings.push(finding);
    report(finding);
  }
}

const deliverablePath = integrated.deliverablePath || "out/swarm/deliverable.md";
  try {
    await artifact.file("deliverable", deliverablePath, {
      title: "Deliverable",
      description: `The integrated answer to the task: ${task.slice(0, 150)}`,
      primary: true,
    });
  } catch {
    const writer = agent("Deliverable writer", {
      system: "You write a missing deliverable file from the work products of a task.",
    });
    await writer.ask(
      `${deliverablePath} is missing. Write the integrated deliverable there for this task: ${task.slice(0, 400)}`
    );
    try {
      await artifact.file("deliverable", deliverablePath, {
        title: "Deliverable",
        description: `The integrated answer to the task: ${task.slice(0, 150)}`,
        primary: true,
      });
    } catch {
      await artifact.markdown(
        "deliverable-fallback",
        `# Deliverable\n\n${integrated.summary}\n\nThe integrated file could not be published from ${deliverablePath}.`,
        { title: "Deliverable (compact)" }
      );
    }
  }

const acceptedCount = built.filter((b) => b.accepted).length;
verified.push(
  `${acceptedCount} of ${built.length} parts were accepted by an independent reviewer`,
  "the integrated deliverable had an independent read before handover"
);
notCovered.push(
  "deeper verification than the reviewers' reads — no deterministic check gate applies to prose work products",
  ...(built.some((b) => !b.accepted)
    ? ["parts not accepted after the fix loop remain at risk — see the findings"]
    : [])
);

const reportOut: WorkflowReport = {
  conclusion:
    `${routerNote}. ${built.length} parts were built in parallel and reviewed; ` +
    `${acceptedCount} accepted outright. The integrated deliverable is at ` +
    `${integrated.deliverablePath}: ${integrated.summary}`,
  findings,
  verified,
  notCovered,
};
return reportOut;
