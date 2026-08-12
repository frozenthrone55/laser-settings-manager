import { getStore } from "@netlify/blobs";
import { createClerkClient } from "@clerk/backend";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
});

const store = getStore({
  name: "laser-settings",
  consistency: "strong",
});

const AUTHORIZED_PARTIES = [
  "https://laser-settings-manager.netlify.app",
];

const SETTING_FIELDS = [
  "materiaal",
  "bewerking",
  "dikte",
  "vermogen",
  "effectief",
  "snelheid",
  "passes",
  "airAssist",
  "opmerking",
  "source",
  "reliability",
  "tested",
  "machine",
  "testedAt",
];

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function cleanSetting(input = {}) {
  const result = {};

  for (const key of SETTING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      result[key] = input[key];
    }
  }

  result.materiaal = String(result.materiaal || "").trim();
  result.bewerking = String(result.bewerking || "").trim();
  result.airAssist = String(result.airAssist || "").trim();
  result.opmerking = String(result.opmerking || "").trim();
  result.source = String(result.source || "Eigen instelling").trim();
  result.reliability = String(result.reliability || "Gemiddeld").trim();
  result.machine = String(result.machine || "70 W diode-laser").trim();
  result.tested = Boolean(result.tested);

  return result;
}

function validateSetting(setting) {
  if (!setting.materiaal) {
    return "Materiaal is verplicht.";
  }

  if (!["Snijden", "Graveren"].includes(setting.bewerking)) {
    return "Ongeldige bewerking.";
  }

  if (
    setting.vermogen === "" ||
    setting.vermogen === null ||
    setting.vermogen === undefined ||
    !Number.isFinite(Number(setting.vermogen)) ||
    Number(setting.vermogen) < 0 ||
    Number(setting.vermogen) > 100
  ) {
    return "Vermogen moet tussen 0 en 100% liggen.";
  }

  if (
    setting.bewerking === "Snijden" &&
    (
      setting.dikte === "" ||
      setting.dikte === null ||
      setting.dikte === undefined ||
      !Number.isFinite(Number(setting.dikte))
    )
  ) {
    return "Dikte is verplicht bij snijden.";
  }

  if (
    setting.bewerking === "Graveren" &&
    (
      setting.snelheid === "" ||
      setting.snelheid === null ||
      setting.snelheid === undefined ||
      !Number.isFinite(Number(setting.snelheid))
    )
  ) {
    return "Snelheid is verplicht bij graveren.";
  }

  if (
    setting.snelheid !== "" &&
    setting.snelheid !== null &&
    setting.snelheid !== undefined &&
    Number(setting.snelheid) < 0
  ) {
    return "Snelheid kan niet negatief zijn.";
  }

  return "";
}

function validId(id) {
  return (
    typeof id === "string" &&
    /^[A-Za-z0-9._:-]{1,180}$/.test(id)
  );
}

async function authenticatedUser(request) {
  const authState = await clerk.authenticateRequest(request, {
    authorizedParties: AUTHORIZED_PARTIES,
    acceptsToken: "session_token",
  });

  if (!authState.isAuthenticated) {
    return null;
  }

  const auth = authState.toAuth();

  if (!auth.userId) {
    return null;
  }

  const user = await clerk.users.getUser(auth.userId);

  const metadataRole = String(
    user.publicMetadata?.role || ""
  ).toLowerCase();

  const isAdmin =
    auth.orgRole === "org:admin" ||
    metadataRole === "admin" ||
    metadataRole === "beheerder";

  const email =
    user.emailAddresses?.find(
      (item) => item.id === user.primaryEmailAddressId
    )?.emailAddress ||
    user.emailAddresses?.[0]?.emailAddress ||
    "";

  const name =
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    user.username ||
    email ||
    "Gebruiker";

  return {
    id: user.id,
    name,
    email,
    role: isAdmin ? "admin" : "contributor",
  };
}

async function loadCentralPatch() {
  const [upsertIndex, deletedIndex] = await Promise.all([
    store.list({ prefix: "upserts/" }),
    store.list({ prefix: "deleted/" }),
  ]);

  const upserts = (
    await Promise.all(
      upsertIndex.blobs.map((entry) =>
        store.get(entry.key, {
          type: "json",
          consistency: "strong",
        })
      )
    )
  ).filter(Boolean);

  const deleted = deletedIndex.blobs.map((entry) =>
    entry.key.slice("deleted/".length)
  );

  return {
    upserts,
    deleted,
  };
}

