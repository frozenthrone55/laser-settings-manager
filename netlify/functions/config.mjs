function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default async (request) => {
  if (request.method !== "GET") {
    return json({ success: false, error: "Methode niet toegestaan." }, 405);
  }

  const publishableKey = String(process.env.CLERK_PUBLISHABLE_KEY || "").trim();

  if (!publishableKey.startsWith("pk_")) {
    return json(
      { success: false, error: "Clerk Publishable Key ontbreekt in Netlify." },
      500
    );
  }

  // Publishable keys zijn bewust publiek. De Secret Key wordt hier nooit
  // teruggegeven of in de frontend geplaatst.
  return json({
    success: true,
    publishableKey,
  });
};

export const config = {
  path: "/api/config",
};
