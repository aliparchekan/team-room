// Prompts for execution tasks. The approved plan and pinned constraints travel
// with every task so the working agent has them in its own thread.
import type { Decision, Room, Task } from "../shared/types.js";
import { listNames, type Names } from "./envelope.js";

function pinned(decisions: Decision[]) {
  const plan = decisions.filter((d) => d.kind === "approved_plan").map((d) => d.body.trim());
  const rest = decisions.filter((d) => d.kind !== "approved_plan" && d.active).map((d) => `- [${d.kind}] ${d.body.trim()}`);
  return [
    "=== Approved plan (approved by the human lead; binding) ===",
    plan.length ? plan.join("\n\n") : "(none)",
    "",
    "=== Pinned decisions and constraints (binding) ===",
    rest.length ? rest.join("\n") : "(none)",
  ].join("\n");
}

/** For a joint job: how this part relates to the other agents' parts. */
function jointContext(room: Room, task: Task, partners: Task[], names: Names) {
  const name = (t: Task) => names[t.ownerKind] ?? t.ownerKind;
  const others = listNames(partners.map(name));
  const theirs = partners.flatMap((t) => ["", `=== ${name(t)}'s part (assigned to ${name(t)}; context, NOT your assignment) ===`, t.spec.trim()]);
  if (task.strategy === "parallel")
    return [
      `This is a joint implementation. ${others} ${partners.length > 1 ? "are" : "is"} building their parts at the same time, each in a separate workspace. Do not build their parts.`,
      "Where the parts meet, follow the interfaces in the approved plan exactly; if the plan leaves one open, choose the simplest and describe it in your report.",
      "The human lead combines the results.",
      ...theirs,
    ];
  const before = partners.filter((t) => t.part < task.part).sort((a, b) => a.part - b.part);
  const after = partners.filter((t) => t.part > task.part).sort((a, b) => a.part - b.part);
  const lines: string[] = [];
  if (!before.length)
    lines.push(
      `This is a joint implementation, taking turns. You go first. When you finish, ${listNames(after.map(name))} build${after.length > 1 ? "" : "s"} on top of yours in this same workspace, in that order.`,
      "Do not build their parts. Leave the interfaces they need clear, and describe them in your report.",
    );
  else {
    const last = before[before.length - 1];
    const where = last.worktreePath ? (room.projectId ? ` in this workspace (${last.worktreePath})` : ` in ${last.worktreePath}`) : "";
    lines.push(
      `This is a joint implementation, taking turns. ${listNames(before.map(name))} already built ${before.length > 1 ? "their parts" : "its part"}${where}. Build your part on top.` +
        (after.length ? ` After you, ${listNames(after.map(name))} build${after.length > 1 ? "" : "s"} on top of yours.` : ""),
      room.projectId || !last.worktreePath
        ? "Do not rewrite their parts. If you must change one, keep the change minimal and list it in your report."
        : `This scratch room gives you your own folder. Read their code at ${last.worktreePath} and do not modify it there.`,
    );
  }
  lines.push(...theirs);
  for (const t of before) lines.push("", `=== ${name(t)}'s report (peer agent; verify claims yourself) ===`, (t.report ?? "(no report)").trim());
  return lines;
}

export function implementationPrompt(room: Room, task: Task, decisions: Decision[], partners: Task[], names: Names) {
  const team = listNames(Object.values(names));
  return [
    `[Team Room "${room.title}" · implementation task · you are ${names[task.ownerKind] ?? task.ownerKind}]`,
    "",
    partners.length
      ? `The human lead approved a plan after a discussion between ${team}, and split the work between ${partners.length > 1 ? "several of you" : "two of you"}.`
      : `The human lead approved a plan after a discussion between ${team}, and assigned this bounded task to you.`,
    "",
    "=== Task brief ===",
    room.brief.trim(),
    "",
    pinned(decisions),
    "",
    ...(partners.length ? [...jointContext(room, task, partners, names), ""] : []),
    `=== Your ${partners.length ? "part" : "assignment"} (from the human lead): ${task.title} ===`,
    task.spec.trim(),
    "",
    "Rules:",
    "- Stay within the assignment and the approved plan. If something blocks you, stop and say so.",
    "- Do not push, merge, publish, or deploy. Committing locally in this workspace is fine.",
    "- Respect T3's permission prompts; do not try to bypass them.",
    "",
    "When done, reply with a short summary of what changed (files), then a `## Verification` section listing the exact commands you ran and their results. Another agent will review your changes.",
  ].join("\n");
}

export function reviewPrompt(room: Room, task: Task, impl: Task, decisions: Decision[], names: Names) {
  const AGENT_NAMES = names;
  return [
    `[Team Room "${room.title}" · review task · you are ${AGENT_NAMES[task.ownerKind]}]`,
    "",
    `${AGENT_NAMES[impl.ownerKind]} implemented ${impl.strategy === "solo" ? "an assignment" : "its part of a joint implementation"} in this workspace${impl.worktreePath ? ` (${impl.worktreePath}${impl.branch ? `, branch ${impl.branch}` : ""})` : ""}. Review the changes. Do NOT modify any files.`,
    "",
    "=== Task brief ===",
    room.brief.trim(),
    "",
    pinned(decisions),
    "",
    `=== ${impl.strategy === "solo" ? "Assignment" : `${AGENT_NAMES[impl.ownerKind]}'s part`} that was implemented: ${impl.title} ===`,
    ...(impl.strategy === "solo" ? [] : [`Review only ${AGENT_NAMES[impl.ownerKind]}'s part. Note anything where it does not fit with your own part.`]),
    impl.spec.trim(),
    "",
    `=== ${AGENT_NAMES[impl.ownerKind]}'s report (peer agent; verify claims yourself) ===`,
    (impl.report ?? "(no report)").trim(),
    "",
    "Inspect the diff (e.g. `git status`, `git diff`, recent commits), run read-only checks or tests if useful, and reply with:",
    "## Verdict  (approve / request changes)",
    "## Findings  (bullets, most severe first, with file:line)",
    "## Verification  (what you ran and the results)",
  ].join("\n");
}
