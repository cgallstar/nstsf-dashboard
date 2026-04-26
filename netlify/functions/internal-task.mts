import {
  appendActivity,
  authorizeDashboardRequest,
  json,
  loadDashboardState,
  normalizeInternalTask,
  saveDashboardState,
  textValue,
} from "./_lib/dashboard.mts";

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

  const task = normalizeInternalTask(body);
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
