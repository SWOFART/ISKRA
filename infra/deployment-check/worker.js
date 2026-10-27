export default {
  fetch(request, env) {
    const headers = { "Cache-Control": "no-store" };

    if (request.method !== "GET") {
      return Response.json(
        { error: "METHOD_NOT_ALLOWED" },
        { status: 405, headers: { ...headers, Allow: "GET" } },
      );
    }

    if (new URL(request.url).pathname !== "/api/health") {
      return Response.json({ error: "NOT_FOUND" }, { status: 404, headers });
    }

    return Response.json(
      {
        ok: true,
        service: "iskra-deployment-check",
        applicationReady: false,
        release: env.RELEASE_SHA,
      },
      { headers },
    );
  },
};
