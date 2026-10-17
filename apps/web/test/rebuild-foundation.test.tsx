// @vitest-environment jsdom
/**
 * 재구축 M0-05 기반 — 셸이 **실제로** 무엇에 연결돼 있는지 본다(F05-01~03).
 *
 * 기존 시험은 셸 부품을 따로 본다. app-shell.test 는 배열·순수 helper 만, pwa-shell.test 는 sw.ts 의
 * 문자열만 본다. 그래서 helper 를 둔 채 AppShell 이 nav 를 무조건 그리거나, Providers 에서 AuthGate 가
 * 빠지거나, navigation matcher 에서 API 제외만 빠져도(문자열은 helper 에 남는다) 아무것도 실패하지 않는다.
 * 여기서는 실제 모듈(Providers·Home·AppShell·RootLayout·sw.ts·Input/Chip/Tab)을 그대로 쓰고, 그 아래
 * 경계 — /me·대시보드 네트워크, sync 구현, Next 라우터·폰트 로더, serwist — 만 test double 로 바꾼다.
 *
 * verify 스크립트(0건 가드·D-D1 적용 확인)는 **원본 파일을 임시 트리의 scripts/ 에 복사해** 실제 CLI 로
 * 돌린다. 스크립트는 자기 위치(`scripts/..`)를 기준으로 읽으므로, 경로를 바꾸는 CLI 옵션이나 실제 트리의
 * dummy 파일 없이 합성 입력만 바꿔 RED/GREEN 을 본다.
 */
import "fake-indexeddb/auto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/",
  replace: vi.fn(),
  push: vi.fn(),
  me: vi.fn(),
  currentProgram: vi.fn(),
  dashboard: vi.fn(),
  foregroundSync: vi.fn(),
  serwists: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
}));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  const replacements: Partial<typeof actual.api> = {
    me: mocks.me,
    currentProgram: mocks.currentProgram,
    dashboard: mocks.dashboard,
  };
  for (const key of Object.keys(replacements)) {
    if (typeof actual.api[key as keyof typeof actual.api] !== "function")
      throw new Error(`probe target does not exist: ${key}`);
  }
  return { ...actual, api: { ...actual.api, ...replacements } };
});
vi.mock("../components/session/sync-coordinator", async () => {
  const actual = await vi.importActual<typeof import("../components/session/sync-coordinator")>(
    "../components/session/sync-coordinator",
  );
  if (typeof actual.useForegroundSync !== "function")
    throw new Error("probe target does not exist: useForegroundSync");
  return { ...actual, useForegroundSync: mocks.foregroundSync };
});
// next/font/local 은 Next 컴파일러가 바꿔 주는 호출이라 그 밖에서 부르면 던진다 — 클래스 이름만 대신 준다.
vi.mock("../app/fonts", () => ({ jetbrainsMono: { variable: "test-font-jetbrains-mono" } }));
// serwist 는 ServiceWorker 전역에서만 돈다. sw.ts 가 넘기는 옵션·matcher 를 그대로 받아 두기만 한다.
vi.mock("serwist", () => {
  const recorder = (kind: string) =>
    class {
      kind = kind;
      options: unknown;
      constructor(options: unknown) {
        this.options = options;
      }
    };
  return {
    Serwist: class {
      options: unknown;
      addEventListeners = vi.fn();
      constructor(options: unknown) {
        this.options = options;
        mocks.serwists.push(this);
      }
    },
    NetworkFirst: recorder("NetworkFirst"),
    CacheFirst: recorder("CacheFirst"),
    ExpirationPlugin: recorder("ExpirationPlugin"),
  };
});

import RootLayout from "../app/layout";
import Home from "../app/page";
import { Providers } from "../app/providers";
import { DashboardScreen } from "../components/dashboard/DashboardScreen";
import { AppShell } from "../components/navigation/app-shell";
import { Chip } from "../components/ui/Chip";
import { cn } from "../components/ui/cn";
import { Input } from "../components/ui/Input";
import { Tab, TabList } from "../components/ui/Tabs";
import { ApiError } from "../lib/api";

const WEB = path.resolve(import.meta.dirname, "..");
const ME = { id: "00000000-0000-4000-8000-0000000000aa" };

