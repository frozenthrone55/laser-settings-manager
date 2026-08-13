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
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function shortText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanSetting(input = {}) {
  const result = {};

  for (const key of SETTING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      result[key] = input[key];
    }
  }

  result.materiaal = shortText(result.materiaal, 120);
  result.bewerking = shortText(result.bewerking, 20);
  result.airAssist = shortText(result.airAssist, 180);
  result.opmerking = shortText(result.opmerking, 2500);
  result.source = shortText(result.source || "Eigen instelling", 120);
  result.reliability = shortText(result.reliability || "Gemiddeld", 50);
  result.machine = shortText(result.machine || "70 W diode-laser", 120);
  result.testedAt = shortText(result.testedAt, 60);
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

  const power = Number(setting.vermogen);
  if (!Number.isFinite(power) || power < 0 || power > 100) {
    return "Vermogen moet tussen 0 en 100% liggen.";
  }

  if (setting.bewerking === "Snijden") {
    const thickness = Number(setting.dikte);
    if (!Number.isFinite(thickness) || thickness < 0 || thickness > 1000) {
      return "Dikte is verplicht bij snijden en moet een geldige waarde zijn.";
    }
  }

  if (setting.snelheid !== "" && setting.snelheid !== null && setting.snelheid !== undefined) {
    const speed = Number(setting.snelheid);
    if (!Number.isFinite(speed) || speed < 0 || speed > 1000000) {
      return "Snelheid is ongeldig.";
    }
  } else if (setting.bewerking === "Graveren") {
    return "Snelheid is verplicht bij graveren.";
  }

  if (setting.passes !== "" && setting.passes !== null && setting.passes !== undefined) {
    const passes = Number(setting.passes);
    if (!Number.isFinite(passes) || passes < 1 || passes > 1000) {
      return "Aantal passes is ongeldig.";
    }
  }

  return "";
}

function validId(id) {
  return (
    typeof id === "string" &&
    /^[A-Za-z0-9._:-]{1,180}$/.test(id)
  );
}

function rowForUser(row, user) {
  if (!row || user.role === "admin") {
    return row;
  }

  const safe = { ...row };
  delete safe.createdByEmail;
  delete safe.updatedByEmail;
  return safe;
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

async function loadCentralPatch(user) {
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
  )
    .filter(Boolean)
    .map((row) => rowForUser(row, user));

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
    row: rowForUser(row, user),
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

  ids = [...new Set(ids)].filter(validId).slice(0, 100);

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
      // Bewaar een bestaande upsert zodat een herstelactie de oorspronkelijke
      // auteur- en aanmaakmetadata kan behouden. De deleted-marker bepaalt
      // of de rij zichtbaar is.
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
      const patch = await loadCentralPatch(user);

      return json({
        success: true,
        version: 2,
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
