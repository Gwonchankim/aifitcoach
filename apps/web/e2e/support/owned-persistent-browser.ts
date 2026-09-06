import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type TestInfo,
} from "@playwright/test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import type { freshPositionProfile } from "./session-position-observation";

type OwnedProfile = Awaited<ReturnType<typeof freshPositionProfile>>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Pinned to the headed persistent05 argv, not the separate runner headless browser.
// Only pipe -> loopback ephemeral port/address changes; the profile remains the validated child.
const flags = [
  "--disable-field-trial-config",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-back-forward-cache",
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",
  "--disable-component-extensions-with-background-pages",
  "--disable-component-update",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-edgeupdater",
  "--disable-extensions",
  "--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion",
  "--enable-features=CDPScreenshotNewSurface",
  "--allow-pre-commit-input",
  "--disable-hang-monitor",
  "--disable-ipc-flooding-protection",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--disable-updater-scheduler",
  "--force-color-profile=srgb",
  "--metrics-recording-only",
  "--no-first-run",
  "--password-store=basic",
  "--use-mock-keychain",
  "--no-service-autorun",
  "--export-tagged-pdf",
  "--disable-search-engine-choice-screen",
  "--unsafely-disable-devtools-self-xss-warnings",
  "--edge-skip-compat-layer-relaunch",
  "--disable-infobars",
  "--disable-search-engine-choice-screen",
  "--disable-sync",
  "--enable-unsafe-swiftshader",
  "--no-sandbox",
  "--enable-logging=stderr",
  "--vmodule=cache_storage*=1",
];

async function ownedFile(file: string) {
  const stat = await lstat(file);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size > 1_048_576 ||
    path.relative(file, await realpath(file))
  )
    throw new Error("Owned browser metadata link/type/size/redirect mismatch.");
  return readFile(file, "utf8");
}

/** Only Chrome's two-line child-owned discovery file is accepted; no supplied host or URL. */
export function ownedEndpoint(contents: string) {
  const lines = contents.trimEnd().split(/\r?\n/);
  if (
    lines.length !== 2 ||
    !/^[1-9][0-9]{0,4}$/.test(lines[0]) ||
    Number(lines[0]) > 65_535 ||
    !lines[1].startsWith("/devtools/browser/") ||
    !uuid.test(lines[1].slice("/devtools/browser/".length))
  )
    throw new Error("Invalid child DevToolsActivePort metadata.");
  return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
}

