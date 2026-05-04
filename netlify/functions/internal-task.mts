import {
  appendActivity,
  authorizeDashboardRequest,
  json,
  loadDashboardState,
  normalizeInternalTask,
  saveDashboardState,
  textValue,
} from "./_lib/dashboard.mts";

function stableThreeDigitHash(value = "") {
  let hash = 0;
  for (const char of String(value || "")) hash = ((hash * 31) + char.charCodeAt(0)) % 900;
  return String(100 + hash).padStart(3, "0").slice(-3);
}

export default async (request: Request) => {
  const auth = authorizeDashboardRequest(request, { allowActionsToken: true });
  if (!auth.ok) return auth.response;

  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const state = await loadDashboardState();
  if (!state) return json({ ok: false, error: "no_state" }, 404);

  state.internalTasks = Array.isArray(state.internalTasks) ? state.internalTasks : [];
  const actor = {
    ...auth.actor,
    name: textValue(body.actorName, auth.actor?.name || "Custom GPT"),
    email: textValue(body.actorEmail, auth.actor?.email || ""),
  };

  const task = normalizeInternalTask({
    ...body,
    unlinkedRef: textValue(body.unlinkedRef, `S-${stableThreeDigitHash(`${body.title || body.name || ""}|${Date.now()}`)}`),
  });
  state.internalTasks.unshift(task);
  state.internalTaskActivity = Array.isArray(state.internalTaskActivity) ? state.internalTaskActivity : [];
  state.internalTaskActivity.unshift({
    id: task.id,
    createdAt: task.createdAt,
    actor,
    type: "internal_task",
    title: task.title,
    notes: task.notes,
    dueDate: task.dueDate,
    bucket: task.bucket,
    domain: task.domain,
    owner: task.owner,
  });

  const savedAt = await saveDashboardState(state);

  return json({
    ok: true,
    savedAt,
    task,
    note: "Intern opgave er gemt og lagt i Sager.",
  });
};

export const config = {
  path: "/api/internal-task",
};