beforeEach(() => {
  mocks.pathname = "/";
  mocks.replace.mockReset();
  mocks.push.mockReset();
  mocks.me.mockReset();
  mocks.currentProgram.mockReset();
  mocks.dashboard.mockReset();
  mocks.foregroundSync.mockReset();
});
afterEach(() => cleanup());

function Probe({ seen }: { seen: QueryClient[] }) {
  seen.push(useQueryClient());
  return <p>보호 화면</p>;
}

describe("Providers — QueryClientProvider → AuthGate → AuthenticatedSync → children (F05-01)", () => {
  it("/me 통과 전에는 화면도 foreground sync 도 시작하지 않고, 통과 뒤 같은 QueryClient 아래에서 시작한다", async () => {
    let pass!: (profile: unknown) => void;
    mocks.me.mockReturnValue(
      new Promise((resolve) => {
        pass = resolve;
      }),
    );
    const seen: QueryClient[] = [];
    const view = render(
      <Providers>
        <Probe seen={seen} />
      </Providers>,
    );

    expect(screen.getByText("인증 상태를 확인하고 있어요.")).toBeTruthy();
    expect(screen.queryByText("보호 화면")).toBeNull();
    expect(mocks.foregroundSync).not.toHaveBeenCalled();
    expect(mocks.me).toHaveBeenCalledTimes(1);

    await act(async () => pass(ME));
    await screen.findByText("보호 화면");
    expect(mocks.foregroundSync).toHaveBeenCalled();
    // AuthGate 가 /me 를 넣은 캐시를 children 도 본다 = Provider 는 AuthGate 바깥에 하나뿐이다.
    expect(seen[0].getQueryData(["auth", "me"])).toBe(ME);
    expect(seen[0].getDefaultOptions().queries?.retry).toBe(1);

    view.rerender(
      <Providers>
        <Probe seen={seen} />
      </Providers>,
    );
    await screen.findByText("보호 화면");
    expect(new Set(seen).size).toBe(1);
  });

  it("/me 가 401 이면 /auth 로 보내고 화면·sync 를 시작하지 않는다", async () => {
    mocks.me.mockRejectedValue(new ApiError(401, "UNAUTHENTICATED", "로그인이 필요합니다."));
    render(
      <Providers>
        <p>보호 화면</p>
      </Providers>,
    );
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/auth"));
    expect(screen.queryByText("보호 화면")).toBeNull();
    expect(mocks.foregroundSync).not.toHaveBeenCalled();
  });
});

describe("Home — 보존 DashboardScreen 위임 (F05-01)", () => {
  it("홈은 DashboardScreen 그 자체를 props 없이 돌려준다(빈 홈·placeholder 가 아니다)", () => {
    const element = Home();
    expect(element.type).toBe(DashboardScreen);
    expect(element.props).toEqual({});
  });

  it("실제로 그리면 대시보드 진입점(프로그램·요약 조회)이 시작된다", async () => {
    mocks.currentProgram.mockReturnValue(new Promise(() => {}));
    mocks.dashboard.mockReturnValue(new Promise(() => {}));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Home />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "오늘" })).toBeTruthy();
    await waitFor(() => expect(mocks.currentProgram).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.dashboard).toHaveBeenCalledTimes(1));
    client.clear();
  });
});

describe("AppShell — 실제 렌더의 표시/숨김 경로와 #main (F05-01)", () => {
  const TABS = [
    ["오늘", "/"],
    ["기록", "/history"],
    ["프로그램", "/program"],
    ["내 정보", "/profile"],
  ] as const;

  it("공개 export 는 AppShell·appNavigation·shouldShowBottomNavigation 세 개다", async () => {
    const shell = await import("../components/navigation/app-shell");
    expect(Object.keys(shell).sort()).toEqual([
      "AppShell",
      "appNavigation",
      "shouldShowBottomNavigation",
    ]);
  });

  it.each(TABS.map(([, href]) => href))(
    "%s 에서는 4탭 nav 를 그리고 현재 탭에만 aria-current=page 를 단다",
    (pathname) => {
      mocks.pathname = pathname;
      render(
        <AppShell>
          <p>본문</p>
        </AppShell>,
      );
      const nav = screen.getByRole("navigation", { name: "주요 탐색" });
      expect(within(nav).getAllByRole("link")).toHaveLength(TABS.length);
      for (const [label, href] of TABS) {
        const link = within(nav).getByRole("link", { name: label });
        expect(link.getAttribute("href")).toBe(href);
        expect(link.getAttribute("aria-current")).toBe(href === pathname ? "page" : null);
      }
      const main = screen.getByRole("main");
      expect(main.id).toBe("main");
      expect(within(main).getByText("본문")).toBeTruthy();
      expect(main.className).toContain("pb-[calc(50px+env(safe-area-inset-bottom))]");
    },
  );

  it.each(["/onboarding", "/session/session-1", "/auth", "/auth/bootstrap"])(
    "%s 에서는 nav 를 숨기고 #main 만 남긴다",
    (pathname) => {
      mocks.pathname = pathname;
      render(
        <AppShell>
          <p>본문</p>
        </AppShell>,
      );
      expect(screen.queryByRole("navigation")).toBeNull();
      const main = screen.getByRole("main");
      expect(main.id).toBe("main");
      expect(within(main).getByText("본문")).toBeTruthy();
      expect(main.getAttribute("class")).toBeNull();
    },
  );
});

