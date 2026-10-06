import { test, expect } from "@playwright/test";

const apiURL = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3000";

async function apiHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${apiURL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

test.describe("smoke", () => {
  test.beforeAll(async () => {
    if (!(await apiHealthy())) {
      test.skip(true, `API not healthy at ${apiURL}/health — start dogfood or pnpm dev:api`);
    }
  });

  test("login page loads", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Sign in to your workspace")).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  });
});
