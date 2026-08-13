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

const BLOB_RETRY_DELAYS = [0, 250, 600, 1200];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withBlobRetry(label, operation) {
  let lastError;

  for (let attempt = 0; attempt < BLOB_RETRY_DELAYS.length; attempt += 1) {
    if (BLOB_RETRY_DELAYS[attempt]) {
      await wait(BLOB_RETRY_DELAYS[attempt]);
    }

    try {
      return await operation();
    } catch (error) {
      lastError = error;
      console.warn(
        `Netlify Blobs tijdelijk mislukt (${label}) - poging ${attempt + 1}/${BLOB_RETRY_DELAYS.length}`,
        error?.message || error
      );
    }
  }

  throw lastError;
}

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
  if (!setting.materiaal) return "Materiaal is verplicht.";
  if (!["Snijden", "Graveren"].includes(setting.bewerking)) return "Ongeldige bewerking.";

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
  return typeof id === "string" && /^[A-Za-z0-9._:-]{1,180}$/.test(id);
}

function roleForClerkUser(user) {
  const metadataRole = String(user?.publicMetadata?.role || "").toLowerCase();
  return metadataRole === "admin" || metadataRole === "beheerder" ? "admin" : "contributor";
}

function emailForClerkUser(user) {
  return (
    user?.emailAddresses?.find((item) => item.id === user.primaryEmailAddressId)?.emailAddress ||
    user?.emailAddresses?.[0]?.emailAddress ||
    ""
  );
}

function nameForClerkUser(user) {
  return (
    [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
    user?.username ||
    emailForClerkUser(user) ||
    "Gebruiker"
  );
}

function storedRow(row) {
  if (!row) return row;
  return {
    ...row,
    approvalStatus: row.approvalStatus || "approved",
    approvedById: row.approvedById || "",
    approvedByName: row.approvedByName || "",
    approvedAt: row.approvedAt || "",
  };
}

function rowForUser(row, user) {
  if (!row) return row;
  const safe = storedRow(row);
  if (user.role === "admin") return safe;
  const result = { ...safe };
  delete result.createdByEmail;
  delete result.updatedByEmail;
  return result;
}

function historySummary(entry) {
  return {
    id: entry.id,
    type: entry.type,
    label: entry.label,
    user: entry.user,
    userId: entry.userId,
    at: entry.at,
    rowId: entry.rowId || "",
    restorable: Boolean(entry.restorable),
  };
}

async function authenticatedUser(request) {
  const authState = await clerk.authenticateRequest(request, {
    authorizedParties: AUTHORIZED_PARTIES,
    acceptsToken: "session_token",
  });

  if (!authState.isAuthenticated) return null;

  const auth = authState.toAuth();
  if (!auth.userId) return null;

  const clerkUser = await clerk.users.getUser(auth.userId);
  const metadataRole = String(clerkUser.publicMetadata?.role || "").toLowerCase();

  const isAdmin =
    auth.orgRole === "org:admin" ||
    metadataRole === "admin" ||
    metadataRole === "beheerder";

  return {
    id: clerkUser.id,
    name: nameForClerkUser(clerkUser),
    email: emailForClerkUser(clerkUser),
    role: isAdmin ? "admin" : "contributor",
  };
}

async function addHistoryEntry({
  type,
  label,
  user,
  rowId = "",
  before = null,
  after = null,
  restorable = false,
}) {
  const at = new Date().toISOString();
  const id = `h-${Date.now()}-${crypto.randomUUID()}`;
  const entry = {
    id,
    type,
    label: shortText(label, 500),
    user: user.name,
    userId: user.id,
    userRole: user.role,
    at,
    rowId: validId(rowId) ? rowId : "",
    before,
    after,
    restorable: Boolean(restorable),
  };
  await store.setJSON(`history/${String(Date.now()).padStart(13, "0")}-${id}`, entry);
  return entry;
}

async function historyEntries(limit = 300) {
  const listing = await withBlobRetry(
    "list history",
    () => store.list({ prefix: "history/" })
  );

  const selected = listing.blobs
    .slice()
    .sort((a, b) => String(b.key).localeCompare(String(a.key)))
    .slice(0, Math.max(1, Math.min(300, limit)));

  return (
    await Promise.all(
      selected.map((item) =>
        withBlobRetry(
          `get ${item.key}`,
          () =>
            store.get(item.key, {
              type: "json",
              consistency: "strong",
            })
        )
      )
    )
  ).filter(Boolean);
}

async function loadCentralPatch(user) {
  // Bewust sequentieel + retry: een tijdelijke fout in één Blob-list mag
  // de volledige centrale database niet meteen onbereikbaar maken.
  const upsertIndex = await withBlobRetry(
    "list upserts",
    () => store.list({ prefix: "upserts/" })
  );

  const deletedIndex = await withBlobRetry(
    "list deleted",
    () => store.list({ prefix: "deleted/" })
  );

  const upsertsRaw = (
    await Promise.all(
      upsertIndex.blobs.map((entry) =>
        withBlobRetry(
          `get ${entry.key}`,
          () =>
            store.get(entry.key, {
              type: "json",
              consistency: "strong",
            })
        )
      )
    )
  ).filter(Boolean);

  const visibleRows =
    user.role === "admin"
      ? upsertsRaw
      : upsertsRaw.filter(
          (row) =>
            (row.approvalStatus || "approved") !== "pending" ||
            row.createdById === user.id
        );

  const upserts = visibleRows.map((row) => rowForUser(row, user));
  const deleted = deletedIndex.blobs.map((entry) =>
    entry.key.slice("deleted/".length)
  );
  const deletedSet = new Set(deleted);

  const pendingCount = upsertsRaw.filter(
    (row) =>
      (row.approvalStatus || "approved") === "pending" &&
      !deletedSet.has(row.id) &&
      (user.role === "admin" || row.createdById === user.id)
  ).length;

  return { upserts, deleted, pendingCount };
}

async function listUsersForAdmin(user) {
  if (user.role !== "admin") return [];
  const { data, totalCount } = await clerk.users.getUserList({
    limit: 100,
    orderBy: "-created_at",
  });

  return {
    totalCount,
    users: data.map((item) => ({
      id: item.id,
      name: nameForClerkUser(item),
      email: emailForClerkUser(item),
      role: item.id === user.id ? user.role : roleForClerkUser(item),
      createdAt: item.createdAt || null,
      lastSignInAt: item.lastSignInAt || null,
      banned: Boolean(item.banned),
      self: item.id === user.id,
    })),
  };
}

async function addSetting(request, user) {
  const body = await request.json().catch(() => ({}));
  const setting = cleanSetting(body.setting || body);
  const error = validateSetting(setting);
  if (error) return json({ success: false, error }, 400);

  const now = new Date().toISOString();
  const id = `c-${crypto.randomUUID()}`;
  const approvalStatus = user.role === "admin" ? "approved" : "pending";

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
    approvalStatus,
    approvedById: user.role === "admin" ? user.id : "",
    approvedByName: user.role === "admin" ? user.name : "",
    approvedAt: user.role === "admin" ? now : "",
  };

  await store.setJSON(`upserts/${id}`, row);
  await store.delete(`deleted/${id}`);

  await addHistoryEntry({
    type: "add",
    label:
      approvalStatus === "pending"
        ? `Instelling toegevoegd ter goedkeuring: ${setting.materiaal} · ${setting.bewerking}`
        : `Instelling toegevoegd: ${setting.materiaal} · ${setting.bewerking}`,
    user,
    rowId: id,
    before: null,
    after: row,
    restorable: user.role === "admin",
  });

  return json({
    success: true,
    action: "add",
    row: rowForUser(row, user),
    pendingApproval: approvalStatus === "pending",
  });
}