describe("RootLayout — 스킵 링크 → Providers → AppShell (F05-01, UX_STATES §7.1)", () => {
  it("html 에 폰트 변수를 붙이고 body 는 스킵 링크·Providers(AppShell(children)) 둘뿐이다", () => {
    const child = <p>본문</p>;
    const html = RootLayout({ children: child });
    expect(html.type).toBe("html");
    expect(html.props.lang).toBe("ko");
    expect(html.props.className).toBe("test-font-jetbrains-mono");
    const body = html.props.children;
    expect(body.type).toBe("body");
    const [skip, providers, ...rest] = body.props.children;
    expect(rest).toEqual([]);
    expect(skip.type).toBe("a");
    expect(skip.props.href).toBe("#main");
    expect(skip.props.children).toBe("본문 바로가기");
    expect(providers.type).toBe(Providers);
    expect(providers.props.children.type).toBe(AppShell);
    expect(providers.props.children.props.children).toBe(child);
  });

  it("스킵 링크가 가리키는 #main 은 AppShell 의 main 이고, 링크 뒤에 있으며 본문을 담는다", async () => {
    mocks.me.mockResolvedValue(ME);
    const [skip, providers] = RootLayout({ children: <p>본문</p> }).props.children.props.children;
    render(
      <>
        {skip}
        {providers}
      </>,
    );
    const link = screen.getByRole("link", { name: "본문 바로가기" });
    const main = await screen.findByRole("main");
    expect(document.querySelector(link.getAttribute("href") ?? "")).toBe(main);
    expect(link.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(main).getByText("본문")).toBeTruthy();
  });
});

describe("cn — 거짓 값 허용 시그니처와 ADR-53 사용자 정의 merge 그룹 (F05-01)", () => {
  it("false·null·undefined 는 버리고 같은 그룹은 뒤의 클래스만 남긴다", () => {
    expect(cn("px-3", false, null, undefined, "px-4")).toBe("px-4");
  });

  // 확장 그룹이 빠지면 결과가 달라지는 쌍만 골랐다 — 기본 tailwind-merge 는 둘 다 남기거나(모서리·그림자·
  // 간격·글자 크기) `text-kicker` 를 글자색으로 보고 앞의 색을 지운다.
  // 그림자 확장 클래스는 앱이 아직 쓰지 않는다. Tailwind 는 시험 파일 글자도 훑으므로 이름을 그대로 적으면
  // 배포 CSS 에 쓰이지 않는 규칙이 생긴다(실측) — 그 이름만 실행 중에 조립한다.
  const elevated = ["sha", "dow-card"].join("");
  const MERGES: [group: string, values: string[], merged: string][] = [
    ["모서리", ["rounded-control", "rounded-card"], "rounded-card"],
    ["그림자", [elevated, "shadow-none"], "shadow-none"],
    ["간격", ["min-h-tap", "min-h-tap-lg"], "min-h-tap-lg"],
    ["글자 크기", ["text-sm", "text-kicker"], "text-kicker"],
    ["글자 크기·색 분리", ["text-fg-muted", "text-kicker"], "text-fg-muted text-kicker"],
  ];
  it.each(MERGES)("%s 그룹: %j → %s", (_group, values, merged) => {
    expect(cn(...values)).toBe(merged);
  });
});

