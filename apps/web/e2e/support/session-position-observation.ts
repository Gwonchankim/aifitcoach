import { expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { API_V1, WEB_ORIGIN } from "../helpers";

const ownedContexts = new WeakSet<BrowserContext>();
type Row = Record<string, unknown>;

/** No Prisma connection: the three URLs are an execution guard, not database credentials to log. */
export async function assertPositionRun(request: APIRequestContext) {
  const value = process.env.E2E_DATABASE_URL;
  const userId = process.env.E2E_DEV_USER_ID;
  if (!value || value !== process.env.DATABASE_URL || value !== process.env.DIRECT_URL)
    throw new Error("Position E2E requires three identical explicit owned database URLs.");
  const url = new URL(value);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !/^\/afc_(?:gen|eval)_s03_[a-zA-Z0-9_]+_e2e$/.test(url.pathname) ||
    !userId ||
    !/^[0-9a-f-]{36}$/i.test(userId)
  )
    throw new Error("Position E2E refuses an unowned database/identity.");
  const response = await request.get(`${API_V1}/me`);
  expect(response.status()).toBe(200);
  expect((await response.json()).id, "exact synthetic API principal").toBe(userId);
}

/** Call only for a newly created test context, never for a user's attached browser. */
export function ownPositionContext(context: BrowserContext) {
  ownedContexts.add(context);
}

export async function positionObservation(page: Page, sessionId: string) {
  if (!ownedContexts.has(page.context()) || new URL(page.url()).origin !== WEB_ORIGIN)
    throw new Error("Position observer requires the registered owned context and exact origin.");
  return page.evaluate(async (id) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid owned session identity.");
    const opening = indexedDB.open("afc-session-v1");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onupgradeneeded = () => {
        opening.transaction?.abort();
        reject(new Error("Observer must not create or upgrade IndexedDB."));
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      const stores = ["drafts", "outbox", "sessions", "routines", "syncMeta"];
      const tx = db.transaction(stores, "readonly");
      const committed = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error("Observation transaction aborted."));
        tx.onerror = () => reject(tx.error);
      });
      const values = await Promise.all(
        stores.map(
          (store) =>
            new Promise<Record<string, unknown>[]>((resolve, reject) => {
              const request = tx.objectStore(store).index("user_id").getAll("dev-user");
              request.onsuccess = () => resolve(request.result as Record<string, unknown>[]);
              request.onerror = () => reject(request.error);
            }),
        ),
      );
      await committed;
      const [allDrafts, outbox, sessions, routines, meta] = values;
      const belongs = (row: Record<string, unknown>) => row.session_id === id;
      const drafts = allDrafts
        .filter(belongs)
        .sort((a, b) => String(a.planned_set_id).localeCompare(String(b.planned_set_id)));
      const sessionMeta = meta.filter((row) => String(row.key).endsWith(`:${id}`));
      const parse = (prefix: string) => {
        const raw = sessionMeta.find((row) => row.key === `${prefix}${id}`);
        return raw ? (JSON.parse(String(raw.value)) as Record<string, unknown>) : null;
      };
      const cached = await caches.match(location.href, { cacheName: "afc-pages-v1" });
      const positionRecord = parse("session-position:");
      return {
        sessionId: id,
        drafts,
        outbox: outbox.filter(
          (row) =>
            row.entity_id === id || drafts.some((draft) => draft.client_id === row.client_id),
        ),
        sessions: sessions.filter(belongs),
        routines: routines.filter(belongs),
        meta: sessionMeta,
        positionRecord,
        position: (positionRecord?.position ?? null) as Record<string, unknown> | null,
        timer: parse("rest-timer:"),
        transactionCompleted: true,
        observedAt: Date.now(),
        visibility: document.visibilityState,
        focusedId: document.activeElement?.id ?? null,
        serviceWorker: navigator.serviceWorker.controller?.scriptURL ?? null,
        documentCached: cached?.ok === true,
      };
    } finally {
      db.close();
    }
  }, sessionId);
}