async function updateSetting(request, user) {
  if (user.role !== "admin") {
    return json({ success: false, error: "Alleen een Beheerder mag instellingen wijzigen." }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const id = body.id;
  if (!validId(id)) return json({ success: false, error: "Ongeldig instelling-ID." }, 400);

  const setting = cleanSetting(body.setting || {});
  const error = validateSetting(setting);
  if (error) return json({ success: false, error }, 400);

  const existingStored = await store.get(`upserts/${id}`, {
    type: "json",
    consistency: "strong",
  });

  const suppliedBefore = body.before && typeof body.before === "object"
    ? { id, ...cleanSetting(body.before) }
    : null;

  const existing = storedRow(existingStored);
  const before = existing || suppliedBefore || { id };
  const now = new Date().toISOString();

  const row = {
    id,
    ...setting,
    createdById: existing?.createdById || shortText(body.before?.createdById, 180),
    createdByName: existing?.createdByName || shortText(body.before?.createdByName, 180),
    createdByEmail: existing?.createdByEmail || shortText(body.before?.createdByEmail, 320),
    createdByRole: existing?.createdByRole || shortText(body.before?.createdByRole, 30),
    createdAt: existing?.createdAt || shortText(body.before?.createdAt, 60),
    updatedById: user.id,
    updatedByName: user.name,
    updatedByEmail: user.email,
    updatedAt: now,
    approvalStatus: existing?.approvalStatus || "approved",
    approvedById: existing?.approvedById || "",
    approvedByName: existing?.approvedByName || "",
    approvedAt: existing?.approvedAt || "",
  };

  await store.setJSON(`upserts/${id}`, row);
  await store.delete(`deleted/${id}`);

  await addHistoryEntry({
    type: "edit",
    label: `Instelling gewijzigd: ${setting.materiaal} · ${setting.bewerking}`,
    user,
    rowId: id,
    before,
    after: row,
    restorable: true,
  });

  return json({ success: true, action: "update", row });
}

async function deleteSettings(request, user) {
  if (user.role !== "admin") {
    return json({ success: false, error: "Alleen een Beheerder mag instellingen verwijderen." }, 403);
  }

  const body = await request.json().catch(() => ({}));
  let ids = Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : [];
  ids = [...new Set(ids)].filter(validId).slice(0, 100);

  if (!ids.length) {
    return json({ success: false, error: "Geen geldige instellingen geselecteerd." }, 400);
  }

  const snapshots = new Map(
    (Array.isArray(body.snapshots) ? body.snapshots : [])
      .filter((row) => row && validId(row.id))
      .map((row) => [row.id, row])
  );

  const deletedAt = new Date().toISOString();

  for (const id of ids) {
    const existing = storedRow(
      await store.get(`upserts/${id}`, { type: "json", consistency: "strong" })
    );
    const before = existing || snapshots.get(id) || { id };

    await store.setJSON(`deleted/${id}`, {
      id,
      deletedAt,
      deletedById: user.id,
      deletedByName: user.name,
      deletedByEmail: user.email,
    });

    await addHistoryEntry({
      type: "delete",
      label: `Instelling verwijderd: ${shortText(before.materiaal || id, 120)}`,
      user,
      rowId: id,
      before,
      after: null,
      restorable: true,
    });
  }

  return json({ success: true, action: "delete", deleted: ids });
}

async function approveSetting(id, user) {
  if (user.role !== "admin") {
    return json({ success: false, error: "Alleen een Beheerder kan instellingen goedkeuren." }, 403);
  }
  if (!validId(id)) return json({ success: false, error: "Ongeldig instelling-ID." }, 400);

  const current = storedRow(
    await store.get(`upserts/${id}`, { type: "json", consistency: "strong" })
  );
  if (!current) return json({ success: false, error: "Instelling niet gevonden." }, 404);

  const now = new Date().toISOString();
  const row = {
    ...current,
    approvalStatus: "approved",
    approvedById: user.id,
    approvedByName: user.name,
    approvedAt: now,
  };

  await store.setJSON(`upserts/${id}`, row);
  await store.delete(`deleted/${id}`);
  await addHistoryEntry({
    type: "approve",
    label: `Instelling goedgekeurd: ${row.materiaal} · ${row.bewerking}`,
    user,
    rowId: id,
    before: current,
    after: row,
    restorable: false,
  });

  return json({ success: true, action: "approve", row });
}

async function rejectSetting(id, user) {
  if (user.role !== "admin") {
    return json({ success: false, error: "Alleen een Beheerder kan instellingen afwijzen." }, 403);
  }
  if (!validId(id)) return json({ success: false, error: "Ongeldig instelling-ID." }, 400);

  const current = storedRow(
    await store.get(`upserts/${id}`, { type: "json", consistency: "strong" })
  );
  if (!current) return json({ success: false, error: "Instelling niet gevonden." }, 404);

  const rejectedAt = new Date().toISOString();
  await store.setJSON(`deleted/${id}`, {
    id,
    deletedAt: rejectedAt,
    deletedById: user.id,
    deletedByName: user.name,
    deletedByEmail: user.email,
    reason: "rejected",
  });

  await addHistoryEntry({
    type: "reject",
    label: `Instelling afgewezen: ${current.materiaal} · ${current.bewerking}`,
    user,
    rowId: id,
    before: current,
    after: null,
    restorable: true,
  });

  return json({ success: true, action: "reject", id });
}

async function setUserRole(targetUserId, role, user) {
  if (user.role !== "admin") {
    return json({ success: false, error: "Alleen een Beheerder kan rollen wijzigen." }, 403);
  }
  if (!validId(targetUserId) || !["admin", "contributor"].includes(role)) {
    return json({ success: false, error: "Ongeldige gebruiker of rol." }, 400);
  }
  if (targetUserId === user.id) {
    return json({ success: false, error: "Je kunt je eigen beheerdersrol hier niet wijzigen." }, 400);
  }

  const target = await clerk.users.getUser(targetUserId);
  const oldRole = roleForClerkUser(target);

  await clerk.users.updateUserMetadata(targetUserId, {
    publicMetadata: { role },
  });

  await addHistoryEntry({
    type: "user_role",
    label: `Rol gewijzigd: ${nameForClerkUser(target)} · ${oldRole} → ${role}`,
    user,
    rowId: "",
    restorable: false,
  });

  return json({ success: true, action: "set-user-role" });
}

async function deleteUser(targetUserId, confirmation, user) {
  if (user.role !== "admin") {
    return json({ success: false, error: "Alleen een Beheerder kan gebruikers verwijderen." }, 403);
  }
  if (!validId(targetUserId) || confirmation !== "VERWIJDER") {
    return json({ success: false, error: "Ongeldige verwijderopdracht." }, 400);
  }
  if (targetUserId === user.id) {
    return json({ success: false, error: "Je kunt je eigen account hier niet verwijderen." }, 400);
  }

  const target = await clerk.users.getUser(targetUserId);
  const targetName = nameForClerkUser(target);
  await clerk.users.deleteUser(targetUserId);

  await addHistoryEntry({
    type: "user_delete",
    label: `Gebruiker verwijderd: ${targetName}`,
    user,
    restorable: false,
  });

  return json({ success: true, action: "delete-user" });
}

async function restoreHistory(historyId, user) {
  if (user.role !== "admin") {
    return json({ success: false, error: "Alleen een Beheerder kan wijzigingen herstellen." }, 403);
  }

  const listing = await withBlobRetry("list history for restore", () => store.list({ prefix: "history/" }));
  const match = listing.blobs.find((item) => item.key.endsWith(historyId));
  if (!match) return json({ success: false, error: "Geschiedenisitem niet gevonden." }, 404);

  const entry = await withBlobRetry(`get ${match.key}`, () => store.get(match.key, { type: "json", consistency: "strong" }));
  if (!entry?.restorable) {
    return json({ success: false, error: "Deze actie kan niet worden hersteld." }, 400);
  }

  if (entry.type === "add" && entry.after?.id) {
    await store.setJSON(`deleted/${entry.after.id}`, {
      id: entry.after.id,
      deletedAt: new Date().toISOString(),
      deletedById: user.id,
      deletedByName: user.name,
      reason: "history_restore",
    });
  } else if (["edit", "delete", "reject"].includes(entry.type) && entry.before?.id) {
    if (Object.keys(entry.before).length > 1) {
      await store.setJSON(`upserts/${entry.before.id}`, storedRow(entry.before));
    }
    await store.delete(`deleted/${entry.before.id}`);
  } else {
    return json({ success: false, error: "Deze actie kan niet worden hersteld." }, 400);
  }

  await addHistoryEntry({
    type: "restore",
    label: `Hersteld: ${entry.label}`,
    user,
    rowId: entry.rowId || "",
    restorable: false,
  });

  return json({ success: true, action: "restore-history" });
}

async function handlePatch(request, user) {
  const body = await request.json().catch(() => ({}));
  switch (body.action) {
    case "approve-setting":
      return approveSetting(body.id, user);
    case "reject-setting":
      return rejectSetting(body.id, user);
    case "set-user-role":
      return setUserRole(body.userId, body.role, user);
    case "delete-user":
      return deleteUser(body.userId, body.confirmation, user);
    case "restore-history":
      return restoreHistory(body.historyId, user);
    default:
      return json({ success: false, error: "Onbekende beheeractie." }, 400);
  }
}

export default async (request) => {
  try {
    const user = await authenticatedUser(request);
    if (!user) return json({ success: false, error: "Niet aangemeld." }, 401);

    const url = new URL(request.url);

    if (request.method === "GET") {
      const patch = await loadCentralPatch(user);
      const recentHistory = (await historyEntries(5)).map(historySummary);

      const result = {
        success: true,
        version: 4,
        user: { id: user.id, name: user.name, role: user.role },
        patch: { upserts: patch.upserts, deleted: patch.deleted },
        pendingCount: patch.pendingCount,
        recentHistory,
      };

      if (url.searchParams.get("include") === "meta" && user.role === "admin") {
        const [history, userData] = await Promise.all([
          historyEntries(300),
          listUsersForAdmin(user),
        ]);
        result.history = history;
        result.users = userData.users;
        result.userCount = userData.totalCount;
      }

      return json(result);
    }

    if (request.method === "POST") return addSetting(request, user);
    if (request.method === "PUT") return updateSetting(request, user);
    if (request.method === "DELETE") return deleteSettings(request, user);
    if (request.method === "PATCH") return handlePatch(request, user);

    return json({ success: false, error: "Methode niet toegestaan." }, 405);
  } catch (error) {
    console.error("Laser settings API:", error);
    return json(
      { success: false, error: "Serverfout bij verwerken van de laserinstellingen." },
      500
    );
  }
};

export const config = {
  path: "/api/settings",
};