describe("D-D1 적용 — 실제 컨트롤이 border-control 을 쓴다 (F05-03)", () => {
  const classes = (element: HTMLElement) => element.className.split(/\s+/);

  it("경계 토큰은 확정값 #5d6875 이고 Tailwind 색으로 매핑돼 있다", () => {
    const css = fs
      .readFileSync(path.join(WEB, "app", "globals.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/--afc-border-control:\s*#5d6875;/i);
    expect(css).toMatch(/--color-border-control:\s*var\(--afc-border-control\);/);
  });

  it("입력칸은 평소 border-border-control, 오류일 때만 border-danger 다", () => {
    render(
      <>
        <Input id="m005-weight" label="무게 (kg)" unit="kg" />
        <Input id="m005-reps" label="횟수" invalid hint="횟수를 다시 입력해 주세요." />
      </>,
    );
    const normal = classes(screen.getByLabelText("무게 (kg)"));
    expect(normal).toContain("border");
    expect(normal).toContain("border-border-control");
    expect(normal).not.toContain("border-danger");
    const invalid = classes(screen.getByLabelText("횟수"));
    expect(invalid).toContain("border-danger");
    expect(invalid).not.toContain("border-border-control");
  });

  it("미선택 칩·탭은 border-border-control, 선택되면 border-action 이다", () => {
    render(
      <>
        <Chip>가슴</Chip>
        <Chip selected>등</Chip>
        <TabList label="부위">
          <Tab id="m005-tab-lower" panelId="m005-panel-lower" selected={false}>
            하체
          </Tab>
          <Tab id="m005-tab-upper" panelId="m005-panel-upper" selected>
            상체
          </Tab>
        </TabList>
      </>,
    );
    expect(classes(screen.getByRole("button", { name: "가슴" }))).toContain(
      "border-border-control",
    );
    const selectedChip = classes(screen.getByRole("button", { name: "등" }));
    expect(selectedChip).toContain("border-action");
    expect(selectedChip).not.toContain("border-border-control");
    expect(classes(screen.getByRole("tab", { name: "하체" }))).toContain("border-border-control");
    const selectedTab = classes(screen.getByRole("tab", { name: "상체" }));
    expect(selectedTab).toContain("border-action");
    expect(selectedTab).not.toContain("border-border-control");
  });
});

/* ==========================================================================
   verify 스크립트 — 원본을 임시 web 루트에 복사해 실제 CLI 로 돌린다
   ========================================================================== */

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

/** files 의 키가 `/` 로 끝나면 빈 디렉터리다. */
function runScript(script: string, files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afc-m005-"));
  temps.push(root);
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.join(WEB, "scripts", script), path.join(root, "scripts", script));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    if (rel.endsWith("/")) {
      fs.mkdirSync(full, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  const run = spawnSync(process.execPath, [path.join(root, "scripts", script)], {
    encoding: "utf8",
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

const without = (files: Record<string, string>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(files).filter(([key]) => !keys.includes(key)));

describe("verify-no-test-seed — 영역별 0건 가드 (F05-02)", () => {
  const TREE = {
    "app/page.tsx": "export default function Page() {\n  return null;\n}\n",
    "components/card.tsx": "export const Card = 1;\n",
    "lib/day.ts": "export const day = 1;\n",
    ".next/static/chunks/app.js": "console.log(1);\n",
    ".next/server/app/page.js": "module.exports = {};\n",
  };
  const seed = (files: Record<string, string>) => runScript("verify-no-test-seed.mjs", files);

  it("필수 소스·static·server 가 모두 있으면 통과하고, 없는 선택 영역은 없음으로 적는다", () => {
    const result = seed(TREE);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("테스트 시드 없음 — 5개 파일 검사");
    expect(result.output).toContain("hooks 없음(선택)");
    expect(result.output).toContain("store 없음(선택)");
  });

  it.each([
    ["필수 소스가 없다", without(TREE, "lib/day.ts"), "lib: 없다"],
    [
      "필수 소스에 검사 파일이 0개다",
      { ...without(TREE, "lib/day.ts"), "lib/README.md": "# lib\n" },
      "lib: 검사 대상 파일이 0개다",
    ],
    [
      "소스는 있는데 static 이 없다",
      without(TREE, ".next/static/chunks/app.js"),
      ".next/static: 없다",
    ],
    [
      "소스는 있는데 static 이 비었다(css 는 검사 대상이 아니다)",
      { ...without(TREE, ".next/static/chunks/app.js"), ".next/static/css/app.css": "a{}\n" },
      ".next/static: 검사 대상 파일이 0개다",
    ],
    [
      "소스는 있는데 server 가 없다",
      without(TREE, ".next/server/app/page.js"),
      ".next/server: 없다",
    ],
    [
      "소스는 있는데 server 가 비었다",
      { ...without(TREE, ".next/server/app/page.js"), ".next/server/": "" },
      ".next/server: 검사 대상 파일이 0개다",
    ],
    [
      "cache·test·e2e 파일은 static 0건을 메우지 못한다",
      {
        ...without(TREE, ".next/static/chunks/app.js"),
        ".next/static/": "",
        ".next/cache/webpack/chunk.js": "1\n",
        "test/a.test.ts": "1\n",
        "e2e/a.spec.ts": "1\n",
      },
      ".next/static: 검사 대상 파일이 0개다",
    ],
    [
      "선택 영역이 디렉터리가 아니면 없음으로 넘기지 않는다",
      { ...TREE, store: "not a directory\n" },
      "store: 읽지 못했다 — 디렉터리가 아니다",
    ],
  ])("%s → 실패", (_name, files, message) => {
    const result = seed(files);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(message);
  });

  it("선택 영역 hooks·store 가 비어 있으면 통과하고, 있으면 그 안까지 훑는다", () => {
    const empty = seed({ ...TREE, "hooks/": "", "store/": "" });
    expect(empty.status, empty.output).toBe(0);
    expect(empty.output).toContain("hooks 0 · store 0");
    const seeded = seed({ ...TREE, "hooks/use-today.ts": "process.env.AFC_TEST_TODAY;\n" });
    expect(seeded.status, seeded.output).toBe(1);
    expect(seeded.output).toMatch(/AFC_TEST_TODAY\s+←\s+hooks[\\/]use-today\.ts/);
  });

  it("앱 소스의 시드 참조는 실패하고, cache·test·e2e 의 같은 문자열은 배포 경로가 아니다", () => {
    const leaked = seed({
      ...TREE,
      "lib/day.ts": "export const day = process.env.AFC_TEST_TODAY;\n",
    });
    expect(leaked.status, leaked.output).toBe(1);
    expect(leaked.output).toMatch(/AFC_TEST_TODAY\s+←\s+lib[\\/]day\.ts/);
    const outside = seed({
      ...TREE,
      ".next/cache/webpack/chunk.js": "AFC_TEST_TODAY\n",
      "test/a.test.ts": "AFC_TEST_TODAY\n",
      "e2e/a.spec.ts": "AFC_TEST_TODAY\n",
    });
    expect(outside.status, outside.output).toBe(0);
  });

  it(".next 자체가 없으면 빌드부터 하라고 실패한다", () => {
    const result = seed(without(TREE, ".next/static/chunks/app.js", ".next/server/app/page.js"));
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(".next 가 없다");
  });
});

describe("verify-contrast — 비텍스트 3:1 과 빌드 CSS 적용 확인 (F05-03)", () => {
  const source = fs.readFileSync(path.join(WEB, "app", "globals.css"), "utf8");
  const control = /--afc-border-control:\s*([^;]+);/.exec(source.replace(/\/\*[\s\S]*?\*\//g, ""));
  const value = control?.[1].trim() ?? "";
  const ROOT = `:root,.theme-light{color-scheme:light;--afc-border-control:${value}}`;
  const RULE = ".border-border-control{border-color:var(--afc-border-control)}";
  const contrast = (globals: string, built: Record<string, string>) =>
    runScript("verify-contrast.mjs", { "app/globals.css": globals, ...built });
  const withToken = (name: string, hex: string) =>
    source.replace(new RegExp(`(${name}:\\s*)#[0-9a-f]{6}`, "i"), `$1${hex}`);

  it("실제 토큰이 텍스트·비텍스트를 통과하고 빌드 CSS 에 정의·적용 규칙이 있으면 통과한다", () => {
    const result = contrast(source, {
      // 실제 빌드처럼 @layer 안쪽에 있고, 다른 선택자와 묶여 있어도 찾는다.
      ".next/static/css/app.css": `@layer theme{${ROOT}}@layer utilities{.x,${RULE}}`,
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("비텍스트 통과 — border-border-control on bg-surface");
    expect(result.output).toContain("적용 확인 — 빌드 CSS 1개 파일");
  });

  it("경계를 장식 경계 값 #c9d0da 로 되돌리면 비텍스트 3:1 에서 실패한다", () => {
    const result = contrast(withToken("--afc-border-control", "#c9d0da"), {
      ".next/static/css/app.css": `${ROOT.replace(value, "#c9d0da")}${RULE}`,
    });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("비텍스트 대비 미달 2건");
  });

  it("success-bg 를 어둡게 하면 기존 텍스트 판정이 그대로 실패한다", () => {
    const result = contrast(withToken("--afc-success-bg", "#eef7f1"), {
      ".next/static/css/app.css": `${ROOT}${RULE}`,
    });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("text-success (#198146)  on  bg-success-bg (#eef7f1)");
  });

  it.each([
    ["빌드 CSS 가 없다", { ".next/static/chunks/app.js": "1\n" }, "빌드 CSS 가 없다"],
    [
      "적용 규칙이 없다",
      { ".next/static/css/app.css": ROOT },
      ".border-border-control { border-color: var(--afc-border-control) } 규칙이 없다",
    ],
    [
      "클래스가 다른 토큰을 칠한다",
      {
        ".next/static/css/app.css": `${ROOT}.border-border-control{border-color:var(--afc-border)}`,
      },
      ".border-border-control { border-color: var(--afc-border-control) } 규칙이 없다",
    ],
    [
      "빌드의 토큰 값이 소스와 다르다(낡은 빌드)",
      { ".next/static/css/app.css": `${ROOT.replace(value, "#c9d0da")}${RULE}` },
      "값이 소스(",
    ],
    [
      ":root 에 토큰 정의가 없다",
      { ".next/static/css/app.css": RULE },
      ":root 에 --afc-border-control 정의가 없다",
    ],
  ])("%s → 산술이 통과해도 실패한다", (_name, built, message) => {
    const result = contrast(source, built);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(message);
  });
});

/* ==========================================================================
   sw.ts — 맨 마지막에 둔다(전역 self·fetch·caches 를 바꾸고 afterAll 에서 되돌린다)
   ========================================================================== */

type MatchInput = {
  url: URL;
  sameOrigin: boolean;
  request: { method: string; mode: string; destination: string };
};
type Recorded = { kind: string; options: Record<string, unknown> };
type Route = { matcher: (input: MatchInput) => boolean; handler: Recorded };
type RecordedSerwist = {
  options: {
    precacheEntries: unknown;
    skipWaiting: boolean;
    clientsClaim: boolean;
    runtimeCaching: Route[];
  };
  addEventListeners: ReturnType<typeof vi.fn>;
};

describe("sw.ts — 실제 모듈이 serwist 에 넘기는 matcher·옵션 (F05-01)", () => {
  const ORIGIN = "https://afc.test";
  const manifest = [{ url: "/_next/static/chunks/app.js", revision: "r1" }];
  const listeners = new Map<string, (event: unknown) => void>();
  let serwist: RecordedSerwist;
  let routes: Route[];

  const request = (
    pathname: string,
    init: Partial<MatchInput["request"]> = {},
    sameOrigin = true,
  ): MatchInput => ({
    url: new URL(pathname, ORIGIN),
    sameOrigin,
    request: { method: "GET", mode: "navigate", destination: "document", ...init },
  });

  beforeAll(async () => {
    vi.stubGlobal("self", {
      __SW_MANIFEST: manifest,
      location: { origin: ORIGIN },
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      },
    });
    await import("../app/sw");
    serwist = mocks.serwists[0] as RecordedSerwist;
    routes = serwist.options.runtimeCaching;
  });
  afterAll(() => vi.unstubAllGlobals());

  it("serwist 를 한 번 만들고 precache·즉시 활성화 옵션과 경로 2개를 넘긴다", () => {
    expect(mocks.serwists).toHaveLength(1);
    expect(serwist.options.precacheEntries).toBe(manifest);
    expect(serwist.options.skipWaiting).toBe(true);
    expect(serwist.options.clientsClaim).toBe(true);
    expect(serwist.addEventListeners).toHaveBeenCalledTimes(1);
    expect(routes).toHaveLength(2);
  });

  it("문서 이동은 NetworkFirst(afc-pages-v1), 폰트는 CacheFirst(afc-fonts-v1·ignoreSearch·128개·1년)다", () => {
    const [pages, fonts] = routes;
    expect(pages.handler.kind).toBe("NetworkFirst");
    expect(pages.handler.options).toEqual({ cacheName: "afc-pages-v1" });
    expect(fonts.handler.kind).toBe("CacheFirst");
    expect(fonts.handler.options.cacheName).toBe("afc-fonts-v1");
    expect(fonts.handler.options.matchOptions).toEqual({ ignoreSearch: true });
    const plugins = fonts.handler.options.plugins as Recorded[];
    expect(plugins.map((plugin) => [plugin.kind, plugin.options])).toEqual([
      ["ExpirationPlugin", { maxEntries: 128, maxAgeSeconds: 365 * 24 * 60 * 60 }],
    ]);
  });

  it("같은 출처 GET 문서 이동은 navigation 경로가 잡는다", () => {
    for (const pathname of ["/", "/history", "/program?week=2", "/session/session-1"]) {
      expect(routes[0].matcher(request(pathname)), pathname).toBe(true);
    }
  });

  it("/v1/·/api/v1/ 는 문서 이동이어도 어느 경로도 잡지 않는다 — API 응답은 캐시하지 않는다", () => {
    for (const pathname of [
      "/v1/dashboard",
      "/v1/sync",
      "/api/v1/dashboard",
      "/api/v1/sessions/s",
    ]) {
      for (const shape of [{}, { mode: "cors", destination: "" }]) {
        routes.forEach((route, index) => {
          expect(route.matcher(request(pathname, shape)), `${index} ${pathname}`).toBe(false);
        });
      }
    }
  });

  it("다른 출처·GET 아님·문서 이동 아님은 navigation 경로가 잡지 않는다", () => {
    expect(routes[0].matcher(request("/history", {}, false))).toBe(false);
    expect(routes[0].matcher(request("/history", { method: "POST" }))).toBe(false);
    expect(routes[0].matcher(request("/history", { mode: "cors", destination: "" }))).toBe(false);
  });

  it("같은 출처 woff2 폰트만 폰트 경로가 잡는다(조회 문자열은 경로 판정에 들어가지 않는다)", () => {
    const font = (pathname: string, sameOrigin = true, destination = "font") =>
      request(pathname, { mode: "cors", destination }, sameOrigin);
    expect(routes[1].matcher(font("/_next/static/media/pretendard.subset.0.woff2"))).toBe(true);
    expect(routes[1].matcher(font("/_next/static/media/jetbrains.woff2?probe=1"))).toBe(true);
    expect(routes[0].matcher(font("/_next/static/media/pretendard.subset.0.woff2"))).toBe(false);
    expect(routes[1].matcher(font("/_next/static/media/legacy.woff"))).toBe(false);
    expect(routes[1].matcher(font("/_next/static/media/a.woff2", false))).toBe(false);
    expect(routes[1].matcher(font("/_next/static/media/a.woff2", true, "script"))).toBe(false);
  });

  it("활성화 때 일반 루트 문서 `/` 하나만 afc-pages-v1 에 데워 두고, 응답이 실패면 넣지 않는다", async () => {
    const activate = listeners.get("activate");
    expect(activate).toBeTypeOf("function");
    const put = vi.fn(async (_request: Request, _response: Response) => undefined);
    const open = vi.fn(async (_name: string) => ({ put }));
    const fetchMock = vi.fn(
      async (_request: Request) => new Response("<!doctype html>", { status: 200 }),
    );
    vi.stubGlobal("caches", { open });
    vi.stubGlobal("fetch", fetchMock);
    const activateOnce = async () => {
      let pending: Promise<unknown> | undefined;
      activate?.({
        waitUntil: (promise: Promise<unknown>) => {
          pending = promise;
        },
      });
      await pending;
    };

    await activateOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0].url).toBe(`${ORIGIN}/`);
    expect(open).toHaveBeenCalledWith("afc-pages-v1");
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0].url).toBe(`${ORIGIN}/`);

    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    await activateOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
  });
});
