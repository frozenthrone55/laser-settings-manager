import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore({
    name: "laser-settings",
    consistency: "strong"
  });

  const testData = {
    ok: true,
    message: "Netlify Blobs werkt",
    createdAt: new Date().toISOString()
  };

  await store.setJSON("connection-test", testData);

  const saved = await store.get("connection-test", {
    type: "json",
    consistency: "strong"
  });

  return Response.json({
    success: true,
    saved
  });
};

export const config = {
  path: "/api/blob-test"
};