async function addSetting(request, user) {
  const body = await request.json().catch(() => ({}));
  const setting = cleanSetting(body.setting || body);

  const error = validateSetting(setting);
  if (error) {
    return json({ success: false, error }, 400);
  }

  const now = new Date().toISOString();
  const id = `c-${crypto.randomUUID()}`;

  const row = {
    id,
    ...setting,

    createdById: user.id,
    createdByName: user.name,
    createdByEmail: user.email,
    createdByRole: user.role,
    createdAt: now,

    updatedById: "",
    updatedByName: "",
    updatedByEmail: "",
    updatedAt: "",
  };

  await store.setJSON(`upserts/${id}`, row);
  await store.delete(`deleted/${id}`);

  return json({
    success: true,
    action: "add",
    row,
  });
}

async function updateSetting(request, user) {
  if (user.role !== "admin") {
    return json(
      {
        success: false,
        error: "Alleen een Beheerder mag instellingen wijzigen.",
      },
      403
    );
  }

  const body = await request.json().catch(() => ({}));
  const id = body.id;

  if (!validId(id)) {
    return json({ success: false, error: "Ongeldig instelling-ID." }, 400);
  }

  const setting = cleanSetting(body.setting || {});

  const error = validateSetting(setting);
  if (error) {
    return json({ success: false, error }, 400);
  }

  const existing = await store.get(`upserts/${id}`, {
    type: "json",
    consistency: "strong",
  });

  const now = new Date().toISOString();

  const row = {
    id,
    ...setting,

    createdById: existing?.createdById || "",
    createdByName: existing?.createdByName || "",
    createdByEmail: existing?.createdByEmail || "",
    createdByRole: existing?.createdByRole || "",
    createdAt: existing?.createdAt || "",

    updatedById: user.id,
    updatedByName: user.name,
    updatedByEmail: user.email,
    updatedAt: now,
  };

  await store.setJSON(`upserts/${id}`, row);
  await store.delete(`deleted/${id}`);

  return json({
    success: true,
    action: "update",
    row,
  });
}

async function deleteSettings(request, user) {
  if (user.role !== "admin") {
    return json(
      {
        success: false,
        error: "Alleen een Beheerder mag instellingen verwijderen.",
      },
      403
    );
  }

  const body = await request.json().catch(() => ({}));

  let ids = [];

  if (Array.isArray(body.ids)) {
    ids = body.ids;
  } else if (body.id) {
    ids = [body.id];
  }

  ids = [...new Set(ids)].filter(validId);

  if (!ids.length) {
    return json(
      {
        success: false,
        error: "Geen geldige instellingen geselecteerd.",
      },
      400
    );
  }

  const deletedAt = new Date().toISOString();

  await Promise.all(
    ids.map(async (id) => {
      await store.delete(`upserts/${id}`);

      await store.setJSON(`deleted/${id}`, {
        id,
        deletedAt,
        deletedById: user.id,
        deletedByName: user.name,
        deletedByEmail: user.email,
      });
    })
  );

  return json({
    success: true,
    action: "delete",
    deleted: ids,
  });
}

export default async (request) => {
  try {
    const user = await authenticatedUser(request);

    if (!user) {
      return json(
        {
          success: false,
          error: "Niet aangemeld.",
        },
        401
      );
    }

    if (request.method === "GET") {
      const patch = await loadCentralPatch();

      return json({
        success: true,
        version: 1,
        user: {
          id: user.id,
          name: user.name,
          role: user.role,
        },
        patch,
      });
    }

    if (request.method === "POST") {
      return await addSetting(request, user);
    }

    if (request.method === "PUT") {
      return await updateSetting(request, user);
    }

    if (request.method === "DELETE") {
      return await deleteSettings(request, user);
    }

    return json(
      {
        success: false,
        error: "Methode niet toegestaan.",
      },
      405
    );
  } catch (error) {
    console.error("Laser settings API:", error);

    return json(
      {
        success: false,
        error: "Serverfout bij verwerken van de laserinstellingen.",
      },
      500
    );
  }
};

export const config = {
  path: "/api/settings",
};
