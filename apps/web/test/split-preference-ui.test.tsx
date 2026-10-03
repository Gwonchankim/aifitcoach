// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProfileScreen } from "../app/profile/ProfileScreen";
import { OnboardingWizard } from "../components/onboarding/OnboardingWizard";
import { INITIAL_DRAFT, saveDraft } from "../components/onboarding/draft";
import { SplitPreferenceFields } from "../components/onboarding/SplitPreferenceFields";

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  currentProgram: vi.fn(),
  updateProfile: vi.fn(),
  generateProgram: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: { ...actual.api, ...mocks } };
});
const profile = {
  id: "user",
  split_preference: "lower_priority",
  split_preference_supported: true,
};
function mount(component: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{component}</QueryClientProvider>);
  return client;
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  window.history.replaceState(null, "", "/onboarding#step-3");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  mocks.me.mockResolvedValue(profile);
  mocks.currentProgram.mockResolvedValue(null);
  mocks.updateProfile.mockImplementation(async (body) => ({ ...profile, ...body }));
  mocks.generateProgram.mockResolvedValue({ program_id: "new" });
});
afterEach(cleanup);

it("explains the five-day distribution before selecting a preference without changing radio names", () => {
  render(<SplitPreferenceFields value={null} onChange={vi.fn()} supported days={5} />);
  expect(
    screen.getByText(
      "균형 있게(기본)와 상체 우선은 상체 3일·하체 2일, 하체 우선은 상체 2일·하체 3일로 배치해요.",
    ),
  ).toBeDefined();
  for (const name of ["균형 있게", "상체 우선", "하체 우선", "선호 없음"]) {
    expect(screen.getByRole("radio", { name, exact: true })).toBeDefined();
  }
});

it("profile save and clear send only preference, exposing unsupported application without modifying the program", async () => {
  mocks.me.mockResolvedValue({ ...profile, split_preference_supported: false });
  mocks.updateProfile.mockImplementation(async (body) => ({
    ...profile,
    ...body,
    split_preference_supported: false,
  }));
  mount(<ProfileScreen />);
  fireEvent.click(await screen.findByRole("radio", { name: "상체 우선" }));
  fireEvent.click(screen.getByRole("button", { name: "선호 저장" }));
  await waitFor(() =>
    expect(mocks.updateProfile).toHaveBeenCalledWith({ split_preference: "upper_priority" }),
  );
  await screen.findByText(
    "선호를 저장했어요. 지금 계획 방식에서는 아직 적용되지 않고, 새 방식이 적용되는 계획부터 반영돼요.",
  );
  fireEvent.click(screen.getByRole("button", { name: "선호 지우기" }));
  await waitFor(() =>
    expect(mocks.updateProfile).toHaveBeenLastCalledWith({ split_preference: null }),
  );
  expect(mocks.generateProgram).not.toHaveBeenCalled();
});