export type PositionObservation = Awaited<ReturnType<typeof positionObservation>>;

/** Exact persisted identity/actual comparison; elapsed observation time is deliberately separate. */
export function committedParity(value: PositionObservation) {
  return {
    drafts: value.drafts,
    position: value.position,
    timer: value.timer,
    outbox: value.outbox,
  };
}

export function draftFor(value: PositionObservation, plannedSetId: string): Row | undefined {
  return value.drafts.find((row) => row.planned_set_id === plannedSetId);
}

async function exactOwnedPath(value: string, directory: boolean) {
  if (!path.isAbsolute(value)) throw new Error("Owned path must be absolute.");
  const absolute = path.resolve(value);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
    throw new Error("Owned path type/link mismatch.");
  const resolved = await realpath(absolute);
  if (path.relative(absolute, resolved)) throw new Error("Owned path redirect refused.");
  return resolved;
}

async function allocatedProfileRoot(root: string, allocation: string) {
  if (
    !path.isAbsolute(allocation) ||
    path.resolve(allocation) !== path.join(root, "physical-root.json")
  )
    throw new Error("Allocation descriptor must be directly under the manifest root.");
  const descriptorPath = await exactOwnedPath(allocation, false);
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  const expectedKeys = ["epic", "manifestRoot", "physicalRoot", "token", "v"];
  if (
    !descriptor ||
    !isDeepStrictEqual(Object.keys(descriptor).sort(), expectedKeys) ||
    descriptor.v !== 1 ||
    descriptor.epic !== "94e4d6c6-1729-4f1a-8e1b-7baa84b487da" ||
    typeof descriptor.token !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(descriptor.token) ||
    typeof descriptor.manifestRoot !== "string" ||
    !path.isAbsolute(descriptor.manifestRoot) ||
    path.resolve(descriptor.manifestRoot) !== root ||
    typeof descriptor.physicalRoot !== "string" ||
    !path.isAbsolute(descriptor.physicalRoot)
  )
    throw new Error("Allocation descriptor identity mismatch.");
  const parent = path.resolve("C:/Users/amole/.traycer/p");
  const physical = path.resolve(descriptor.physicalRoot);
  if (path.dirname(physical) !== parent || !/^[0-9a-f]{8}$/.test(path.basename(physical)))
    throw new Error("Physical root allocation boundary mismatch.");
  await exactOwnedPath(parent, true);
  const resolved = await exactOwnedPath(physical, true);
  const marker = await exactOwnedPath(path.join(resolved, ".afc-position-root.json"), false);
  if (!isDeepStrictEqual(JSON.parse(await readFile(marker, "utf8")), descriptor))
    throw new Error("Physical root descriptor/marker mismatch.");
  return resolved;
}