async function bounded<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owned browser lifecycle deadline exceeded.")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function launchOwnedPersistentBrowser(profile: OwnedProfile, info: TestInfo) {
  // Reuse the existing profile allocator's root, realpath and full-token validation unchanged.
  const inventory = await profile.inventory(new AbortController().signal);
  if (
    inventory.profile !== profile.profile ||
    path.dirname(path.dirname(profile.profile)) !== path.resolve("C:/Users/amole/.traycer/p") ||
    !/^[0-9a-f]{8}$/.test(path.basename(path.dirname(profile.profile))) ||
    !/^p-[a-zA-Z0-9]{6}$/.test(path.basename(profile.profile))
  )
    throw new Error("Owned browser requires the verified short physical profile allocation.");
  const owner = JSON.parse(await ownedFile(path.join(profile.profile, "position-owner.json")));
  const manifest = JSON.parse(await ownedFile(profile.manifestPath));
  if (
    !uuid.test(owner.token) ||
    owner.token !== manifest.token ||
    owner.profile !== profile.profile ||
    manifest.profile !== profile.profile ||
    owner.origin !== manifest.origin ||
    path.dirname(profile.manifestPath) !==
      path.resolve(process.env.AFC_POSITION_PROFILE_ROOT ?? "") ||
    path.basename(profile.manifestPath) !== `profile-${owner.token}.json` ||
    !Array.isArray(manifest.launches) ||
    manifest.launches.some((item: { closedAt?: string }) => !item.closedAt)
  )
    throw new Error("Owned browser manifest identity or previous process closure mismatch.");
  const activePort = path.join(profile.profile, "DevToolsActivePort");
  try {
    await ownedFile(activePort);
    await unlink(activePort); // Only stale discovery metadata after the previous exact child exited.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const run = randomUUID();
  const stdoutPath = info.outputPath(`owned-browser-${run}.stdout.log`);
  const stderrPath = info.outputPath(`owned-browser-${run}.stderr.log`);
  const executable = chromium.executablePath();
  const argv = [
    ...flags,
    `--user-data-dir=${profile.profile}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "about:blank",
  ];
  const stdoutFd = openSync(stdoutPath, "wx");
  let child: ReturnType<typeof spawn>;
  try {
    const stderrFd = openSync(stderrPath, "wx");
    try {
      child = spawn(executable, argv, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
    } finally {
      closeSync(stderrFd);
    }
  } finally {
    closeSync(stdoutFd);
  }
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: unknown;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      resolve();
    });
    child.once("error", (error) => {
      spawnError = error;
      if (!child.pid) resolve();
    });
  });
  const pid = child.pid;
  let browser: Browser | undefined;
  let cdp: CDPSession | undefined;
  let context: BrowserContext | undefined;
  let trustedConnection = false;
  let traceStarted = false;
  let forced = false;
  let closeCommandError: string | undefined;
  const issues: string[] = [];
  const safeError = (error: unknown) =>
    String(error).replace(/(?:https?|wss?):\/\/\S+/g, "[redacted-url]");
  const captureIssue = async (operation: () => Promise<unknown>, budget = 2_000) => {
    try {
      await bounded(operation(), budget);
    } catch (error) {
      issues.push(safeError(error));
    }
  };
  let closing: Promise<void> | undefined;
  const close = (failureCleanup = false) => {
    closing ??= (async () => {
      if (traceStarted && context) {
        const tracePath = info.outputPath(`owned-browser-${run}.trace.zip`);
        await captureIssue(async () => {
          await context!.tracing.stopChunk({ path: tracePath });
          await info.attach(`owned-browser-${run}-trace`, {
            path: tracePath,
            contentType: "application/zip",
          });
        }, 10_000);
      }
      // A mismatched endpoint must never receive Browser.close; only our spawned child may be killed.
      if (!exit && trustedConnection && cdp) {
        try {
          await bounded(cdp.send("Browser.close"), 2_000);
        } catch (error) {
          closeCommandError = safeError(error);
        }
      }
      if (!exit && pid) {
        try {
          await bounded(exited, 5_000);
        } catch {
          /* The exact owned child may need termination. */
        }
        if (!exit) {
          forced = true;
          try {
            child.kill();
          } catch (error) {
            issues.push(safeError(error));
          }
          try {
            await bounded(exited, 5_000);
          } catch {
            issues.push("Owned child exit remains unconfirmed.");
          }
        }
      }
      if (browser) await captureIssue(() => browser!.close()); // Disconnect after actual child exit.
      if (exit && pid) await profile.recordProcess(pid, "closed");
      await captureIssue(() =>
        info.attach(`owned-browser-${run}-lifecycle`, {
          body: Buffer.from(
            JSON.stringify(
              {
                pid,
                executable,
                argv,
                profile: profile.profile,
                noDefaults: true,
                trustedConnection,
                forced,
                closeCommandError,
                exit,
                issues,
                stdoutPath,
                stderrPath,
                traceStarted,
              },
              null,
              2,
            ),
          ),
          contentType: "application/json",
        }),
      );
      if (pid && !exit) throw new Error("Owned child did not exit; profile cleanup is forbidden.");
      if (!failureCleanup && (forced || issues.length || exit?.code !== 0))
        throw new Error(
          "Owned browser required forced or incomplete cleanup; see lifecycle evidence.",
        );
    })();
    return closing;
  };
  try {
    if (!pid) throw new Error("Owned browser spawn did not produce a PID.");
    await profile.recordProcess(pid, "launch");
    const deadline = Date.now() + 10_000;
    let endpoint: string | undefined;
    while (!endpoint) {
      if (spawnError || exit) throw new Error("Owned browser exited before CDP discovery.");
      try {
        endpoint = ownedEndpoint(await ownedFile(activePort));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!endpoint) {
        if (Date.now() >= deadline) throw new Error("Owned CDP discovery deadline exceeded.");
        await delay(50);
      }
    }
    browser = await chromium.connectOverCDP(endpoint, {
      noDefaults: true,
      isLocal: true,
      timeout: 10_000,
    });
    cdp = await browser.newBrowserCDPSession();
    const processes = await cdp.send("SystemInfo.getProcessInfo");
    if (processes.processInfo.find((item) => item.type === "browser")?.id !== pid)
      throw new Error("Connected browser PID does not match the owned child.");
    trustedConnection = true;
    if (browser.contexts().length !== 1)
      throw new Error("Owned browser must have exactly one default persistent context.");
    context = browser.contexts()[0];
    // The test runner starts tracing on connectOverCDP's default-context hook. Preserve that bootstrap,
    // then explicitly name/export our process chunk before Browser.close destroys the connection.
    const bootstrap = info.outputPath(`owned-browser-${run}.bootstrap.zip`);
    await context.tracing.stopChunk({ path: bootstrap });
    await info.attach(`owned-browser-${run}-bootstrap`, {
      path: bootstrap,
      contentType: "application/zip",
    });
    await context.tracing.startChunk({ title: `owned persistent PID ${pid}` });
    traceStarted = true;
    return { context, pid, close, hasExited: () => exit !== undefined };
  } catch (error) {
    await close(true).catch((cleanupError: unknown) => console.warn(safeError(cleanupError)));
    throw error;
  }
}