it("offline profile controls cannot submit", async () => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  // Cached profile remains readable offline.
  const client = new QueryClient();
  client.setQueryData(["auth", "me"], profile);
  client.setQueryData(["program", "current"], null);
  render(
    <QueryClientProvider client={client}>
      <ProfileScreen />
    </QueryClientProvider>,
  );
  expect(
    ((await screen.findByRole("button", { name: "선호 저장" })) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect((screen.getByRole("button", { name: "선호 지우기" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it("a delayed profile cannot overwrite the onboarding choice already touched", async () => {
  let resolve!: (value: typeof profile) => void;
  mocks.me.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  mount(<OnboardingWizard />);
  fireEvent.click(await screen.findByRole("button", { name: "주 5일" }));
  fireEvent.click(screen.getByRole("radio", { name: "상체 우선" }));
  resolve(profile);
  await waitFor(() =>
    expect((screen.getByRole("radio", { name: "상체 우선" }) as HTMLInputElement).checked).toBe(
      true,
    ),
  );
  for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: "다음" }));
  fireEvent.click(screen.getByRole("button", { name: "계획 만들기" }));
  await waitFor(() => expect(mocks.generateProgram).toHaveBeenCalled());
  expect(mocks.updateProfile).toHaveBeenCalledWith({ split_preference: "upper_priority" });
  expect(mocks.generateProgram.mock.calls[0]![0].split_preference).toBe("upper_priority");
});

it("four-day saved priority is disabled and requires explicit balanced selection", async () => {
  mount(<OnboardingWizard />);
  fireEvent.click(await screen.findByRole("button", { name: "주 4일" }));
  await waitFor(() =>
    expect((screen.getByRole("radio", { name: "하체 우선" }) as HTMLInputElement).disabled).toBe(
      true,
    ),
  );
  expect(screen.getByText("주 4일은 상체 2일·하체 2일로 균형 있게 배치해요.")).toBeDefined();
  for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: "다음" }));
  expect((screen.getByRole("button", { name: "계획 만들기" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(mocks.generateProgram).not.toHaveBeenCalled();
});

it("failed explicit preference persistence prevents generation", async () => {
  mocks.me.mockResolvedValue({ ...profile, split_preference_supported: false });
  saveDraft({
    draft: { ...INITIAL_DRAFT, days_per_week: 5, split_preference: "upper_priority" },
    step: 0,
  });
  window.history.replaceState(null, "", "/onboarding#step-7");
  mocks.updateProfile.mockRejectedValue(new Error("save failed"));
  mount(<OnboardingWizard />);
  const submit = await screen.findByRole("button", { name: "계획 만들기" });
  await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(submit);
  await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalled());
  expect(mocks.generateProgram).not.toHaveBeenCalled();
});

it.each([false, true])(
  "cleared preference is persisted before generation and never becomes a null generate field (support=%s)",
  async (supported) => {
    mocks.me.mockResolvedValue({ ...profile, split_preference_supported: supported });
    saveDraft({ draft: { ...INITIAL_DRAFT, days_per_week: 5, split_preference: null }, step: 0 });
    window.history.replaceState(null, "", "/onboarding#step-7");
    mount(<OnboardingWizard />);
    const submit = await screen.findByRole("button", { name: "계획 만들기" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.generateProgram).toHaveBeenCalledTimes(1));
    expect(mocks.updateProfile).toHaveBeenCalledWith({ split_preference: null });
    expect(mocks.generateProgram.mock.calls[0]![0]).not.toHaveProperty("split_preference");
    expect(mocks.updateProfile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.generateProgram.mock.invocationCallOrder[0]!,
    );
  },
);

it("unsupported active bundle saves an explicit priority but omits it from generation", async () => {
  mocks.me.mockResolvedValue({ ...profile, split_preference_supported: false });
  saveDraft({
    draft: { ...INITIAL_DRAFT, days_per_week: 5, split_preference: "upper_priority" },
    step: 0,
  });
  window.history.replaceState(null, "", "/onboarding#step-7");
  mount(<OnboardingWizard />);
  const submit = await screen.findByRole("button", { name: "계획 만들기" });
  await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(submit);
  await waitFor(() => expect(mocks.generateProgram).toHaveBeenCalledTimes(1));
  expect(mocks.updateProfile).toHaveBeenCalledWith({ split_preference: "upper_priority" });
  expect(mocks.generateProgram.mock.calls[0]![0]).not.toHaveProperty("split_preference");
});

it("profile pending mutation disables both controls and cannot duplicate the request", async () => {
  let finish!: (value: typeof profile) => void;
  mocks.updateProfile.mockImplementation(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  mount(<ProfileScreen />);
  fireEvent.click(await screen.findByRole("radio", { name: "상체 우선" }));
  fireEvent.click(screen.getByRole("button", { name: "선호 저장" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "선호 지우기" }) as HTMLButtonElement).disabled,
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole("button", { name: "선호 저장" }));
  fireEvent.click(screen.getByRole("button", { name: "선호 지우기" }));
  expect(mocks.updateProfile).toHaveBeenCalledTimes(1);
  finish({ ...profile, split_preference: "upper_priority" });
  await screen.findByText("선호를 저장했어요. 새 계획을 만들 때 반영돼요.");
});

it("explicit balanced choice unlocks four-day generation without submitting the saved priority", async () => {
  mount(<OnboardingWizard />);
  fireEvent.click(await screen.findByRole("button", { name: "주 4일" }));
  await waitFor(() =>
    expect((screen.getByRole("radio", { name: "하체 우선" }) as HTMLInputElement).disabled).toBe(
      true,
    ),
  );
  fireEvent.click(screen.getByRole("radio", { name: "균형 있게" }));
  for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: "다음" }));
  fireEvent.click(screen.getByRole("button", { name: "계획 만들기" }));
  await waitFor(() => expect(mocks.generateProgram).toHaveBeenCalledTimes(1));
  expect(mocks.generateProgram.mock.calls[0]![0].split_preference).toBe("balanced");
});
