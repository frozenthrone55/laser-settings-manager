import { getStore } from "@netlify/blobs";
import { createClerkClient } from "@clerk/backend";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
});

// Maak geen Blobs-store op module-niveau.
// Netlify injecteert de Blobs-context per Function-aanroep. Een warm
// Function-proces kan anders een eerder aangemaakte store met een verlopen
// tijdelijk token blijven hergebruiken.
function primaryStore() {
  return getStore({
    name: "laser-settings",
    consistency: "strong",
  });
}

// Alleen als lees-fallback. Schrijfacties blijven via primaryStore() lopen.
function fallbackStore() {
  return getStore("laser-settings");
}

const AUTHORIZED_PARTIES = [
  "https://laser-settings-manager-v3.netlify.app",
  "https://development--laser-settings-manager-v3.netlify.app",
];

const MAX_JSON_BODY_BYTES = 128 * 1024;
const MAX_MIGRATION_BODY_BYTES = 5 * 1024 * 1024;

function requestSourceAllowed(request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  if (origin && !AUTHORIZED_PARTIES.includes(origin)) return false;
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) return false;
  return true;
}

function requestBodyAllowed(request) {
  const raw = request.headers.get("content-length");
  if (!raw) return true;
  const length = Number(raw);
  if (!Number.isFinite(length) || length < 0) return false;

  const url = new URL(request.url);
  const maxBytes =
    url.searchParams.get("migration") === "1"
      ? MAX_MIGRATION_BODY_BYTES
      : MAX_JSON_BODY_BYTES;

  return length <= maxBytes;
}

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


async function listBlobsResilient(prefix, label) {
  try {
    return await withBlobRetry(
      label,
      () => primaryStore().list({ prefix })
    );
  } catch (strongError) {
    console.warn(
      `Netlify Blobs strong-consistency mislukt (${label}); probeer eventual-consistency fallback.`,
      strongError?.message || strongError
    );

    try {
      return await withBlobRetry(
        `${label} eventual fallback`,
        () => fallbackStore().list({ prefix })
      );
    } catch (eventualError) {
      console.error(
        `Netlify Blobs fallback mislukt (${label}).`,
        eventualError?.message || eventualError
      );
      throw strongError;
    }
  }
}

