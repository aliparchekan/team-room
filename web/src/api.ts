import type { ReplyOrder, Room, RoomView, T3Status } from "../../shared/types";
import type { CreateResearchInput, Decision, ResearchLimits, ResearchRun, ResearchRunListItem, ResearchView } from "../../shared/research";

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-team-room": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export type RoomListItem = Room & {
  participants: { kind: string; name: string; status: string }[];
  /** Agents or tasks waiting for the human's approval or answer in T3. */
  waiting?: string[];
  /** Open questions the agents asked the human. */
  questions?: number;
  /** An implementation or review task is running. */
  tasksActive?: boolean;
};

export const api = {
  status: () => req<T3Status>("GET", "/api/status"),
  connect: () => req<T3Status>("POST", "/api/t3/connect"),
  refresh: () => req<T3Status>("POST", "/api/t3/refresh"),
  reauthorize: () => req<T3Status>("POST", "/api/t3/reauthorize"),
  openInT3: (link: string) => req<{ ok: boolean }>("POST", "/api/t3/open", { link }),
  rooms: () => req<RoomListItem[]>("GET", "/api/rooms"),
  createRoom: (b: unknown) => req<Room>("POST", "/api/rooms", b),
  room: (id: string) => req<RoomView>("GET", `/api/rooms/${id}`),
  patchRoom: (id: string, b: unknown) => req<RoomView>("PATCH", `/api/rooms/${id}`, b),
  post: (id: string, b: { body: string; target: string; pin?: string | null; order?: ReplyOrder }) => req("POST", `/api/rooms/${id}/messages`, b),
  ask: (id: string, target: string) => req("POST", `/api/rooms/${id}/ask`, { target }),
  action: (id: string, name: "auto/start" | "continue" | "pause" | "stop" | "resume") => req<RoomView>("POST", `/api/rooms/${id}/${name}`),
  pin: (id: string, kind: string, body: string) => req<RoomView>("POST", `/api/rooms/${id}/decisions`, { kind, body }),
  setDecisionActive: (roomId: string, decisionId: string, active: boolean) =>
    req("POST", `/api/decisions/${decisionId}/active`, { active, roomId }),
  approve: (id: string, body: string, sourceMessageId: string | null) => req<RoomView>("POST", `/api/rooms/${id}/approve`, { body, sourceMessageId }),
  agentModel: (id: string, kind: string, model: string) => req<RoomView>("POST", `/api/rooms/${id}/agents/${kind}/model`, { model }),
  agentOptions: (id: string, kind: string, options: Record<string, string | boolean>) => req<RoomView>("POST", `/api/rooms/${id}/agents/${kind}/options`, { options }),
  answerQuestions: (id: string, answers: { id: string; text: string }[]) => req<RoomView>("POST", `/api/rooms/${id}/questions/answer`, { answers }),
  dismissQuestion: (id: string, qid: string) => req<RoomView>("POST", `/api/rooms/${id}/questions/${qid}/dismiss`, {}),
  localDigest: (id: string, from: number, to: number) => req<RoomView>("POST", `/api/rooms/${id}/local-digest`, { from, to }),
  summarize: (id: string, b: { from: number; to: number; agent?: string | null }) => req<RoomView>("POST", `/api/rooms/${id}/summarize`, b),
  addAgent: (id: string, b: { providerInstanceId: string; model: string; options?: Record<string, string | boolean> }) => req<RoomView>("POST", `/api/rooms/${id}/agents`, b),
  removeAgent: (id: string, kind: string) => req<RoomView>("POST", `/api/rooms/${id}/agents/${kind}/remove`),
  transfer: (id: string, b: { mode: string; agents: string[]; handoff: boolean }) => req<RoomView>("POST", `/api/rooms/${id}/transfer`, b),
  startTask: (id: string, b: unknown) => req<RoomView>("POST", `/api/rooms/${id}/tasks`, b),
  acceptReview: (id: string, note: string) => req<RoomView>("POST", `/api/rooms/${id}/review/accept`, { note }),
  requestChanges: (id: string, note: string, taskId?: string) => req<RoomView>("POST", `/api/rooms/${id}/review/changes`, { note, taskId }),
  // AutoResearch
  researchRuns: () => req<ResearchRunListItem[]>("GET", "/api/research"),
  createResearch: (b: CreateResearchInput) => req<ResearchRun>("POST", "/api/research", b),
  research: (id: string) => req<ResearchView>("GET", `/api/research/${id}`),
  researchAction: (id: string, action: "start" | "pause" | "resume" | "stop") => req<ResearchView>("POST", `/api/research/${id}/${action}`),
  researchLimits: (id: string, limits: Partial<ResearchLimits>) => req<ResearchView>("PATCH", `/api/research/${id}/limits`, limits),
  researchSuggest: (id: string, b: { hypothesis: string; parentSeq?: number | null; approach?: string }) => req<ResearchView>("POST", `/api/research/${id}/suggest`, b),
  researchPin: (id: string, expId: string, pinned: boolean) => req<ResearchView>("POST", `/api/research/${id}/experiments/${expId}/pin`, { pinned }),
  researchReject: (id: string, expId: string) => req<ResearchView>("POST", `/api/research/${id}/experiments/${expId}/reject`, {}),
  researchDecide: (id: string, expId: string, decision: Decision, note: string) => req<ResearchView>("POST", `/api/research/${id}/experiments/${expId}/decide`, { decision, note }),
  researchReport: async (id: string) => {
    const res = await fetch(`/api/research/${id}/report.md`);
    if (!res.ok) throw new Error(`Report failed: ${res.status}`);
    return res.text();
  },
};
