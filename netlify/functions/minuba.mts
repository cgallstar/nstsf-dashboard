const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const env = (name) => Netlify.env.get(name) || "";

const paths = {
  cases: "/cases",
  clients: "/clients",
  time: "/time",
  materials: "/materials",
  invoices: "/invoices",
};

async function callMinuba(path) {
  const baseUrl = env("MINUBA_API_BASE_URL").replace(/\/$/, "");
  const apiKey = env("MINUBA_API_KEY");
  const authKey = env("MINUBA_AUTH_KEY");

  if (!baseUrl || !apiKey || !authKey) {
    return json({
      ok: false,
      error: "missing_env",
      missing: [
        !baseUrl && "MINUBA_API_BASE_URL",
        !apiKey && "MINUBA_API_KEY",
        !authKey && "MINUBA_AUTH_KEY",
      ].filter(Boolean),
    }, 503);
  }

  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "accept": "application/json",
      "authorization": `Bearer ${authKey}`,
      "x-api-key": apiKey,
      "x-auth-key": authKey,
    },
  });

  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  return json({
    ok: response.ok,
    status: response.status,
    resource: path,
    data: body,
  }, response.ok ? 200 : 502);
}

async function callFilApiExport() {
  const exportUrl = env("MINUBA_FILAPI_EXPORT_URL");
  const key = env("MINUBA_FILAPI_KEY");

  if (!exportUrl || !key) {
    return json({
      ok: false,
      error: "missing_env",
      missing: [
        !exportUrl && "MINUBA_FILAPI_EXPORT_URL",
        !key && "MINUBA_FILAPI_KEY",
      ].filter(Boolean),
    }, 503);
  }

  const response = await fetch(exportUrl, {
    headers: {
      "accept": "text/csv, application/zip, application/json, */*",
      "authorization": `Bearer ${key}`,
      "x-api-key": key,
    },
  });

  const text = await response.text();
  return json({
    ok: response.ok,
    status: response.status,
    bytes: text.length,
    preview: text.slice(0, 2000),
  }, response.ok ? 200 : 502);
}

export default async (request) => {
  const url = new URL(request.url);
  const resource = url.searchParams.get("resource") || "status";

  if (resource === "status") {
    return json({
      ok: true,
      configured: {
        jsonApi: Boolean(env("MINUBA_API_BASE_URL") && env("MINUBA_API_KEY") && env("MINUBA_AUTH_KEY")),
        filApi: Boolean(env("MINUBA_FILAPI_EXPORT_URL") && env("MINUBA_FILAPI_KEY")),
      },
      resources: Object.keys(paths).concat("filapi"),
    });
  }

  if (resource === "filapi") {
    return callFilApiExport();
  }

  const path = paths[resource];
  if (!path) {
    return json({ ok: false, error: "unknown_resource", resource }, 400);
  }

  return callMinuba(path);
};

export const config = {
  path: "/api/minuba",
};