export async function freshPositionProfile(outputRoot: string) {
  const root = await exactOwnedPath(outputRoot, true);
  const normalized = root.replaceAll("\\", "/");
  if (
    !/\/\.traycer\/evidence\/94e4d6c6-1729-4f1a-8e1b-7baa84b487da\/sprint-03-(?:generator|evaluator)\/.+\/(?:chromium|webkit)-owned-profiles$/.test(
      normalized,
    )
  )
    throw new Error("Persistent profile root must be the wrapper-owned Sprint03 output directory.");
  const allocation = process.env.AFC_POSITION_PROFILE_ALLOCATION;
  const profileRoot =
    allocation === undefined ? root : await allocatedProfileRoot(root, allocation);
  const verifyProfileRoot = async () => {
    await exactOwnedPath(root, true);
    const current = allocation === undefined ? root : await allocatedProfileRoot(root, allocation);
    if (current !== profileRoot)
      throw new Error("Physical allocation changed after profile creation.");
    return current;
  };
  const token = randomUUID();
  // Keep the browser's nested storage paths short; ownership still uses the full UUID token.
  const profile = await mkdtemp(path.join(profileRoot, "p-")); // fresh; no storageState or profile copy
  const manifestPath = path.join(root, `profile-${token}.json`);
  const launches: { pid: number; startedAt: string; committedAt?: string; closedAt?: string }[] =
    [];
  const manifest = {
    token,
    profile,
    origin: WEB_ORIGIN,
    createdAt: new Date().toISOString(),
    launches,
  };
  await writeFile(path.join(profile, "position-owner.json"), JSON.stringify(manifest));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return {
    profile,
    manifestPath,
    async inventory(signal: AbortSignal) {
      const resolvedRoot = await verifyProfileRoot();
      if ((await lstat(profile)).isSymbolicLink()) throw new Error("Profile link refused.");
      const resolved = await realpath(profile);
      if (path.dirname(resolved) !== resolvedRoot)
        throw new Error("Profile inventory parent mismatch.");
      const marker = path.join(resolved, "position-owner.json");
      if ((await lstat(marker)).isSymbolicLink()) throw new Error("Owner marker link refused.");
      if (path.relative(marker, await realpath(marker)))
        throw new Error("Owner marker redirected.");
      const owner = JSON.parse(await readFile(marker, "utf8"));
      if (owner.token !== token || owner.profile !== profile)
        throw new Error("Profile inventory owner mismatch.");
      const entries: {
        path: string;
        pathLength: number;
        kind?: string;
        size?: number;
        error?: string;
      }[] = [];
      const walk = async (candidate: string, selectStorage = false): Promise<void> => {
        if (signal.aborted || entries.length >= 2_000) return;
        const entry: (typeof entries)[number] = { path: candidate, pathLength: candidate.length };
        entries.push(entry);
        try {
          const stat = await lstat(candidate);
          if (stat.isSymbolicLink()) {
            entry.kind = "link-not-followed";
            return;
          }
          if (path.relative(candidate, await realpath(candidate))) {
            entry.kind = "redirect-not-followed";
            return;
          }
          entry.kind = stat.isDirectory() ? "directory" : "file";
          if (stat.isFile()) entry.size = stat.size;
          if (!stat.isDirectory() || signal.aborted) return;
          for (const name of await readdir(candidate)) {
            if (!selectStorage || /^(?:Service Worker|IndexedDB|.*Cache.*|.*Storage.*)$/.test(name))
              await walk(path.join(candidate, name));
          }
        } catch (error) {
          entry.error = (error as NodeJS.ErrnoException).code ?? String(error);
        }
      };
      // Only directory metadata and file sizes; the sole content read is our ownership marker.
      await walk(path.join(resolved, "Default"), true);
      return {
        profile: resolved,
        profileLength: resolved.length,
        entries,
        truncated: signal.aborted || entries.length >= 2_000,
      };
    },
    async recordProcess(pid: number, event: "launch" | "commit-observed" | "closed") {
      if (event === "launch") launches.push({ pid, startedAt: new Date().toISOString() });
      else {
        const launch = launches.find((item) => item.pid === pid);
        if (!launch) throw new Error("Profile process was not created by this test.");
        if (event === "closed") launch.closedAt = new Date().toISOString();
        else launch.committedAt = new Date().toISOString();
      }
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    },
    async clean() {
      const resolvedRoot = await verifyProfileRoot();
      const resolved = await exactOwnedPath(profile, true);
      const marker = await exactOwnedPath(path.join(resolved, "position-owner.json"), false);
      const owner = JSON.parse(await readFile(marker, "utf8"));
      if (
        path.dirname(resolved) !== resolvedRoot ||
        !/^p-[a-zA-Z0-9]{6}$/.test(path.basename(resolved)) ||
        owner.token !== token ||
        owner.profile !== profile ||
        launches.some((item) => !item.closedAt)
      )
        throw new Error("Owned profile cleanup boundary mismatch.");
      await rm(resolved, { recursive: true });
      await writeFile(
        manifestPath,
        JSON.stringify({ ...manifest, removedAt: new Date().toISOString() }, null, 2),
      );
    },
  };
}