async function getBlobResilient(key, type = "json") {
  try {
    return await withBlobRetry(
      `get ${key}`,
      () =>
        primaryStore().get(key, {
          type,
          consistency: "strong",
        })
    );
  } catch (strongError) {
    console.warn(
      `Netlify Blobs strong-consistency get mislukt (${key}); probeer eventual-consistency fallback.`,
      strongError?.message || strongError
    );

    try {
      return await withBlobRetry(
        `get ${key} eventual fallback`,
        () =>
          fallbackStore().get(key, {
            type,
            consistency: "eventual",
          })
      );
    } catch (eventualError) {
      console.error(
        `Netlify Blobs get fallback mislukt (${key}).`,
        eventualError?.message || eventualError
      );
      throw strongError;
    }
  }
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
  "machineBrand",
  "machineModel",
  "laserWatt",
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

const PROFILE_LANGS = ["nl", "en", "fr", "de"];
const PROFILE_VISUAL_MODES = new Set(["", "url", "upload", "ral", "transparent"]);
const PROFILE_SAFETY_LEVELS = new Set(["", "ok", "warn", "danger"]);

function safeColor(value, fallback = "") {
  const s = shortText(value, 20);
  return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : fallback;
}

function cleanProfileTranslations(input = {}) {
  const result = {};
  for (const lang of PROFILE_LANGS) {
    const item = input?.[lang] && typeof input[lang] === "object" ? input[lang] : {};
    result[lang] = {
      name: shortText(item.name, 180),
      description: shortText(item.description, 3000),
      safetyText: shortText(item.safetyText, 4000),
      notes: shortText(item.notes, 4000),
    };
  }
  return result;
}

function cleanMaterialProfile(input = {}) {
  const visualMode = PROFILE_VISUAL_MODES.has(String(input.visualMode || ""))
    ? String(input.visualMode || "")
    : "";

  const safetyLevel = PROFILE_SAFETY_LEVELS.has(String(input.safetyLevel || ""))
    ? String(input.safetyLevel || "")
    : "";

  let image = shortText(input.image, 60000);
  if (image && !/^https?:\/\//i.test(image) && !/^data:image\//i.test(image)) {
    image = "";
  }

  return {
    categoryKey: shortText(input.categoryKey, 180),
    category: shortText(input.category, 180),
    manufacturer: shortText(input.manufacturer, 200),
    supplier: shortText(input.supplier, 200),
    internalCode: shortText(input.internalCode, 120),
    datasheetUrl: /^https?:\/\//i.test(shortText(input.datasheetUrl, 1200)) ? shortText(input.datasheetUrl, 1200) : "",
    materialColor: safeColor(input.materialColor),
    transparency: ["", "opaque", "translucent", "transparent"].includes(String(input.transparency || "")) ? String(input.transparency || "") : "",
    suitability: ["", "both", "cut", "engrave"].includes(String(input.suitability || "")) ? String(input.suitability || "") : "",
    defaultAirAssist: shortText(input.defaultAirAssist, 180),
    safetyLevel,
    visualMode,
    image,
    ralCode: shortText(input.ralCode, 30),
    ralHex: safeColor(input.ralHex),
    transparentTint: safeColor(input.transparentTint),
    transparentOpacity:
      Number.isFinite(Number(input.transparentOpacity))
        ? Math.max(0.1, Math.min(0.9, Number(input.transparentOpacity)))
        : "",
    translations: cleanProfileTranslations(input.translations),
  };
}

function cleanCustomCategory(input = {}) {
  const id = shortText(input.id, 180);
  if (!validId(id)) return null;

  const translations = {};
  for (const lang of PROFILE_LANGS) {
    translations[lang] = shortText(input?.translations?.[lang], 180);
  }

  if (!PROFILE_LANGS.every((lang) => translations[lang])) return null;

  return {
    id,
    createdAt: shortText(input.createdAt, 60) || new Date().toISOString(),
    translations,
  };
}

function profileBlobKey(material) {
  const safe = shortText(material, 180);
  if (!safe) return "";
  return `material-profiles/${Buffer.from(safe, "utf8").toString("base64url")}`;
}

function categoryBlobKey(id) {
  return `material-categories/${id}`;
}

const BUILTIN_LASER_PROFILES = [10, 20, 40, 70];
const MATERIAL_RENAMES_KEY = "config/material-renames";
const LASER_PROFILES_KEY = "config/laser-profiles";

function cleanMaterialRenames(input = {}) {
  const result = {};
  for (const [fromRaw, toRaw] of Object.entries(input || {})) {
    const from = shortText(fromRaw, 180);
    const to = shortText(toRaw, 180);
    if (from && to && from !== to) result[from] = to;
  }
  return result;
}

function resolveMaterialRename(value, renames = {}) {
  let current = shortText(value, 180);
  const seen = new Set();
  for (let i = 0; i < 30 && renames[current] && !seen.has(current); i += 1) {
    seen.add(current);
    current = shortText(renames[current], 180);
  }
  return current;
}

async function loadMaterialRenames() {
  const entry = await getBlobResilient(MATERIAL_RENAMES_KEY, "json").catch(() => null);
  return cleanMaterialRenames(entry?.renames || entry || {});
}

async function saveMaterialRenames(renames, user) {
  const clean = cleanMaterialRenames(renames);
  await primaryStore().setJSON(MATERIAL_RENAMES_KEY, {
    renames: clean,
    updatedAt: new Date().toISOString(),
    updatedById: user.id,
    updatedByName: user.name,
  });
  return clean;
}

function cleanLaserProfiles(values) {
  const custom = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter((v) => Number.isFinite(v) && v >= 1 && v <= 200)
    .map((v) => Math.round(v * 10) / 10);
  return [...new Set([...BUILTIN_LASER_PROFILES, ...custom])].sort((a, b) => a - b);
}

async function loadLaserProfiles() {
  const entry = await getBlobResilient(LASER_PROFILES_KEY, "json").catch(() => null);
  return cleanLaserProfiles(entry?.profiles || []);
}

async function saveLaserProfiles(profiles, user) {
  const clean = cleanLaserProfiles(profiles);
  await primaryStore().setJSON(LASER_PROFILES_KEY, {
    profiles: clean,
    updatedAt: new Date().toISOString(),
    updatedById: user.id,
    updatedByName: user.name,
  });
  return clean;
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
  result.machineBrand = shortText(result.machineBrand, 160);
  result.machineModel = shortText(result.machineModel, 200);
  const parsedLaserWatt =
    Number(result.laserWatt) ||
    Number(String(result.machine || "").match(/(10|20|40|70)\s*W/i)?.[1]) ||
    70;

  result.laserWatt = parsedLaserWatt;
  const explicitMachine = [result.machineBrand, result.machineModel].filter(Boolean).join(" · ");
  result.machine = shortText(
    explicitMachine || result.machine || `${parsedLaserWatt} W diode-laser`,
    360
  );

  const power = Number(result.vermogen);
  if (Number.isFinite(power)) {
    result.effectief =
      Math.round((parsedLaserWatt * power / 100) * 10) / 10;
  }

  result.testedAt = shortText(result.testedAt, 60);
  result.tested = Boolean(result.tested);

  return result;
}

function validateSetting(setting) {
  if (!setting.materiaal) return "Materiaal is verplicht.";
  if (!["Snijden", "Graveren"].includes(setting.bewerking)) return "Ongeldige bewerking.";

  const laserWatt = Number(setting.laserWatt);
  if (!Number.isFinite(laserWatt) || laserWatt < 1 || laserWatt > 200) {
    return "Laservermogen moet een geldige optische waarde tussen 1 en 200 W zijn.";
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

function testerMetadata(row) {
  if (!row?.tested) {
    return { testedById: "", testedByName: "", testedByEmail: "" };
  }

  const explicit = {
    testedById: shortText(row.testedById, 180),
    testedByName: shortText(row.testedByName, 220),
    testedByEmail: shortText(row.testedByEmail, 320),
  };
  if (explicit.testedById || explicit.testedByEmail) return explicit;

  const testedAt = Date.parse(shortText(row.testedAt, 60));
  const updatedAt = Date.parse(shortText(row.updatedAt, 60));
  const createdAt = Date.parse(shortText(row.createdAt, 60));

  // Oudere instelling die door een wijziging als Getest werd gemarkeerd.
  if (
    shortText(row.updatedById, 180) &&
    Number.isFinite(testedAt) &&
    Number.isFinite(updatedAt) &&
    Math.abs(testedAt - updatedAt) <= 5 * 60 * 1000
  ) {
    return {
      testedById: shortText(row.updatedById, 180),
      testedByName: shortText(row.updatedByName, 220),
      testedByEmail: shortText(row.updatedByEmail, 320),
    };
  }

  // Een direct als Eigen test aangemaakte instelling hoort bij de maker.
  if (
    shortText(row.createdById, 180) &&
    (
      shortText(row.source, 120) === "Eigen test" ||
      (
        Number.isFinite(testedAt) &&
        Number.isFinite(createdAt) &&
        Math.abs(testedAt - createdAt) <= 5 * 60 * 1000
      )
    )
  ) {
    return {
      testedById: shortText(row.createdById, 180),
      testedByName: shortText(row.createdByName, 220),
      testedByEmail: shortText(row.createdByEmail, 320),
    };
  }

  return { testedById: "", testedByName: "", testedByEmail: "" };
}

function storedRow(row) {
  if (!row) return row;
  const tester = testerMetadata(row);
  return {
    ...row,
    testedById: tester.testedById,
    testedByName: tester.testedByName,
    testedByEmail: tester.testedByEmail,
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
  delete result.testedByEmail;
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
  await primaryStore().setJSON(`history/${String(Date.now()).padStart(13, "0")}-${id}`, entry);
  return entry;
}

async function historyEntries(limit = 300) {
  const listing = await listBlobsResilient("history/", "list history");

  const selected = listing.blobs
    .slice()
    .sort((a, b) => String(b.key).localeCompare(String(a.key)))
    .slice(0, Math.max(1, Math.min(300, limit)));

  return (
    await Promise.all(
      selected.map((item) => getBlobResilient(item.key, "json"))
    )
  ).filter(Boolean);
}

async function loadCentralPatch(user) {
  // Primair: strong consistency. Bij een tijdelijke Netlify-originfout
  // schakelen de leesoperaties automatisch over naar eventual consistency.
  const upsertIndex = await listBlobsResilient("upserts/", "list upserts");
  const deletedIndex = await listBlobsResilient("deleted/", "list deleted");

  const upsertsRaw = (
    await Promise.all(
      upsertIndex.blobs.map((entry) => getBlobResilient(entry.key, "json"))
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

  return { upserts, deleted, pendingCount, rawUpserts: upsertsRaw };
}



async function loadMaterialProfiles() {
  const listing = await listBlobsResilient("material-profiles/", "list material profiles");
  const entries = (
    await Promise.all(
      listing.blobs.map((item) => getBlobResilient(item.key, "json"))
    )
  ).filter(Boolean);

  const result = {};
  for (const entry of entries) {
    const material = shortText(entry.material, 180);
    if (!material) continue;
    result[material] = cleanMaterialProfile(entry.profile || {});
  }
  return result;
}


function normalizeCategoryLabel(value) {
  return shortText(value, 180)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function categoryTranslationTokens(category) {
  return new Set(
    PROFILE_LANGS
      .map((lang) => normalizeCategoryLabel(category?.translations?.[lang]))
      .filter(Boolean)
  );
}

function categoriesShareTranslation(a, b) {
  const aTokens = categoryTranslationTokens(a);
  const bTokens = categoryTranslationTokens(b);
  for (const token of aTokens) {
    if (bTokens.has(token)) return true;
  }
  return false;
}

function duplicateCategoryGroups(categories = {}) {
  const entries = Object.entries(categories);
  const parent = new Map(entries.map(([id]) => [id, id]));

  const find = (id) => {
    let p = parent.get(id);
    while (p !== parent.get(p)) {
      parent.set(p, parent.get(parent.get(p)));
      p = parent.get(p);
    }
    return p;
  };

  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (categoriesShareTranslation(entries[i][1], entries[j][1])) {
        union(entries[i][0], entries[j][0]);
      }
    }
  }

  const groups = new Map();
  for (const [id] of entries) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }

  return [...groups.values()].filter((group) => group.length > 1);
}

function canonicalCategoryId(ids, categories = {}) {
  return [...ids].sort((a, b) => {
    const ca = categories[a];
    const cb = categories[b];
    const ta = Date.parse(ca?.createdAt || "") || Number.MAX_SAFE_INTEGER;
    const tb = Date.parse(cb?.createdAt || "") || Number.MAX_SAFE_INTEGER;
    return ta - tb || a.localeCompare(b);
  })[0] || "";
}

function findExistingCategoryByTranslations(category, categories = {}, excludeId = "") {
  for (const [id, existing] of Object.entries(categories)) {
    if (id === excludeId) continue;
    if (categoriesShareTranslation(category, existing)) return existing;
  }
  return null;
}

async function deduplicateCustomCategories(user) {
  if (user.role !== "admin") {
    return json(
      { success: false, error: "Alleen een Beheerder kan materiaalcategorieën samenvoegen." },
      403
    );
  }

  const categories = await loadCustomCategories();
  const groups = duplicateCategoryGroups(categories);

  if (!groups.length) {
    return json({
      success: true,
      action: "deduplicate-custom-categories",
      mergedCount: 0,
      customCategories: categories,
      materialProfiles: await loadMaterialProfiles(),
      remap: {},
    });
  }

  const profiles = await loadMaterialProfiles();
  const remap = {};
  let mergedCount = 0;

  for (const group of groups) {
    const canonicalId = canonicalCategoryId(group, categories);
    const canonical = categories[canonicalId];
    if (!canonical) continue;

    for (const duplicateId of group) {
      if (duplicateId === canonicalId) continue;
      remap[duplicateId] = canonicalId;
      mergedCount += 1;
    }
  }

  // Repoint all material profiles before deleting duplicate categories.
  for (const [material, profile] of Object.entries(profiles)) {
    const newCategoryKey = remap[profile.categoryKey];
    if (!newCategoryKey) continue;

    const updatedProfile = cleanMaterialProfile({
      ...profile,
      categoryKey: newCategoryKey,
      category: "",
    });

    await primaryStore().setJSON(profileBlobKey(material), {
      material,
      profile: updatedProfile,
      updatedAt: new Date().toISOString(),
      updatedById: user.id,
      updatedByName: user.name,
    });

    profiles[material] = updatedProfile;
  }

  // Remove duplicate category blobs.
  for (const duplicateId of Object.keys(remap)) {
    await primaryStore().delete(categoryBlobKey(duplicateId));
    delete categories[duplicateId];
  }

  await addHistoryEntry({
    type: "material_category_merge",
    label: `${mergedCount} dubbele materiaalcategorie${mergedCount === 1 ? "" : "ën"} samengevoegd`,
    user,
    rowId: "",
    before: Object.keys(remap),
    after: remap,
    restorable: false,
  });

  return json({
    success: true,
    action: "deduplicate-custom-categories",
    mergedCount,
    customCategories: categories,
    materialProfiles: profiles,
    remap,
  });
}

async function loadCustomCategories() {
  const listing = await listBlobsResilient("material-categories/", "list material categories");
  const entries = (
    await Promise.all(
      listing.blobs.map((item) => getBlobResilient(item.key, "json"))
    )
  ).filter(Boolean);

  const result = {};
  for (const entry of entries) {
    const category = cleanCustomCategory(entry.category || entry);
    if (!category) continue;
    result[category.id] = category;
  }
  return result;
}

async function saveMaterialProfile(body, user) {
  const material = shortText(body.material, 180);
  if (!material) {
    return json({ success: false, error: "Materiaalnaam ontbreekt." }, 400);
  }

  const key = profileBlobKey(material);
  const existing = await getBlobResilient(key, "json").catch(() => null);

  // Contributors may create metadata for a genuinely new material, but they
  // cannot overwrite an existing shared profile.
  if (existing && user.role !== "admin") {
    return json(
      { success: false, error: "Alleen een Beheerder kan een bestaand materiaalprofiel wijzigen." },
      403
    );
  }

  const profile = cleanMaterialProfile(body.profile || {});
  const stored = {
    material,
    profile,
    updatedAt: new Date().toISOString(),
    updatedById: user.id,
    updatedByName: user.name,
  };

  await primaryStore().setJSON(key, stored);

  await addHistoryEntry({
    type: existing ? "material_profile_edit" : "material_profile_add",
    label: `${existing ? "Materiaalprofiel gewijzigd" : "Materiaalprofiel toegevoegd"}: ${material}`,
    user,
    rowId: "",
    before: existing?.profile || null,
    after: profile,
    restorable: false,
  });

  return json({
    success: true,
    action: "save-material-profile",
    material,
    profile,
  });
}

async function saveCustomCategory(body, user) {
  if (user.role !== "admin") {
    return json(
      { success: false, error: "Alleen een Beheerder kan materiaalcategorieën beheren." },
      403
    );
  }

  const category = cleanCustomCategory(body.category || {});
  if (!category) {
    return json({ success: false, error: "Ongeldige materiaalcategorie." }, 400);
  }

  // Uniqueness is based on translated labels, not on the random category ID.
  // If any NL/EN/FR/DE translation is already present, reuse that category.
  const categories = await loadCustomCategories();
  const duplicate = findExistingCategoryByTranslations(category, categories, category.id);

  if (duplicate) {
    if (categories[category.id]) {
      return json({
        success: false,
        error: "Deze vertaling hoort al bij een andere categorie. Gebruik Samenvoegen.",
      }, 409);
    }
    return json({
      success: true,
      action: "save-custom-category",
      category: duplicate,
      duplicate: true,
      mergedInto: duplicate.id,
    });
  }

  const key = categoryBlobKey(category.id);
  const existing = await getBlobResilient(key, "json").catch(() => null);

  await primaryStore().setJSON(key, {
    category,
    updatedAt: new Date().toISOString(),
    updatedById: user.id,
    updatedByName: user.name,
  });

  await addHistoryEntry({
    type: existing ? "material_category_edit" : "material_category_add",
    label: `${existing ? "Materiaalcategorie gewijzigd" : "Materiaalcategorie toegevoegd"}: ${category.translations.nl}`,
    user,
    rowId: "",
    before: existing?.category || null,
    after: category,
    restorable: false,
  });

  return json({
    success: true,
    action: "save-custom-category",
    category,
    duplicate: false,
  });
}


function mergeProfileTranslations(source = {}, target = {}, targetNames = null) {
  const result = {};
  for (const lang of PROFILE_LANGS) {
    const s = source?.[lang] || {};
    const t = target?.[lang] || {};
    result[lang] = {
      name: shortText(targetNames?.[lang] || t.name || s.name, 180),
      description: shortText(t.description || s.description, 3000),
      safetyText: shortText(t.safetyText || s.safetyText, 4000),
      notes: shortText(t.notes || s.notes, 4000),
    };
  }
  return result;
}

function mergeMaterialProfiles(source = {}, target = {}, targetNames = null) {
  const s = cleanMaterialProfile(source || {});
  const t = cleanMaterialProfile(target || {});
  const merged = { ...s, ...t };
  for (const key of ["categoryKey","category","manufacturer","supplier","internalCode","datasheetUrl","materialColor","transparency","suitability","defaultAirAssist","safetyLevel","visualMode","image","ralCode","ralHex","transparentTint","transparentOpacity"]) {
    merged[key] = t[key] || s[key] || "";
  }
  merged.suitability = t.suitability || s.suitability || "";
  merged.translations = mergeProfileTranslations(s.translations, t.translations, targetNames);
  return cleanMaterialProfile(merged);
}

async function renameOrMergeMaterial(body, user) {
  if (user.role !== "admin") return json({ success:false,error:"Alleen een Beheerder kan materialen hernoemen of samenvoegen." },403);
  const source = shortText(body.source, 180);
  const target = shortText(body.target, 180);
  const mode = body.mode === "merge" ? "merge" : "rename";
  if (!source || !target) return json({ success:false,error:"Bron- en doelmateriaal zijn verplicht." },400);
  if (source === target) return json({ success:false,error:"Bron- en doelmateriaal zijn gelijk." },400);

  const renames = await loadMaterialRenames();
  const resolvedSource = resolveMaterialRename(source, renames);
  const resolvedTarget = resolveMaterialRename(target, renames);
  if (resolvedSource === resolvedTarget) return json({ success:false,error:"Deze materialen zijn al samengevoegd." },400);

  // Prevent rename cycles.
  if (resolveMaterialRename(resolvedTarget, { ...renames, [resolvedSource]: resolvedTarget }) === resolvedSource) {
    return json({ success:false,error:"Deze hernoeming zou een kringverwijzing veroorzaken." },400);
  }

  const profiles = await loadMaterialProfiles();
  const sourceProfile = profiles[resolvedSource] || {};
  const targetProfile = profiles[resolvedTarget] || {};
  const targetNames = body.targetTranslations && typeof body.targetTranslations === "object" ? body.targetTranslations : null;
  const mergedProfile = mergeMaterialProfiles(sourceProfile, targetProfile, mode === "rename" ? targetNames : null);

  await primaryStore().setJSON(profileBlobKey(resolvedTarget), {
    material: resolvedTarget,
    profile: mergedProfile,
    updatedAt: new Date().toISOString(),
    updatedById: user.id,
    updatedByName: user.name,
  });
  if (resolvedSource !== resolvedTarget) await primaryStore().delete(profileBlobKey(resolvedSource));

  // Rewrite central custom/override rows so newly stored data is canonical too.
  const upsertListing = await listBlobsResilient("upserts/", "list upserts for material rename");
  let rewritten = 0;
  for (const entry of upsertListing.blobs) {
    const row = await getBlobResilient(entry.key, "json");
    if (!row) continue;
    const canonical = resolveMaterialRename(row.materiaal, renames);
    if (canonical !== resolvedSource) continue;
    await primaryStore().setJSON(entry.key, { ...row, materiaal: resolvedTarget, updatedAt:new Date().toISOString(), updatedById:user.id, updatedByName:user.name, updatedByEmail:user.email });
    rewritten += 1;
  }

  // Flatten existing aliases that pointed at the source and add the source mapping.
  const nextRenames = { ...renames, [resolvedSource]: resolvedTarget };
  for (const key of Object.keys(nextRenames)) {
    const resolved = resolveMaterialRename(nextRenames[key], nextRenames);
    if (resolved && resolved !== key) nextRenames[key] = resolved;
  }
  const savedRenames = await saveMaterialRenames(nextRenames, user);

  await addHistoryEntry({
    type: mode === "merge" ? "material_merge" : "material_rename",
    label: `${mode === "merge" ? "Materialen samengevoegd" : "Materiaal hernoemd"}: ${resolvedSource} → ${resolvedTarget}`,
    user,rowId:"",before:{source:resolvedSource},after:{target:resolvedTarget,rewritten},restorable:false,
  });

  return json({ success:true,action:"rename-material",mode,source:resolvedSource,target:resolvedTarget,rewritten,materialRenames:savedRenames,profile:mergedProfile });
}

async function mergeCustomCategory(body, user) {
  if (user.role !== "admin") return json({success:false,error:"Alleen een Beheerder kan categorieën samenvoegen."},403);
  const source=shortText(body.source,180),target=shortText(body.target,180);
  if (!source || !target || source===target) return json({success:false,error:"Ongeldige bron- of doelcategorie."},400);
  if (source.startsWith("builtin:")) return json({success:false,error:"Een ingebouwde categorie kan niet worden verwijderd."},400);
  const categories=await loadCustomCategories();
  if (!categories[source]) return json({success:false,error:"Broncategorie niet gevonden."},404);
  if (!target.startsWith("builtin:") && !categories[target]) return json({success:false,error:"Doelcategorie niet gevonden."},404);
  const profiles=await loadMaterialProfiles(); let changed=0;
  for (const [material,profile] of Object.entries(profiles)) {
    if (profile.categoryKey!==source) continue;
    const updated=cleanMaterialProfile({...profile,categoryKey:target,category:""});
    await primaryStore().setJSON(profileBlobKey(material),{material,profile:updated,updatedAt:new Date().toISOString(),updatedById:user.id,updatedByName:user.name}); changed += 1;
  }
  await primaryStore().delete(categoryBlobKey(source));
  await addHistoryEntry({type:"material_category_merge",label:`Materiaalcategorie samengevoegd: ${categories[source].translations.nl} → ${target}`,user,rowId:"",before:source,after:target,restorable:false});
  return json({success:true,action:"merge-custom-category",source,target,changed});
}

async function deleteCustomCategory(body,user){
  if(user.role!=="admin")return json({success:false,error:"Alleen een Beheerder kan categorieën verwijderen."},403);
  const id=shortText(body.id,180); if(!id||id.startsWith("builtin:"))return json({success:false,error:"Ongeldige of beschermde categorie."},400);
  const categories=await loadCustomCategories(); if(!categories[id])return json({success:false,error:"Categorie niet gevonden."},404);
  const profiles=await loadMaterialProfiles(); if(Object.values(profiles).some(p=>p.categoryKey===id))return json({success:false,error:"Deze categorie is nog in gebruik."},409);
  await primaryStore().delete(categoryBlobKey(id));
  await addHistoryEntry({type:"material_category_delete",label:`Materiaalcategorie verwijderd: ${categories[id].translations.nl}`,user,rowId:"",before:categories[id],after:null,restorable:false});
  return json({success:true,action:"delete-custom-category",id});
}

async function addLaserProfile(body,user){
  if(user.role!=="admin")return json({success:false,error:"Alleen een Beheerder kan laserprofielen beheren."},403);
  const watt=Math.round(Number(body.watt)*10)/10; if(!Number.isFinite(watt)||watt<1||watt>200)return json({success:false,error:"Laservermogen moet tussen 1 en 200 W liggen."},400);
  const profiles=await loadLaserProfiles(); if(profiles.includes(watt))return json({success:true,action:"add-laser-profile",laserProfiles:profiles,existing:true});
  const next=await saveLaserProfiles([...profiles,watt],user);
  await addHistoryEntry({type:"laser_profile_add",label:`Laserprofiel toegevoegd: ${watt} W`,user,rowId:"",before:null,after:watt,restorable:false});
  return json({success:true,action:"add-laser-profile",laserProfiles:next});
}

async function removeLaserProfile(body,user){
  if(user.role!=="admin")return json({success:false,error:"Alleen een Beheerder kan laserprofielen beheren."},403);
  const watt=Math.round(Number(body.watt)*10)/10; if(BUILTIN_LASER_PROFILES.includes(watt))return json({success:false,error:"Een ingebouwd laserprofiel kan niet worden verwijderd."},400);
  const patch=await loadCentralPatch(user); if(patch.rawUpserts.some(r=>Number(r.laserWatt)===watt))return json({success:false,error:"Dit laserprofiel wordt nog gebruikt door instellingen."},409);
  const profiles=await loadLaserProfiles(); const next=await saveLaserProfiles(profiles.filter(v=>Number(v)!==watt),user);
  await addHistoryEntry({type:"laser_profile_delete",label:`Laserprofiel verwijderd: ${watt} W`,user,rowId:"",before:watt,after:null,restorable:false});
  return json({success:true,action:"remove-laser-profile",laserProfiles:next});
}

function buildUserStats(users, rawRows, deletedIds, history) {
  const deleted = new Set(deletedIds || []);
  const stats = new Map();

  for (const account of users || []) {
    stats.set(account.id, {
      userId: account.id,
      name: account.name,
      email: account.email,
      role: account.role,
      activeAdded: 0,
      approved: 0,
      pending: 0,
      edits: 0,
      approvals: 0,
      rejections: 0,
      lastActivityAt: null,
    });
  }

  for (const raw of rawRows || []) {
    const row = storedRow(raw);
    if (!row?.createdById || deleted.has(row.id)) continue;
    const item = stats.get(row.createdById);
    if (!item) continue;
    item.activeAdded += 1;
    if (row.approvalStatus === "pending") item.pending += 1;
    else item.approved += 1;
  }

  for (const entry of history || []) {
    const item = stats.get(entry.userId);
    if (!item) continue;
    if (entry.type === "edit") item.edits += 1;
    if (entry.type === "approve") item.approvals += 1;
    if (entry.type === "reject") item.rejections += 1;

    if (
      entry.at &&
      (!item.lastActivityAt ||
        new Date(entry.at).getTime() > new Date(item.lastActivityAt).getTime())
    ) {
      item.lastActivityAt = entry.at;
    }
  }

  return [...stats.values()].sort((a, b) => {
    const aTime = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
    const bTime = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
    return bTime - aTime || a.name.localeCompare(b.name, "nl");
  });
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
    testedById: setting.tested ? user.id : "",
    testedByName: setting.tested ? user.name : "",
    testedByEmail: setting.tested ? user.email : "",
    testedAt: setting.tested ? (setting.testedAt || now) : "",
    approvalStatus,
    approvedById: user.role === "admin" ? user.id : "",
    approvedByName: user.role === "admin" ? user.name : "",
    approvedAt: user.role === "admin" ? now : "",
  };

  await primaryStore().setJSON(`upserts/${id}`, row);
  await primaryStore().delete(`deleted/${id}`);

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

  const existingStored = await primaryStore().get(`upserts/${id}`, {
    type: "json",
    consistency: "strong",
  });

  const suppliedBefore = body.before && typeof body.before === "object"
    ? { id, ...cleanSetting(body.before) }
    : null;

  const existing = storedRow(existingStored);
  const before = existing || suppliedBefore || { id };
  const now = new Date().toISOString();

  const existingTester = testerMetadata(existing || body.before || {});
  const wasTested = Boolean(existing?.tested ?? body.before?.tested);
  const tester =
    setting.tested
      ? (
          wasTested && (existingTester.testedById || existingTester.testedByEmail)
            ? existingTester
            : {
                testedById: user.id,
                testedByName: user.name,
                testedByEmail: user.email,
              }
        )
      : { testedById: "", testedByName: "", testedByEmail: "" };

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
    testedById: tester.testedById,
    testedByName: tester.testedByName,
    testedByEmail: tester.testedByEmail,
    testedAt: setting.tested ? (wasTested ? (existing?.testedAt || setting.testedAt || now) : now) : "",
    approvalStatus: existing?.approvalStatus || "approved",
    approvedById: existing?.approvedById || "",
    approvedByName: existing?.approvedByName || "",
    approvedAt: existing?.approvedAt || "",
  };

  await primaryStore().setJSON(`upserts/${id}`, row);
  await primaryStore().delete(`deleted/${id}`);

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
      await primaryStore().get(`upserts/${id}`, { type: "json", consistency: "strong" })
    );
    const before = existing || snapshots.get(id) || { id };

    await primaryStore().setJSON(`deleted/${id}`, {
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
    await primaryStore().get(`upserts/${id}`, { type: "json", consistency: "strong" })
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

  await primaryStore().setJSON(`upserts/${id}`, row);
  await primaryStore().delete(`deleted/${id}`);
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
    await primaryStore().get(`upserts/${id}`, { type: "json", consistency: "strong" })
  );
  if (!current) return json({ success: false, error: "Instelling niet gevonden." }, 404);

  const rejectedAt = new Date().toISOString();
  await primaryStore().setJSON(`deleted/${id}`, {
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

  const listing = await listBlobsResilient("history/", "list history for restore");
  const match = listing.blobs.find((item) => item.key.endsWith(historyId));
  if (!match) return json({ success: false, error: "Geschiedenisitem niet gevonden." }, 404);

  const entry = await getBlobResilient(match.key, "json");
  if (!entry?.restorable) {
    return json({ success: false, error: "Deze actie kan niet worden hersteld." }, 400);
  }

  if (entry.type === "add" && entry.after?.id) {
    await primaryStore().setJSON(`deleted/${entry.after.id}`, {
      id: entry.after.id,
      deletedAt: new Date().toISOString(),
      deletedById: user.id,
      deletedByName: user.name,
      reason: "history_restore",
    });
  } else if (["edit", "delete", "reject"].includes(entry.type) && entry.before?.id) {
    if (Object.keys(entry.before).length > 1) {
      await primaryStore().setJSON(`upserts/${entry.before.id}`, storedRow(entry.before));
    }
    await primaryStore().delete(`deleted/${entry.before.id}`);
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


function cleanImportedStoredRow(input = {}) {
  const id = shortText(input.id, 180);
  if (!validId(id)) return null;

  const setting = cleanSetting(input);
  const error = validateSetting(setting);
  if (error) return null;

  return storedRow({
    id,
    ...setting,
    createdById: shortText(input.createdById, 180),
    createdByName: shortText(input.createdByName, 220),
    createdByEmail: shortText(input.createdByEmail, 320),
    createdByRole: shortText(input.createdByRole, 30),
    createdAt: shortText(input.createdAt, 60),
    updatedById: shortText(input.updatedById, 180),
    updatedByName: shortText(input.updatedByName, 220),
    updatedByEmail: shortText(input.updatedByEmail, 320),
    updatedAt: shortText(input.updatedAt, 60),
    testedById: shortText(input.testedById, 180),
    testedByName: shortText(input.testedByName, 220),
    testedByEmail: shortText(input.testedByEmail, 320),
    approvalStatus: ["approved", "pending"].includes(String(input.approvalStatus || ""))
      ? String(input.approvalStatus)
      : "approved",
    approvedById: shortText(input.approvedById, 180),
    approvedByName: shortText(input.approvedByName, 220),
    approvedAt: shortText(input.approvedAt, 60),
  });
}

function cleanImportedHistoryEntry(input = {}, fallbackIndex = 0) {
  const originalId = shortText(input.id, 180);
  const id = validId(originalId)
    ? originalId
    : `h-migrated-${Date.now()}-${fallbackIndex}`;

  const rawAt = shortText(input.at, 60);
  const parsedAt = Date.parse(rawAt);
  const at = Number.isFinite(parsedAt)
    ? new Date(parsedAt).toISOString()
    : new Date().toISOString();

  const rowId = shortText(input.rowId, 180);

  return {
    id,
    type: shortText(input.type, 80) || "migration",
    label: shortText(input.label, 500) || "Gemigreerde geschiedenis",
    user: shortText(input.user, 220) || "Migratie",
    userId: shortText(input.userId, 180),
    userRole: shortText(input.userRole, 30),
    at,
    rowId: validId(rowId) ? rowId : "",
    before:
      input.before && typeof input.before === "object"
        ? input.before
        : null,
    after:
      input.after && typeof input.after === "object"
        ? input.after
        : null,
    restorable: Boolean(input.restorable),
  };
}

async function importCentralBackup(body, user) {
  if (user.role !== "admin") {
    return json(
      { success: false, error: "Alleen een Beheerder kan een centrale migratie uitvoeren." },
      403
    );
  }

  if (body.confirmation !== "MIGREER") {
    return json(
      { success: false, error: "Typ MIGREER om de centrale database te importeren." },
      400
    );
  }

  const backup = body.backup;
  if (
    !backup ||
    typeof backup !== "object" ||
    backup.backupType !== "central-database" ||
    !backup.central ||
    typeof backup.central !== "object"
  ) {
    return json(
      { success: false, error: "Dit is geen geldige centrale Laser Settings-back-up." },
      400
    );
  }

  const source = backup.central;
  const rawUpserts = Array.isArray(source.patch?.upserts) ? source.patch.upserts : [];
  const rawDeleted = Array.isArray(source.patch?.deleted) ? source.patch.deleted : [];
  const rawProfiles =
    source.materialProfiles && typeof source.materialProfiles === "object"
      ? source.materialProfiles
      : {};
  const rawCategories =
    source.customCategories && typeof source.customCategories === "object"
      ? source.customCategories
      : {};
  const rawHistory = Array.isArray(source.history) ? source.history : [];
  const rawRenames =
    source.materialRenames && typeof source.materialRenames === "object"
      ? source.materialRenames
      : {};
  const rawLaserProfiles = Array.isArray(source.laserProfiles)
    ? source.laserProfiles
    : BUILTIN_LASER_PROFILES;

  // Defensieve bovengrenzen voor een handmatige migratie.
  if (
    rawUpserts.length > 10000 ||
    rawDeleted.length > 10000 ||
    Object.keys(rawProfiles).length > 1500 ||
    Object.keys(rawCategories).length > 1500 ||
    rawHistory.length > 1000
  ) {
    return json(
      { success: false, error: "De back-up bevat onverwacht veel gegevens en is uit veiligheid geweigerd." },
      413
    );
  }

  const upserts = rawUpserts
    .map((row) => cleanImportedStoredRow(row))
    .filter(Boolean);

  const deleted = [...new Set(
    rawDeleted
      .map((id) => shortText(id, 180))
      .filter((id) => validId(id))
  )];

  const profiles = {};
  for (const [materialRaw, profileRaw] of Object.entries(rawProfiles)) {
    const material = shortText(materialRaw, 180);
    if (!material) continue;
    profiles[material] = cleanMaterialProfile(profileRaw || {});
  }

  const categories = {};
  for (const categoryRaw of Object.values(rawCategories)) {
    const category = cleanCustomCategory(categoryRaw || {});
    if (!category) continue;
    categories[category.id] = category;
  }

  const renames = cleanMaterialRenames(rawRenames);
  const laserProfiles = cleanLaserProfiles(rawLaserProfiles);
  const history = rawHistory.map(cleanImportedHistoryEntry);

  // Schrijfacties zijn idempotent: opnieuw uitvoeren overschrijft dezelfde
  // sleutels in plaats van duplicaten te maken.
  for (const row of upserts) {
    await primaryStore().setJSON(`upserts/${row.id}`, row);
  }

  for (const id of deleted) {
    await primaryStore().setJSON(`deleted/${id}`, {
      id,
      deletedAt: new Date().toISOString(),
      deletedById: user.id,
      deletedByName: user.name,
      reason: "database_migration",
    });
  }

  for (const [material, profile] of Object.entries(profiles)) {
    await primaryStore().setJSON(profileBlobKey(material), {
      material,
      profile,
      updatedAt: new Date().toISOString(),
      updatedById: user.id,
      updatedByName: user.name,
      migrated: true,
    });
  }

  for (const category of Object.values(categories)) {
    await primaryStore().setJSON(categoryBlobKey(category.id), {
      category,
      updatedAt: new Date().toISOString(),
      updatedById: user.id,
      updatedByName: user.name,
      migrated: true,
    });
  }

  await saveMaterialRenames(renames, user);
  await saveLaserProfiles(laserProfiles, user);

  for (let i = 0; i < history.length; i += 1) {
    const entry = history[i];
    const stamp = String(Date.parse(entry.at) || Date.now()).padStart(13, "0");
    await primaryStore().setJSON(`history/${stamp}-${entry.id}`, entry);
  }

  await addHistoryEntry({
    type: "database_migration",
    label: `Centrale database gemigreerd: ${upserts.length} wijzigingen, ${profiles ? Object.keys(profiles).length : 0} materiaalprofielen`,
    user,
    rowId: "",
    before: null,
    after: {
      sourceVersion: shortText(backup.version, 40),
      sourceApiVersion: backup.apiVersion ?? null,
      sourceExportedAt: shortText(backup.exportedAt, 60),
      upserts: upserts.length,
      deleted: deleted.length,
      materialProfiles: Object.keys(profiles).length,
      customCategories: Object.keys(categories).length,
      history: history.length,
      laserProfiles: laserProfiles.length,
    },
    restorable: false,
  });

  return json({
    success: true,
    action: "import-central-backup",
    imported: {
      upserts: upserts.length,
      deleted: deleted.length,
      materialProfiles: Object.keys(profiles).length,
      customCategories: Object.keys(categories).length,
      history: history.length,
      laserProfiles: laserProfiles.length,
    },
  });
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
    case "save-material-profile":
      return saveMaterialProfile(body, user);
    case "save-custom-category":
      return saveCustomCategory(body, user);
    case "deduplicate-custom-categories":
      return deduplicateCustomCategories(user);
    case "rename-material":
      return renameOrMergeMaterial(body, user);
    case "merge-custom-category":
      return mergeCustomCategory(body, user);
    case "delete-custom-category":
      return deleteCustomCategory(body, user);
    case "add-laser-profile":
      return addLaserProfile(body, user);
    case "remove-laser-profile":
      return removeLaserProfile(body, user);
    case "import-central-backup":
      return importCentralBackup(body, user);
    default:
      return json({ success: false, error: "Onbekende beheeractie." }, 400);
  }
}

export default async (request) => {
  try {
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);

    if (mutating && !requestSourceAllowed(request)) {
      return json({ success: false, error: "Aanvraagbron niet toegestaan." }, 403);
    }

    if (mutating && !requestBodyAllowed(request)) {
      return json({ success: false, error: "Aanvraag is te groot." }, 413);
    }

    const user = await authenticatedUser(request);
    if (!user) return json({ success: false, error: "Niet aangemeld." }, 401);

    const url = new URL(request.url);

    if (request.method === "GET") {
      const [patch, recentHistoryRaw, materialProfiles, customCategories, materialRenames, laserProfiles] = await Promise.all([
        loadCentralPatch(user),
        historyEntries(5),
        loadMaterialProfiles(),
        loadCustomCategories(),
        loadMaterialRenames(),
        loadLaserProfiles(),
      ]);
      const recentHistory = recentHistoryRaw.map(historySummary);

      const result = {
        success: true,
        version: 16,
        user: { id: user.id, name: user.name, role: user.role },
        patch: { upserts: patch.upserts, deleted: patch.deleted },
        materialProfiles,
        customCategories,
        materialRenames,
        laserProfiles,
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
        result.userStats = buildUserStats(
          userData.users,
          patch.rawUpserts,
          patch.deleted,
          history
        );
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
