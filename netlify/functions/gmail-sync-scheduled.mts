import { json, textValue } from "./_lib/dashboard.mts";

function env(name: string) {
  return textValue(Netlify.env.get(name), "");
}

export default async (_request: Request) => {
  const token = env("GPT_ACTIONS_TOKEN");
  const siteUrl = env("URL") || env("DEPLOY_PRIME_URL");
  if (!token) {
    return json({
      ok: false,
      error: "missing_GPT_ACTIONS_TOKEN",
      note: "Scheduled Gmail-sync kræver GPT_ACTIONS_TOKEN, så den kan kalde /api/gmail-sync uden browser-cookie.",
    }, 500);
  }
  if (!siteUrl) {
    return json({
      ok: false,
      error: "missing_site_url",
      note: "Scheduled Gmail-sync kræver Netlify URL eller DEPLOY_PRIME_URL.",
    }, 500);
  }

  const response = await fetch(`${siteUrl.replace(/\/$/, "")}/api/gmail-sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-actor-name": "Morgen-sync",
      "x-actor-email": "system@nstsf.dk",
    },
    body: JSON.stringify({ trigger: "scheduled_morning" }),
  });
  const data = await response.json().catch(() => ({}));
  return json({
    ok: response.ok,
    status: response.status,
    data,
  }, response.ok ? 200 : 500);
};

export const config = {
  schedule: "0 4 * * *",
  maxDuration: 26,
};
